/**
 * Kit 7 — Portfolio Lending Agent
 *
 * The platform funds revenue-based advances. Each borrower is a connected
 * account: revenue lands in its wallet, and the platform collects a share of
 * that week's revenue as repayment.
 *  1. Plan this week on forecast repayments: the third borrower's full advance
 *     would breach the reserve floor, so plan a partial tranche.
 *  2. Collect actual repayments, checking each wallet first. One borrower's
 *     revenue fell and its wallet is short: collect what is there, record the rest.
 *  3. Re-decide the tranche with the cash actually collected, get approval for
 *     that exact amount, disburse, and reconcile the portfolio.
 */
import { newRequestId } from "../../src/core/client.ts";
import { PlatformClient } from "../../src/core/platform-client.ts";
import { Sandbox } from "../../src/core/sandbox.ts";
import { onboardAndFund, transferToCustomer, chargeCustomer, waitSettled, balanceOf, depositAndWait } from "../../src/core/platform.ts";
import { say, usd } from "../../src/core/narrate.ts";
import { explain } from "../../src/core/llm.ts";
import { requestApproval, assertApproved, type Terms } from "../../src/core/approval.ts";
import { auditPath } from "../../src/core/audit.ts";
import { collection, decideDisbursement, DEFAULT_LENDING_POLICY as P } from "./policy.ts";
import { BORROWERS, PLATFORM_CAPITAL } from "./fixtures.ts";

const awx = new PlatformClient();
const sb = new Sandbox(awx);
const accts: Record<string, { id: string; ga: string; name: string }> = {};
let capital = PLATFORM_CAPITAL; // platform lending capital ledger (an envelope on the platform wallet)

say.title("Kit 7 · Portfolio Lending Agent — weekly collections and a new advance");
say.beat("goal", `Collect this week's repayments and fund Meadow Florist's ${usd(BORROWERS[2]!.approved!)} advance without dropping lending capital below ${usd(P.reserveFloor)}.`);

say.beat("setup", "Borrowers as connected accounts; platform lending capital funded.");
for (const b of BORROWERS) {
  const a = await onboardAndFund(awx, b.spec, 0);
  accts[b.key] = { id: a.id, ga: a.globalAccountId, name: b.spec.name };
  say.step(`${b.spec.name}: ${a.id} ${a.status} · outstanding ${usd(b.outstanding)}${b.approved ? ` · approved ${usd(b.approved)} awaiting disbursement` : ` · repays ${b.repayRate * 100}% of weekly revenue`}`);
}
if (awx.mode === "emulated") await awx.fundPlatform(PLATFORM_CAPITAL, "Lending capital");
say.step(`lending capital ${usd(capital)} · reserve floor ${usd(P.reserveFloor)} · headroom ${usd(capital - P.reserveFloor)}`);

say.beat("plan", "Plan on forecast repayments.");
const lenders = BORROWERS.filter((b) => !b.approved);
const forecastRepay = lenders.reduce((s, b) => s + Math.min(b.outstanding, b.repayRate * b.expectedRevenue), 0);
const plan1 = decideDisbursement(capital + forecastRepay, BORROWERS[2]!.approved!);
say.step(`forecast repayments ${usd(forecastRepay)} (${lenders.map((b) => `${b.key} ${b.repayRate * 100}% × ${b.expectedRevenue}`).join(", ")})`);
say.decision("Meadow advance (forecast)", `${plan1.action} ${usd(plan1.now)}`, plan1.reason);

say.beat("new information", "This week's revenue lands in borrower wallets (sandbox deposits).");
for (const b of lenders) {
  const a = accts[b.key]!;
  await depositAndWait(awx, a.id, a.ga, b.actualRevenue, "Card settlements");
  if (b.ownSpending > 0) {
    // The borrower pays its own supplier before collection day.
    const ben = await awx.post("/beneficiaries/create", { request_id: newRequestId(), transfer_methods: ["LOCAL"], beneficiary: { entity_type: "COMPANY", company_name: "Coastline Parts Inc", address: { street_address: "3 Gear St", city: "San Diego", state: "CA", postcode: "92102", country_code: "US" }, bank_details: { account_currency: "USD", account_name: "Coastline Parts Inc", account_number: "000444333222", account_routing_type1: "aba", account_routing_value1: "121000248", bank_country_code: "US", bank_account_category: "Checking", local_clearing_system: "ACH" } } }, { onBehalfOf: a.id });
    const t = await awx.post("/transfers/create", { request_id: newRequestId(), beneficiary_id: ben.id ?? ben.beneficiary_id, transfer_amount: String(b.ownSpending), transfer_currency: "USD", source_currency: "USD", transfer_method: "LOCAL", reference: "PARTS-INV-883", reason: "goods_purchased" }, { onBehalfOf: a.id });
    await sb.transferTransition(t.id, "SENT", undefined, a.id);
  }
  say.step(`${b.spec.name}: revenue ${usd(b.actualRevenue)} (expected ${usd(b.expectedRevenue)})${b.ownSpending ? `, paid its supplier ${usd(b.ownSpending)}` : ""} · wallet ${usd(await balanceOf(awx, a.id))}`);
}

