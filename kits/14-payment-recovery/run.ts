/**
 * Kit 14 — Failed-Payment Recovery (Revenue Protection)
 *
 * Goal: collect November's subscription renewals without retrying the wrong
 * declines, charging anyone twice, or cutting off a paying customer early.
 *  1. Day 0: one payment intent per invoice, charged live. Four of five fail,
 *     each with a different issuer response (51, 54, 05, risk).
 *  2. Plan in code from the response code: retry after payday, ask for a new
 *     card, retry once, or pause and review.
 *  3. New information over the following days: a customer updates an expired
 *     card; a retry declines again; a blocked customer emails another card
 *     number and asks for more retries (refused: card data never comes by email).
 *  4. Every retry confirms the same intent, so each invoice can only be paid
 *     once. Access follows the grace period; a person approves the fraud pause.
 *
 * Days are simulated so the run takes a minute; every charge and decline is a
 * live Airwallex payment attempt.
 */
import { newRequestId } from "../../src/core/client.ts";
import { RailsClient } from "../../src/core/rails.ts";
import { AwxError } from "../../src/core/client.ts";
import { say, usd } from "../../src/core/narrate.ts";
import { explain } from "../../src/core/llm.ts";
import { screenUntrusted } from "../../src/core/untrusted.ts";
import { requestApproval, assertApproved, type Terms } from "../../src/core/approval.ts";
import { audit, auditPath } from "../../src/core/audit.ts";
import { accessOn, classify, nextStep, POLICY, type DeclineClass, type History } from "./policy.ts";
import { KAI_EMAIL, SUBSCRIBERS, type Subscriber } from "./fixtures.ts";

const awx = new RailsClient();
const month = "2026-11";
const state = new Map<string, { sub: Subscriber; intent: string; history: History; paid: boolean; attempts: string[]; card: string }>();

