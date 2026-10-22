/**
 * Kit 8 — Marketplace Settlement Agent
 *
 * Buyers pay the marketplace; sellers hold connected accounts. The platform's
 * balance is exactly what the three sellers are owed, with no spare cash.
 *  1. Set each seller's reserve from its trailing refund rate (newest seller highest).
 *  2. Pay the first sellers their net proceeds.
 *  3. A carrier failure hits one seller before its payout runs: recompute that
 *     seller's reserve only, pay the reduced net.
 *  4. Refunds exceed the raised reserve: recover the shortfall from the seller's
 *     wallet (checked first), then reconcile every seller and the platform.
 */
import { newRequestId } from "../../src/core/client.ts";
import { PlatformClient } from "../../src/core/platform-client.ts";
import { Sandbox } from "../../src/core/sandbox.ts";
import { onboardAndFund, transferToCustomer, chargeCustomer, waitSettled, balanceOf } from "../../src/core/platform.ts";
import { say, usd } from "../../src/core/narrate.ts";
import { extract, explain } from "../../src/core/llm.ts";
import { requestApproval, assertApproved, type Terms } from "../../src/core/approval.ts";
import { auditPath } from "../../src/core/audit.ts";
import { reserveFor, reserveWithEvidence, reconcile, type SellerLedger } from "./policy.ts";
import { SELLERS, CARRIER_NOTICE, UNDELIVERED, PEBBLE_REFUNDS } from "./fixtures.ts";

const awx = new PlatformClient();
const sb = new Sandbox(awx);
const r2 = (n: number) => Math.round(n * 100) / 100;
const accts: Record<string, string> = {};
const ledger: Record<string, SellerLedger> = {};
const totalOwed = SELLERS.reduce((s, x) => s + x.owed, 0);

async function payout(key: string, amount: number) {
  const t = await transferToCustomer(awx, { to: accts[key]!, amount, currency: "USD", reason: "goods_purchased", reference: `SETTLE-2026-W42-${key}` });
  ledger[key]!.paidOut = r2(ledger[key]!.paidOut + amount);
  return waitSettled(awx, "connected_account_transfers", t.id);
}

say.title("Kit 8 · Marketplace Settlement Agent — week 42 seller settlement");
say.beat("goal", `Settle ${usd(totalOwed)} owed to three sellers while holding enough to cover refunds after payout.`);

say.beat("setup", "Sellers as connected accounts; the platform wallet holds exactly what they are owed.");
for (const s of SELLERS) {
  const a = await onboardAndFund(awx, s.spec, 0);
  accts[s.key] = a.id;
  ledger[s.key] = { owed: s.owed, paidOut: 0, refunds: 0, recovered: 0, reserveHeld: 0 };
  say.step(`${s.spec.name}: ${a.id} ${a.status} · owed ${usd(s.owed)} · refund rate ${(s.refundRate * 100).toFixed(1)}% · ${s.monthsActive} months on the marketplace`);
}
if (awx.mode === "emulated") await awx.fundPlatform(totalOwed, "Buyer payments, week 42");
const platformStart = awx.mode === "emulated" ? await balanceOf(awx, undefined) : totalOwed;
say.step(`platform holds ${usd(platformStart)} = ${usd(totalOwed)} owed, no spare cash`);

say.beat("plan", "Set a reserve per seller.");
const reserves: Record<string, number> = {};
for (const s of SELLERS) {
  const r = reserveFor(s);
  reserves[s.key] = r.reserve;
  say.decision(s.spec.name, `RESERVE ${usd(r.reserve)} · NET ${usd(s.owed - r.reserve)}`, r.reason);
}

say.beat("act", "Pay Granite Goods and Fern & Flax their net proceeds.");
for (const key of ["GRANITE", "FERN"] as const) {
  const s = SELLERS.find((x) => x.key === key)!;
  const net = r2(s.owed - reserves[key]!);
  say.ok(`${s.spec.name}: paid ${usd(net)} → ${await payout(key, net)} · reserve held ${usd(reserves[key]!)}`);
  ledger[key]!.reserveHeld = reserves[key]!;
}

