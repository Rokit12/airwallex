/**
 * Kit 1 — Adaptive Treasury Controller
 *
 * Goal: five obligations in three currencies fall due within 72 hours and free
 * cash above the reserve floor covers only part of them.
 *  1. Plan in code: fund the freight release, convert only the shortfall for the
 *     time-sensitive supplier, defer the cheapest obligation, escalate the policy exception.
 *  2. A customer email contradicts the receipt forecast: confidence drops, so the
 *     same conversions now need a person.
 *  3. A partial deposit lands: only the decision it affects changes.
 *  4. Execute an approved FX conversion on a single-use quote and the supplier
 *     payouts, then confirm the reserve.
 */
import { writeFileSync } from "node:fs";
import { AirwallexClient, newRequestId, money } from "../../src/core/client.ts";
import { Sandbox } from "../../src/core/sandbox.ts";
import { say, usd } from "../../src/core/narrate.ts";
import { extract, explain, llmEnabled } from "../../src/core/llm.ts";
import { requestApproval, assertApproved, type Terms } from "../../src/core/approval.ts";
import { auditPath } from "../../src/core/audit.ts";
import { plan, changedLines, receiptConfidence, DEFAULT_TREASURY_POLICY as P, type Plan, type Position, type Ccy, type Obligation } from "./policy.ts";
import { ENVELOPE, OBLIGATIONS, RECEIVABLE, CUSTOMER_EMAIL, CUSTOMER_EMAIL_FALLBACK, BENEFICIARIES } from "./fixtures.ts";

const awx = new AirwallexClient();
const sb = new Sandbox(awx);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ob = (id: string) => OBLIGATIONS.find((o) => o.id === id)!;

async function usdPer(c: Ccy): Promise<number> {
  if (c === "USD") return 1;
  // Indicative rate for planning. Booking always uses a fresh single-use quote.
  const r = await awx.get("/fx/rates/current", { query: { buy_currency: c, sell_currency: "USD", buy_amount: 1000 } });
  return Number(r.rate);
}

function showPlan(p: Plan) {
  say.table(
    p.lines.map((l) => {
      const o = ob(l.obligation);
      return { obligation: l.obligation, payee: o.payee, due_h: o.dueInHours, amount: `${o.currency} ${o.amount}`, action: l.action, buy_fx: l.convertBuy || "", usd_cost: l.usdCost, person: l.needsApproval ? "yes" : "" };
    }),
  );
  say.step(`free above ${usd(P.reserveFloor)} floor: ${usd(p.freeUsdBefore)} → ${usd(p.freeUsdAfter)} · confidence ${p.confidence} · autonomous FX limit ${usd(p.fxLimit)}`);
}

async function settle(transferId: string): Promise<string> {
  await sb.transferTransition(transferId, "SENT");
  try {
    await sb.transferTransition(transferId, "PAID");
  } catch {
    /* sandbox may answer 500 and still apply it: re-read below */
  }
  let s = "";
  for (let i = 0; i < 10; i++) {
    s = (await awx.get(`/transfers/${transferId}`)).status;
    if (s === "PAID" || s === "CANCELLED") break;
    await sleep(1500);
  }
  return s;
}

/** Book FX on a fresh single-use quote. The approval binds the quote id, rate and both amounts. */
async function convert(o: Obligation, buy: number, needsApproval: boolean) {
  const quote = await awx.post("/fx/quotes/create", { request_id: newRequestId(), buy_currency: o.currency, sell_currency: "USD", buy_amount: buy, validity: "MIN_1" });
  const terms: Terms = { action: "BOOK_FX", amount: buy, currency: o.currency, counterparty: "Airwallex FX", sell: `USD ${quote.sell_amount}`, rate: quote.client_rate, quote_id: quote.quote_id, for: o.id };
  if (needsApproval) {
    const a = await requestApproval(terms, `Buy ${o.currency} ${buy} for ${o.payee}? (forecast confidence LOW, above the autonomous FX limit)`);
    assertApproved(terms, a);
  }
  const before = await sb.available(o.currency);
  const conv = await awx.post("/fx/conversions/create", { request_id: newRequestId(), quote_id: quote.quote_id, buy_currency: o.currency, sell_currency: "USD", buy_amount: buy });
  const after = await sb.available(o.currency);
  say.ok(`FX ${conv.status}: bought ${o.currency} ${conv.buy_amount} for USD ${conv.sell_amount} @ ${conv.client_rate ?? quote.client_rate} · ${o.currency} wallet +${money(after - before)}`);
  return { sellUsd: Number(conv.sell_amount) };
}