/** Charge (or re-charge) the invoice's one payment intent. Returns null on success, or the decline. */
async function charge(id: string, day: number, cardNumber?: string) {
  const s = state.get(id)!;
  const card = cardNumber ?? s.card;
  try {
    await awx.post(`/pa/payment_intents/${s.intent}/confirm`, {
      request_id: newRequestId(),
      payment_method: { type: "card", card: { number: card, expiry_month: "12", expiry_year: "2030", cvc: "123", name: s.sub.name } },
      payment_method_options: { card: { auto_capture: true } },
    });
    s.paid = true;
    s.attempts.push(`day ${day}: paid •••• ${card.slice(-4)}`);
    return null;
  } catch (err) {
    if (!(err instanceof AwxError)) throw err;
    // Read the intent back: the decline is only real if the intent is still unpaid.
    const pi = await awx.get(`/pa/payment_intents/${s.intent}`);
    if (pi.status === "SUCCEEDED") { s.paid = true; s.attempts.push(`day ${day}: paid (confirmed on read-back)`); return null; }
    const responseCode = (err.details as any)?.original_response_code ?? pi.latest_payment_attempt?.provider_original_response_code;
    const message = (err.details as any)?.original_response_message ?? err.message.replace(/^\d+ [\w_]+: /, "").replace(/ \(\/.*$/, "").trim();
    const cls: DeclineClass = classify({ code: err.code, responseCode });
    s.history.declines.push({ day, class: cls, responseCode });
    s.attempts.push(`day ${day}: ${responseCode ?? err.code} ${message ?? ""} •••• ${card.slice(-4)}`.trim());
    return { code: err.code, responseCode, message, cls };
  }
}

function plan(day: number) {
  const rows = [];
  for (const s of state.values()) {
    if (s.paid) continue;
    const step = nextStep(s.history);
    rows.push({ invoice: `${s.sub.id}-${month}`, customer: s.sub.name, amount: s.sub.amount, last: s.history.declines.at(-1)?.responseCode ?? s.history.declines.at(-1)?.class, class: s.history.declines.at(-1)?.class, next: step.action, on_day: step.onDay ?? "", access: accessOn(s.history, day) ? "on" : "paused" });
  }
  say.table(rows);
}

say.title("Kit 14 · Failed-Payment Recovery — November subscription renewals");
say.beat("goal", "Collect every renewal you can: retry only what's worth retrying, never charge twice, and keep paying customers' access on.");
say.table(SUBSCRIBERS.map((s) => ({ subscriber: s.id, customer: s.name, plan: s.plan, amount: s.amount, card: `•••• ${s.card.slice(-4)}` })));

say.beat("charge", "Day 0: one payment intent per invoice, charged live.");
for (const sub of SUBSCRIBERS) {
  const pi = await awx.post("/pa/payment_intents/create", { request_id: newRequestId(), amount: sub.amount, currency: "USD", merchant_order_id: `${sub.id}-${month}`, descriptor: "TRAILHEAD BOX" });
  state.set(sub.id, { sub, intent: pi.id, history: { declines: [] }, paid: false, attempts: [], card: sub.card });
  const d = await charge(sub.id, 0);
  if (d) say.warn(`${sub.name}: declined · ${d.code}${d.responseCode ? ` ${d.responseCode} (${d.message})` : ""} → ${d.cls}`);
  else say.ok(`${sub.name}: ${usd(sub.amount)} paid`);
}

say.beat("plan", "Decide per invoice from the issuer's response code, in code.");
plan(0);
for (const s of state.values()) {
  if (s.paid) continue;
  const step = nextStep(s.history);
  say.decision(s.sub.name, step.action, step.reason);
}

say.beat("new information", "Day 1: the scheduled retry for the 'do not honour' decline.");
const tom = "SUB-204";
const t1 = await charge(tom, 1);
say[t1 ? "warn" : "ok"](`Tom Ellery retry: ${t1 ? `declined again (${t1.responseCode})` : "paid"}`);
const tomStep = nextStep(state.get(tom)!.history);
say.decision("Tom Ellery", tomStep.action, tomStep.reason);

say.beat("new information", "Day 2: Priya updates her expired card in the customer portal. Kai emails.");
const priya = state.get("SUB-203")!;
priya.history.cardUpdatedOnDay = 2;
priya.card = priya.sub.newCard!;
const pStep = nextStep(priya.history);
say.decision("Priya Raman", pStep.action, pStep.reason);
const p = await charge("SUB-203", 2);
say[p ? "warn" : "ok"](`Priya Raman: ${p ? "declined" : `${usd(priya.sub.amount)} paid on the same invoice with the updated card`}`);

say.document(KAI_EMAIL);
const findings = screenUntrusted(KAI_EMAIL);
const cardInEmail = /\b(?:\d[ -]?){13,19}\b/.test(KAI_EMAIL);
for (const f of findings) say.warn(`untrusted instruction ignored: "${f.phrase}" (${f.why})`);
if (cardInEmail) say.warn("the email contains a card number: it is not used, and the customer is told never to send card details by email");
audit({ kind: "untrusted_email", subscriber: "SUB-205", findings: findings.map((f) => f.why), cardNumberInEmail: cardInEmail });
const kai = state.get("SUB-205")!;
const kStep = nextStep(kai.history);
say.decision("Kai Moreno", kStep.action, `${kStep.reason}. Retrying a risk-blocked card, or charging a card number sent by email, is how card testing works; neither happens.`);
const pauseTerms: Terms = { action: "PAUSE_AND_REVIEW", amount: kai.sub.amount, currency: "USD", counterparty: kai.sub.name, subscriber: kai.sub.id, reason: "risk_declined; card number offered by email", invoice: `${kai.sub.id}-${month}` };
const pauseOk = await requestApproval(pauseTerms, `Pause ${kai.sub.name}'s subscription and open a fraud review? (no retries; verify by phone before any new card is accepted)`);
if (pauseOk) {
  assertApproved(pauseTerms, pauseOk);
  say.ok(`${kai.sub.name}: access paused, fraud review opened, invoice left unpaid (no further attempts)`);
}

say.beat("new information", "Day 3 and 4: the payday retry, then Leo updates his card.");
const leo = state.get("SUB-202")!;
const l1 = await charge("SUB-202", 3);
say[l1 ? "warn" : "ok"](`Leo Brandt retry on day 3: ${l1 ? `declined again (${l1.responseCode})` : "paid"}`);
let lStep = nextStep(leo.history);
say.decision("Leo Brandt", lStep.action, lStep.reason);
leo.history.cardUpdatedOnDay = 4;
leo.card = leo.sub.newCard!;
lStep = nextStep(leo.history);
say.decision("Leo Brandt", lStep.action, lStep.reason);
const l2 = await charge("SUB-202", 4);
say[l2 ? "warn" : "ok"](`Leo Brandt: ${l2 ? "declined" : `${usd(leo.sub.amount)} paid on the same invoice`}`);

say.beat("result", "Day 4: every invoice read back from Airwallex.");
let billed = 0, collected = 0, onceEach = true;
const rows = [];
for (const s of state.values()) {
  const pi = await awx.get(`/pa/payment_intents/${s.intent}`);
  billed += s.sub.amount;
  if (pi.status === "SUCCEEDED") collected += Number(pi.captured_amount ?? pi.amount);
  if (pi.status === "SUCCEEDED" && Number(pi.captured_amount ?? pi.amount) !== s.sub.amount) onceEach = false;
  const step = s.paid ? null : nextStep(s.history);
  rows.push({ invoice: `${s.sub.id}-${month}`, customer: s.sub.name, amount: s.sub.amount, airwallex: pi.status, attempts: s.attempts.length, next: step ? step.action : "", access: s.paid || accessOn(s.history, 4) ? "on" : "paused" });
}
say.table(rows);
for (const s of state.values()) say.step(`${s.sub.name}: ${s.attempts.join(" → ")}`);
const recovered = [...state.values()].filter((s) => s.paid && s.history.declines.length).reduce((t, s) => t + s.sub.amount, 0);
say.step(await explain(
  { question: "Summarise the recovery for a finance lead in two sentences.", billed, collected, recovered_after_decline: recovered, outstanding: billed - collected, policy: `soft retries on days ${POLICY.softRetryDays.join("/")}, max ${POLICY.maxAttemptsPer30Days} attempts, grace ${POLICY.graceDays} days, risk never retried` },
  `Collected ${usd(collected)} of ${usd(billed)}, including ${usd(recovered)} recovered after a decline, with every invoice charged at most once. ${usd(Math.round((billed - collected) * 100) / 100)} is outstanding: one customer must supply another card, and one is paused for a fraud review.`,
));
say[onceEach ? "ok" : "fail"](`collected ${usd(collected)} of ${usd(billed)} · recovered ${usd(recovered)} after declines · no invoice charged twice · no retry of a card or risk decline`);
say.step(`audit log: ${auditPath}`);