say.beat("collect", "Collect repayments, checking each wallet before charging.");
let collected = 0;
const receivables: Record<string, number> = {};
const repaid: Record<string, number> = {};
for (const b of lenders) {
  const a = accts[b.key]!;
  const c = collection({ key: b.key, outstanding: b.outstanding, repayRate: b.repayRate }, b.actualRevenue, await balanceOf(awx, a.id));
  say.decision(b.spec.name, c.receivable > 0 ? `COLLECT ${c.collect} + RECEIVABLE ${c.receivable}` : `COLLECT ${c.collect}`, await explain({ ...c }, c.reason));
  if (c.collect > 0) {
    const ch = await chargeCustomer(awx, { from: a.id, amount: c.collect, currency: "USD", reason: "loan_credit_repayment", reference: `RBA-REPAY-W42-${b.key}` });
    say.ok(`charge ${usd(c.collect)} from ${b.spec.name} → ${await waitSettled(awx, "charges", ch.id)}`);
  }
  collected += c.collect;
  repaid[b.key] = c.collect;
  if (c.receivable) receivables[b.key] = c.receivable;
}
capital += collected;
say.step(`collected ${usd(collected)} vs forecast ${usd(forecastRepay)} · lending capital now ${usd(capital)}`);

say.beat("re-decide", "Size Meadow's tranche on the cash actually collected.");
const plan2 = decideDisbursement(capital, BORROWERS[2]!.approved!);
say.decision("Meadow advance (actual)", `${plan2.action} ${usd(plan2.now)}`, `${plan2.reason} Forecast tranche was ${usd(plan1.now)}; ${usd(plan1.now - plan2.now)} less because Harbor Bikes repaid less.`);

if (plan2.now > 0) {
  const meadow = accts.MEADOW!;
  const terms: Terms = { action: "DISBURSE_ADVANCE", amount: plan2.now, currency: "USD", counterparty: meadow.name, account: meadow.id, tranche: `${plan2.now} now, ${plan2.later} later`, capital_after: capital - plan2.now };
  const approval = plan2.needsApproval ? await requestApproval(terms, `Disburse ${usd(plan2.now)} to ${meadow.name} now (capital stays at ${usd(capital - plan2.now)})?`) : { termsHash: "", approvedBy: "policy:auto", at: "" };
  if (plan2.needsApproval) assertApproved(terms, approval);
  const t = await transferToCustomer(awx, { to: meadow.id, amount: plan2.now, currency: "USD", reason: "investment_capital", reference: "RBA-DISBURSE-MEADOW-T1" });
  say.ok(`disbursed ${usd(plan2.now)} → ${await waitSettled(awx, "connected_account_transfers", t.id)} · ${usd(plan2.later)} scheduled for next week`);
  capital -= plan2.now;
}

say.beat("result", awx.mode === "emulated" ? "Portfolio reconciliation (platform rail EMULATED on this account)." : "Portfolio reconciliation from Airwallex.");
const report = await awx.post("/platform_reports/create", { type: "BALANCE_REPORT", file_format: "CSV" });
say.step(`platform report ${report.id ?? ""} ${report.status ?? ""}`);
say.table(BORROWERS.map((b) => ({
  borrower: b.spec.name,
  outstanding_before: b.outstanding,
  repaid: repaid[b.key] ?? 0,
  receivable: receivables[b.key] ?? 0,
  disbursed: b.approved ? plan2.now : 0,
  outstanding_after: b.approved ? plan2.now : b.outstanding - (repaid[b.key] ?? 0),
})));
say[capital >= P.reserveFloor ? "ok" : "fail"](`lending capital ${usd(capital)} ≥ floor ${usd(P.reserveFloor)} · receivables ${usd(Object.values(receivables).reduce((a, b) => a + b, 0))} · Meadow remainder ${usd(plan2.later)} pending`);
say.step(`audit log: ${auditPath}`);