async function pay(o: Obligation, sourceCurrency: Ccy) {
  const spec = BENEFICIARIES[o.id as keyof typeof BENEFICIARIES];
  const ben = await awx.post("/beneficiaries/create", { request_id: newRequestId(), ...spec });
  const tr = await awx.post("/transfers/create", {
    request_id: newRequestId(),
    beneficiary_id: ben.id ?? ben.beneficiary_id,
    transfer_amount: String(o.amount),
    transfer_currency: o.currency,
    source_currency: sourceCurrency,
    transfer_method: o.method,
    reference: `${o.id}-${Date.now().toString(36).slice(-4).toUpperCase()}`,
    reason: o.id === "FREIGHT" ? "freight" : "professional_business_services",
  });
  const status = await settle(tr.id);
  say.ok(`${o.method} payout to ${o.payee}: ${o.currency} ${o.amount} + fee ${tr.fee_amount ?? 0} → ${status}`);
  const plannedFee = o.method === "SWIFT" ? (P.swiftFee[o.currency] ?? 0) : 0;
  const actualFee = Number(tr.fee_amount ?? 0);
  if (o.method === "SWIFT" && actualFee !== plannedFee) {
    // Fees are planned from policy; Airwallex's actual fee wins. Flag the variance so the policy table gets updated.
    say.warn(`fee variance: planned ${o.currency} ${plannedFee}, Airwallex charged ${o.currency} ${actualFee} (difference ${money(actualFee - plannedFee)} covered by held balance)`);
  }
  return { fee: Number(tr.fee_amount ?? 0), status };
}

// ── Main ─────────────────────────────────────────────────────────────────────
say.title("Kit 1 · Adaptive Treasury Controller — 72-hour obligations");
say.beat("goal", `Pay what keeps the business running without dropping below the ${usd(P.reserveFloor)} reserve.`);
say.step(`model: ${llmEnabled() ? "Claude reads the customer's email" : "rules only (set ANTHROPIC_API_KEY to let Claude read the email)"}`);

const wallet = { USD: await sb.ensureUsd(ENVELOPE.USD), EUR: await sb.available("EUR"), GBP: await sb.available("GBP") };
const cash: Record<Ccy, number> = { USD: Math.min(wallet.USD, ENVELOPE.USD), EUR: Math.min(wallet.EUR, ENVELOPE.EUR), GBP: Math.min(wallet.GBP, ENVELOPE.GBP) };
const pos: Position = { cash, usdPer: { USD: 1, EUR: await usdPer("EUR"), GBP: await usdPer("GBP") } };
say.step(`operating envelope on the wallet: USD ${cash.USD} · EUR ${cash.EUR} · GBP ${cash.GBP} · rates EURUSD ${pos.usdPer.EUR}, GBPUSD ${pos.usdPer.GBP}`);
say.step(`receivable: ${RECEIVABLE.customer} ${RECEIVABLE.invoice} ${usd(RECEIVABLE.amount)} expected ${RECEIVABLE.expected} — ${RECEIVABLE.bankData}`);

say.beat("plan", "Rank obligations and fund what fits above the floor.");
const conf1 = receiptConfidence({ invoiceMatchesBankData: true, contradiction: false });
const plan1 = plan(OBLIGATIONS, pos, conf1);
showPlan(plan1);
for (const l of plan1.lines) say.decision(l.obligation, l.action, l.reason);

