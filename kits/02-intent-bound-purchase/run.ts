/**
 * Kit 2 — Intent-Bound Purchase Agent
 *
 * Goal: buy a SaaS plan without breaking the cash reserve.
 *  1. Read the vendor's quote and forecast cash for both billing plans.
 *  2. Choose monthly because annual breaches the reserve in week 7; record when to reconsider.
 *  3. Issue a virtual card whose controls only allow that choice, then prove it with
 *     authorizations that pass and fail for the reasons the policy predicts.
 *  4. The vendor raises the price: the approved terms no longer hold, so the agent
 *     freezes its own card and asks again.
 */
process.env.KIT ??= "kit02";
import { writeFileSync } from "node:fs";
import { AwxError, newRequestId } from "../../src/core/client.ts";
import { RailsClient } from "../../src/core/rails.ts";
import { Sandbox } from "../../src/core/sandbox.ts";
import { say, usd } from "../../src/core/narrate.ts";
import { extract, explain, llmEnabled } from "../../src/core/llm.ts";
import { requestApproval, assertApproved, type Terms } from "../../src/core/approval.ts";
import { auditPath } from "../../src/core/audit.ts";
import { BUSINESS } from "../../src/core/business.ts";
import { QUOTE, QUOTE_TEXT, FORECAST, PRICE_CHANGE_EMAIL } from "./fixtures.ts";
import { choosePlan, controlsFor, predict, type Quote, type CardControls, type Outcome } from "./policy.ts";

const awx = new RailsClient();
const sb = new Sandbox(awx);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const isQuote = (v: any): v is Quote =>
  v && typeof v.vendor === "string" && typeof v.currency === "string" && typeof v.monthlyPrice === "number" && typeof v.annualPrice === "number" && Array.isArray(v.mccs) && typeof v.annualRefundable === "boolean";

async function readQuote(): Promise<Quote> {
  const { value, source } = await extract(
    "Extract the SaaS quote as JSON: vendor (string), currency (ISO code), monthlyPrice (number), annualPrice (number, total paid up front), mccs (array of merchant category code strings), annualRefundable (boolean).",
    QUOTE_TEXT,
    isQuote,
    () => QUOTE,
  );
  const mismatch = value.monthlyPrice !== QUOTE.monthlyPrice || value.annualPrice !== QUOTE.annualPrice || value.currency !== QUOTE.currency;
  say.step(`quote read by ${source}${mismatch ? " (amounts disagree with the quote on file — using the file)" : ""}`);
  return mismatch ? QUOTE : value;
}

function termsFor(q: Quote, c: CardControls, monthly: number): Terms {
  return { action: "ISSUE_SUBSCRIPTION_CARD", amount: monthly, currency: q.currency, counterparty: q.vendor, plan: "MONTHLY", merchant_categories: c.allowed_merchant_categories, limits: c.transaction_limits.limits };
}

async function waitForCard(cardId: string) {
  for (let i = 0; i < 10; i++) {
    const card = await awx.get(`/issuing/cards/${cardId}`);
    if (card.card_status === "ACTIVE") return card;
    await sleep(1500);
  }
  throw new Error(`Card ${cardId} did not become ACTIVE`);
}