say.beat("new information", "A carrier notice arrives before Pebble Toys' payout runs.");
say.document(CARRIER_NOTICE);
const { value: notice } = await extract(
  "Extract JSON: merchant (string), parcels (number).",
  CARRIER_NOTICE,
  (v: any): v is { merchant: string; parcels: number } => v && typeof v.merchant === "string" && typeof v.parcels === "number",
  () => ({ merchant: "PEBBLE TOYS CO", parcels: UNDELIVERED.orders }),
);
const pebble = SELLERS.find((x) => x.key === "PEBBLE")!;
const raised = reserveWithEvidence(pebble, { orders: notice.parcels, avgValue: UNDELIVERED.avgValue });
say.decision(pebble.spec.name, `RESERVE ${usd(reserves.PEBBLE!)} → ${usd(raised.reserve)}`, await explain({ seller: pebble.spec.name, ...raised }, raised.reason));
say.step("Granite Goods and Fern & Flax are unaffected: their reserves are not recalculated");
const pebbleNet = r2(pebble.owed - raised.reserve);
const terms: Terms = { action: "SETTLE_SELLER", amount: pebbleNet, currency: "USD", counterparty: pebble.spec.name, reserve_held: raised.reserve, evidence: `carrier notice, ${notice.parcels} parcels` };
const approval = await requestApproval(terms, `Pay ${pebble.spec.name} ${usd(pebbleNet)} and hold ${usd(raised.reserve)} against the carrier failure?`);
if (!approval) {
  say.warn("not approved — Pebble's payout stays on hold");
  process.exit(0);
}
assertApproved(terms, approval);
say.ok(`${pebble.spec.name}: paid ${usd(pebbleNet)} → ${await payout("PEBBLE", pebbleNet)} · reserve held ${usd(raised.reserve)}`);
ledger.PEBBLE!.reserveHeld = raised.reserve;

say.beat("new information", "Pebble's buyers are refunded for parcels that never arrived.");
const refundBen = await awx.post("/beneficiaries/create", { request_id: newRequestId(), transfer_methods: ["LOCAL"], beneficiary: { entity_type: "COMPANY", company_name: "Marketplace Buyer Refunds", address: { street_address: "500 Market St", city: "San Francisco", state: "CA", postcode: "94105", country_code: "US" }, bank_details: { account_currency: "USD", account_name: "Marketplace Buyer Refunds", account_number: "000999000111", account_routing_type1: "aba", account_routing_value1: "121000248", bank_country_code: "US", bank_account_category: "Checking", local_clearing_system: "ACH" } } });
const refund = await awx.post("/transfers/create", { request_id: newRequestId(), beneficiary_id: refundBen.id ?? refundBen.beneficiary_id, transfer_amount: String(PEBBLE_REFUNDS), transfer_currency: "USD", source_currency: "USD", transfer_method: "LOCAL", reference: "REFUNDS-PEBBLE-W42", reason: "goods_purchased" });
await sb.transferTransition(refund.id, "SENT");
await sb.transferTransition(refund.id, "PAID");
ledger.PEBBLE!.refunds = PEBBLE_REFUNDS;
const usedReserve = Math.min(PEBBLE_REFUNDS, ledger.PEBBLE!.reserveHeld);
ledger.PEBBLE!.reserveHeld = r2(ledger.PEBBLE!.reserveHeld - usedReserve);
const shortfall = r2(PEBBLE_REFUNDS - usedReserve);
say.step(`refunds ${usd(PEBBLE_REFUNDS)} paid from the platform: ${usd(usedReserve)} from Pebble's reserve, ${usd(shortfall)} beyond it`);

if (shortfall > 0) {
  const bal = await balanceOf(awx, accts.PEBBLE);
  if (bal >= shortfall) {
    const ch = await chargeCustomer(awx, { from: accts.PEBBLE!, amount: shortfall, currency: "USD", reason: "professional_business_services", reference: "REFUND-SHORTFALL-PEBBLE-W42" });
    ledger.PEBBLE!.recovered = shortfall;
    say.ok(`recovered ${usd(shortfall)} from ${pebble.spec.name} (wallet ${usd(bal)}) → ${await waitSettled(awx, "charges", ch.id)}`);
  } else say.warn(`${pebble.spec.name} holds ${usd(bal)} < ${usd(shortfall)}: receivable recorded, deduct from next settlement`);
}

say.beat("result", awx.mode === "emulated" ? "Reconcile (platform rail EMULATED on this account)." : "Reconcile against Airwallex.");
say.table(SELLERS.map((s) => { const l = ledger[s.key]!; const r = reconcile(l); return { seller: s.spec.name, owed: l.owed, paid_out: l.paidOut, refunds: l.refunds, recovered: l.recovered, reserve_held: l.reserveHeld, reconciles: r.ok ? "✔" : `✖ ${r.difference}` }; }));
const unreleased = r2(Object.values(ledger).reduce((s, l) => s + l.reserveHeld, 0));
if (awx.mode === "emulated") {
  const platformNow = await balanceOf(awx, undefined);
  say[Math.abs(platformNow - unreleased) < 0.005 ? "ok" : "fail"](`platform wallet ${usd(platformNow)} = unreleased reserves ${usd(unreleased)}`);
} else say.ok(`unreleased reserves ${usd(unreleased)} (platform ledger)`);
const report = await awx.post("/platform_reports/create", { type: "BALANCE_REPORT", file_format: "CSV" });
say.step(`balance report ${report.id ?? ""} ${report.status ?? ""}`);
say.step(`audit log: ${auditPath}`);