say.beat("new information", "The customer emails about the receivable.");
say.document(CUSTOMER_EMAIL);
const { value: email } = await extract(
  "Extract JSON: contradiction (boolean: does this change the expected amount or date of payment?), amountTomorrow (number), remainderLater (number).",
  CUSTOMER_EMAIL,
  (v: any): v is typeof CUSTOMER_EMAIL_FALLBACK => v && typeof v.contradiction === "boolean" && typeof v.amountTomorrow === "number" && typeof v.remainderLater === "number",
  () => CUSTOMER_EMAIL_FALLBACK,
);
const conf2 = receiptConfidence({ invoiceMatchesBankData: true, contradiction: email.contradiction });
const plan2 = plan(OBLIGATIONS, pos, conf2);
say.decision("forecast confidence", `${conf1} → ${conf2}`, `Email moves ${usd(email.remainderLater)} to next week; autonomous FX limit ${usd(P.fxLimitByConfidence[conf1])} → ${usd(P.fxLimitByConfidence[conf2])}.`);
for (const l of changedLines(plan1, plan2)) say.decision(l.obligation, `${l.action}${l.needsApproval ? " — now needs a person" : ""}`, `Same conversion (USD ${l.convertSellUsd}), lower confidence.`);

say.beat("new information", `${RECEIVABLE.customer}'s partial payment arrives (sandbox deposit).`);
const ga = await sb.usdGlobalAccount();
const usdBefore = await sb.available("USD");
await sb.deposit(ga, email.amountTomorrow, `${RECEIVABLE.customer} ${RECEIVABLE.invoice}`);
const usdAfter = await sb.available("USD");
say.step(`USD wallet +${money(usdAfter - usdBefore)} (deposit posts immediately)`);
pos.cash.USD = money(pos.cash.USD + (usdAfter - usdBefore));
const plan3 = plan(OBLIGATIONS, pos, conf2);
const changed = changedLines(plan2, plan3);
say.step(`recalculated: ${changed.length} decision(s) changed, ${plan3.lines.length - changed.length} unchanged`);
for (const l of changed) say.decision(l.obligation, l.action, await explain({ ...l, details: ob(l.obligation) }, l.reason));
showPlan(plan3);

say.beat("execute", "Freight first (critical), then the newly fundable payment.");
const freight = plan3.lines.find((l) => l.obligation === "FREIGHT")!;
let spentUsd = 0;
if (freight.convertBuy > 0) spentUsd += (await convert(ob("FREIGHT"), freight.convertBuy, freight.needsApproval)).sellUsd;
await pay(ob("FREIGHT"), "EUR");
for (const l of changed.filter((x) => x.action === "FUND")) {
  const r = await pay(ob(l.obligation), "USD");
  spentUsd += ob(l.obligation).amount + r.fee;
}
const queued = plan3.lines.filter((l) => (l.action === "FUND" || l.action === "CONVERT_AND_FUND") && l.obligation !== "FREIGHT" && !changed.some((c) => c.obligation === l.obligation));
const queuedUsd = queued.reduce((s, l) => s + l.usdCost, 0);
const escalated = plan3.lines.filter((l) => l.action === "ESCALATE");
for (const l of escalated) {
  writeFileSync(`runs/escalation-${l.obligation}.json`, JSON.stringify({ obligation: ob(l.obligation), why: l.reason }, null, 2));
}

say.beat("result", "Confirm the reserve.");
const envelopeUsd = money(pos.cash.USD - spentUsd);
const afterQueued = money(envelopeUsd - queuedUsd);
say.table([
  { item: "Envelope USD after deposit", usd: pos.cash.USD },
  { item: "Spent now (FX + payouts + fees)", usd: -money(spentUsd) },
  { item: "Envelope USD now", usd: envelopeUsd },
  { item: `Queued: ${queued.map((q) => q.obligation).join(", ")}`, usd: -money(queuedUsd) },
  { item: "After queued payments", usd: afterQueued },
  { item: "Reserve floor", usd: P.reserveFloor },
]);
say[afterQueued >= P.reserveFloor ? "ok" : "fail"](`reserve ${afterQueued >= P.reserveFloor ? "held" : "BREACHED"}: ${usd(afterQueued)} ≥ ${usd(P.reserveFloor)} · escalated to a person: ${escalated.map((e) => e.obligation).join(", ") || "none"}`);
say.step(`audit log: ${auditPath}`);