/** Run one authorization and read back what Airwallex did. CLEARING = accepted; failure_reason = decline. */
async function authorize(cardId: string, a: { amount: number; currency: string; mcc: string; merchant: string }): Promise<{ outcome: string; txId?: string }> {
  try {
    const tx = await sb.cardAuthorization({ card_id: cardId, amount: a.amount, currency: a.currency, mcc: a.mcc, merchant: a.merchant, singlePhase: true });
    if (tx.failure_reason) return { outcome: tx.failure_reason, txId: tx.transaction_id };
    if (tx.status === "FAILED") return { outcome: "FAILED", txId: tx.transaction_id };
    return { outcome: "APPROVED", txId: tx.transaction_id };
  } catch (err) {
    if (err instanceof AwxError) return { outcome: `${err.code}` };
    throw err;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
say.title("Kit 2 · Intent-Bound Purchase Agent — Northwind Analytics Team plan");
say.beat("goal", "Buy the analytics plan without letting cash fall below the reserve floor.");
say.step(`model: ${llmEnabled() ? "Claude reads the quote and explains" : "rules only (set ANTHROPIC_API_KEY to let Claude read the quote)"}`);

const wallet = await sb.ensureUsd(25_000);
// The team's operating budget is a slice of the company wallet, capped by what is really there.
const planningCash = Math.min(wallet, Number(process.env.PLANNING_CASH ?? 25_000));
say.step(`wallet: ${usd(wallet)} available · team operating budget ${usd(planningCash)}`);

const quote = await readQuote();
const forecast = FORECAST(planningCash);
const decision = choosePlan(quote, forecast);

say.beat("plan", `Forecast 13 weeks for both billing plans against a ${usd(forecast.reserveFloor)} floor.`);
say.table(
  forecast.weeklyNet.map((_, w) => ({
    week: w + 1,
    monthly: decision.paths.MONTHLY.balances[w],
    annual: decision.paths.ANNUAL.balances[w],
    annual_breach: decision.paths.ANNUAL.balances[w]! < forecast.reserveFloor ? "BELOW FLOOR" : "",
  })),
);
say.decision("billing plan", decision.plan, await explain({ ...decision, paths: undefined }, decision.rationale));
if (decision.plan !== "MONTHLY") {
  say.warn(`demo expects MONTHLY; got ${decision.plan}. Run with PLANNING_CASH=25000 to reproduce the week-7 squeeze.`);
  if (decision.plan === "ESCALATE") process.exit(0);
}
const reconsider = decision.reconsiderWeek !== null ? new Date(Date.now() + decision.reconsiderWeek * 7 * 86_400_000).toISOString().slice(0, 10) : null;
writeFileSync(
  "runs/kit02-decision.json",
  JSON.stringify({ vendor: quote.vendor, plan: decision.plan, saving_forgone_pct: decision.annualSavingPct, reconsider_on: reconsider, rationale: decision.rationale }, null, 2),
);
say.step(`decision recorded · reconsider annual on ${reconsider ?? "(not within horizon)"} (week ${decision.reconsiderWeek !== null ? decision.reconsiderWeek + 1 : "-"}, after the receivable lands)`);

say.beat("enforce", "Issue a virtual card whose controls only allow the monthly bill.");
const plan = decision.plan === "ANNUAL" ? "ANNUAL" : "MONTHLY";
const controls = controlsFor(quote, plan);
const bill = plan === "MONTHLY" ? quote.monthlyPrice : quote.annualPrice;
const terms = termsFor(quote, controls, bill);
const approval = await requestApproval(terms, `Issue a ${quote.vendor} card for ${usd(bill)} ${plan.toLowerCase()}?`);
if (!approval) {
  say.warn("not approved — no card issued");
  process.exit(0);
}
assertApproved(terms, approval);

// Reuse the procurement cardholder if it already exists (one cardholder per email).
const existing = await awx.get("/issuing/cardholders", { query: { email: BUSINESS.procurementEmail } }).catch(() => ({ items: [] }));
const holder =
  (existing.items ?? []).find((h: any) => h.email === BUSINESS.procurementEmail) ??
  (await awx.post("/issuing/cardholders/create", { type: "DELEGATE", email: BUSINESS.procurementEmail }));
say.step(`cardholder ${holder.cardholder_id} (${holder.status})`);
const created = await awx.post("/issuing/cards/create", {
  request_id: newRequestId(),
  cardholder_id: holder.cardholder_id,
  is_personalized: false,
  form_factor: "VIRTUAL",
  program: { purpose: "COMMERCIAL" },
  purpose: "SUBSCRIPTIONS",
  nick_name: `${quote.vendor} ${plan.toLowerCase()}`.slice(0, 40),
  created_by: approval.approvedBy,
  authorization_controls: controls,
});
const card = await waitForCard(created.card_id);
say.ok(`card ${card.card_id} ACTIVE · ${controls.allowed_currencies.join("/")} only · MCC ${controls.allowed_merchant_categories.join(", ")} · ${controls.transaction_limits.limits.map((l) => `${l.interval} ${l.amount}`).join(", ")}`);
const limits = await awx.get(`/issuing/cards/${card.card_id}/limits`).catch(() => null);
if (limits) say.step(`card limits read back: ${JSON.stringify(limits.limits ?? limits).slice(0, 160)}`);

say.beat("prove", "Simulate authorizations; each outcome must match what the policy predicts.");
const attempts = [
  { label: "First monthly invoice", amount: bill, currency: "USD", mcc: "5734", merchant: "NORTHWIND ANALYTICS" },
  { label: "Vendor bills the annual price", amount: quote.annualPrice, currency: "USD", mcc: "5734", merchant: "NORTHWIND ANALYTICS" },
  { label: "Same bill in EUR", amount: 1100, currency: "EUR", mcc: "5734", merchant: "NORTHWIND ANALYTICS EU" },
  { label: "Team lunch on the SaaS card", amount: 45, currency: "USD", mcc: "5812", merchant: "CAFE LUNA" },
  { label: "Second charge in the same month", amount: bill, currency: "USD", mcc: "5817", merchant: "NORTHWIND ADD-ONS" },
];
let spent = 0;
const results: Record<string, unknown>[] = [];
for (const a of attempts) {
  const expected: Outcome = predict(controls, a, spent, true);
  const { outcome } = await authorize(card.card_id, a);
  if (outcome === "APPROVED") spent += a.amount;
  results.push({ attempt: a.label, amount: `${a.currency} ${a.amount}`, mcc: a.mcc, expected, outcome: outcome, match: expected === outcome ? "✔" : "✖" });
}
say.table(results);

say.beat("new information", "Vendor emails a price increase.");
say.document(PRICE_CHANGE_EMAIL);
const { value: change } = await extract(
  "Extract JSON: newMonthlyPrice (number), currency (ISO code).",
  PRICE_CHANGE_EMAIL,
  (v: any): v is { newMonthlyPrice: number; currency: string } => v && typeof v.newMonthlyPrice === "number" && typeof v.currency === "string",
  () => ({ newMonthlyPrice: 1350, currency: "USD" }),
);
const newQuote = { ...quote, monthlyPrice: change.newMonthlyPrice };
const newControls = controlsFor(newQuote, "MONTHLY");
const newTerms = termsFor(newQuote, newControls, change.newMonthlyPrice); // covers the new limits, not just the price
try {
  assertApproved(newTerms, approval);
} catch (err) {
  say.decision("card authority", "FREEZE AND RE-ASK", `${(err as Error).message}. Approved ${usd(bill)}, vendor now wants ${usd(change.newMonthlyPrice)}.`);
}
await awx.post(`/issuing/cards/${card.card_id}/update`, { card_status: "INACTIVE" });
const frozen = await authorize(card.card_id, { amount: change.newMonthlyPrice, currency: "USD", mcc: "5734", merchant: "NORTHWIND ANALYTICS" });
say.step(`next invoice at new price → ${frozen.outcome} (expected CARD_INACTIVE)`);

const reapproval = await requestApproval(newTerms, `Vendor raised the price. Allow ${usd(change.newMonthlyPrice)}/month?`);
if (reapproval) {
  assertApproved(newTerms, reapproval);
  await awx.post(`/issuing/cards/${card.card_id}/update`, { card_status: "ACTIVE", authorization_controls: newControls });
  say.ok(`card reactivated with limits ${newControls.transaction_limits.limits.map((l) => `${l.interval} ${l.amount}`).join(", ")}`);
} else {
  say.warn("price change not approved — card stays frozen; cancel the subscription before the next invoice");
}

say.beat("result", awx.mode.issuing === "emulated" ? "Read back (card issuing EMULATED on this account)." : "Read back from Airwallex.");
const txs = await awx.get("/issuing/transactions", { query: { card_id: card.card_id } }).catch(() => ({ items: [] }));
say.table((txs.items ?? []).map((t: any) => ({ amount: `${t.transaction_currency} ${t.transaction_amount}`, type: t.transaction_type, status: t.status, failure: t.failure_reason ?? "", merchant: t.merchant?.name ?? "" })));
say.ok(`balance now ${usd(await sb.available("USD"))} · plan ${decision.plan} · reconsider ${reconsider}`);
say.step(`audit log: ${auditPath}`);
