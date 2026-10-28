/**
 * Kit 6 — Multi-Employer Payroll Executor
 *
 * You run weekly contractor payroll for three employers, each a connected
 * account. For each: price payroll including SWIFT fees, convert on the
 * employer's behalf, pay contractors, collect the platform fee.
 *  - Beacon is short. Summing all tenants' balances says there is plenty; the
 *    agent checks Beacon's own wallet, pays what it covers in full, and asks a
 *    person for a platform advance rather than touching another employer's money.
 *  - Cobalt's deposit lands mid-run. It funds Cobalt only; Beacon stays short.
 */
import { newRequestId } from "../../src/core/client.ts";
import { PlatformClient } from "../../src/core/platform-client.ts";
import { Sandbox } from "../../src/core/sandbox.ts";
import { onboardAndFund, transferToCustomer, chargeCustomer, waitSettled, balanceOf, depositAndWait } from "../../src/core/platform.ts";
import { say, usd } from "../../src/core/narrate.ts";
import { explain } from "../../src/core/llm.ts";
import { requestApproval, assertApproved, type Terms } from "../../src/core/approval.ts";
import { auditPath } from "../../src/core/audit.ts";
import { price, planEmployer, naivePooledCheck, DEFAULT_PAYROLL_POLICY as P, type Ccy, type PricedLine } from "./policy.ts";
import { EMPLOYERS, beneficiaryFor, type Employer } from "./fixtures.ts";

const awx = new PlatformClient();
const sb = new Sandbox(awx);
const accts: Record<string, string> = {};
const paid: Record<string, string[]> = { ATLAS: [], BEACON: [], COBALT: [] };

async function usdPer(c: Ccy) {
  if (c === "USD") return 1;
  const r = await awx.get("/fx/rates/current", { query: { buy_currency: c, sell_currency: "USD", buy_amount: 1000 } });
  return Number(r.rate);
}

/** Pay one contractor entirely inside the employer's account: FX, beneficiary and transfer all carry x-on-behalf-of. */
async function payLine(e: Employer, l: PricedLine) {
  const ob = { onBehalfOf: accts[e.key]! };
  if (l.currency !== "USD") {
    const conv = await awx.post("/fx/conversions/create", { request_id: newRequestId(), buy_currency: l.currency, sell_currency: "USD", buy_amount: l.needed }, ob);
    say.step(`${e.spec.name}: bought ${l.currency} ${conv.buy_amount} for USD ${conv.sell_amount} (on behalf; ${l.currency} landed in ${e.key}'s wallet: ${await balanceOf(awx, accts[e.key], l.currency)})`);
  }
  const ben = await awx.post("/beneficiaries/create", { request_id: newRequestId(), ...beneficiaryFor(l) }, ob);
  const tr = await awx.post("/transfers/create", { request_id: newRequestId(), beneficiary_id: ben.id ?? ben.beneficiary_id, transfer_amount: String(l.amount), transfer_currency: l.currency, source_currency: l.currency, transfer_method: l.method, reference: `PAYROLL-W42-${e.key}`, reason: "wages_salary" }, ob);
  // Transfers made on a customer's behalf stay PROCESSING until simulated to a terminal status.
  await sb.transferTransition(tr.id, "SENT", undefined, ob.onBehalfOf);
  await sb.transferTransition(tr.id, "PAID", undefined, ob.onBehalfOf);
  const final = await awx.get(`/transfers/${tr.id}`, ob);
  paid[e.key]!.push(l.name);
  say.ok(`${e.spec.name} → ${l.name}: ${l.currency} ${l.amount} ${l.method}${l.fee ? ` + fee ${l.fee}` : ""} → ${final.status}`);
}

async function collectFee(e: Employer, contractorsPaid: number) {
  const fee = contractorsPaid * P.feePerContractor;
  if (!fee) return;
  const bal = await balanceOf(awx, accts[e.key]);
  if (bal < fee) return say.warn(`${e.spec.name} holds ${usd(bal)}: fee ${usd(fee)} recorded as a receivable`);
  const ch = await chargeCustomer(awx, { from: accts[e.key]!, amount: fee, currency: "USD", reason: "professional_business_services", reference: `PAYROLL-FEE-W42-${e.key}` });
  say.step(`platform fee ${usd(fee)} from ${e.spec.name} → ${await waitSettled(awx, "charges", ch.id)}`);
}

say.title("Kit 6 · Multi-Employer Payroll Executor — week 42 contractor payroll");
say.beat("goal", "Pay every employer's contractors from that employer's own money, with fees priced in.");

say.beat("setup", "Open three employer accounts and fund the two that have paid in.");
for (const e of EMPLOYERS) {
  const a = await onboardAndFund(awx, e.spec, e.deposit, "Employer payroll funding");
  accts[e.key] = a.id;
  say.step(`${e.spec.name}: ${a.id} ${a.status} · wallet ${usd(await balanceOf(awx, a.id))}`);
}
if (awx.mode === "emulated") await awx.fundPlatform(5000, "Platform operating capital");
const rates: Record<Ccy, number> = { USD: 1, EUR: await usdPer("EUR"), GBP: await usdPer("GBP") };
say.step(`live rates: EURUSD ${rates.EUR}, GBPUSD ${rates.GBP} · SWIFT fee EUR ${P.swiftFee.EUR} per payout`);

say.beat("plan", "Price each payroll, including SWIFT fees, against each employer's own balance.");
const plans = new Map<string, ReturnType<typeof planEmployer>>();
for (const e of EMPLOYERS) plans.set(e.key, planEmployer(e.key, await balanceOf(awx, accts[e.key]), price(e.contractors, rates)));
say.table(EMPLOYERS.map((e) => { const p = plans.get(e.key)!; return { employer: e.spec.name, balance: p.balance, payroll_plus_fees: p.totalUsd, action: p.action, hold: p.hold.map((h) => h.name).join(", ") }; }));
const funded = EMPLOYERS.filter((e) => e.deposit > 0).map((e) => plans.get(e.key)!);
const naive = naivePooledCheck(funded.map((p) => p.balance), funded.map((p) => p.totalUsd));
say.warn(`pooled check (wrong): balances ${usd(naive.pooled)} vs payroll ${usd(naive.needed)} → "${naive.saysEnough ? "enough" : "short"}". Per-employer check: Beacon is short. The agent never pools tenants.`);

say.beat("execute", "Atlas Robotics: fully funded.");
const atlas = EMPLOYERS[0]!;
for (const l of plans.get("ATLAS")!.pay) await payLine(atlas, l);
await collectFee(atlas, plans.get("ATLAS")!.pay.length);

say.beat("execute", "Beacon Health: short.");
const beacon = EMPLOYERS[1]!;
const bp = plans.get("BEACON")!;
say.decision("Beacon Health", bp.action, await explain({ ...bp, pay: bp.pay.map((x) => x.name), hold: bp.hold.map((x) => x.name) }, bp.reason));
for (const l of bp.pay) await payLine(beacon, l);

say.beat("new information", "Cobalt Games' payroll deposit lands mid-run.");
const cobalt = EMPLOYERS[2]!;
const cga = (await awx.get("/global_accounts", { onBehalfOf: accts.COBALT! })).items[0];
await depositAndWait(awx, accts.COBALT!, cga.id, cobalt.midRunDeposit!, "Cobalt Games payroll");
say.step(`Cobalt wallet ${usd(await balanceOf(awx, accts.COBALT))} · Beacon wallet still ${usd(await balanceOf(awx, accts.BEACON))} (deposits land in one tenant only)`);

if (bp.action === "PAY_PARTIAL_AND_REQUEST_ADVANCE") {
  const advance = Math.ceil(bp.shortfall);
  const terms: Terms = { action: "PLATFORM_PAYROLL_ADVANCE", amount: advance, currency: "USD", counterparty: beacon.spec.name, source: "platform capital (not another employer)", for: bp.hold.map((h) => h.name).join(", "), repay: "next Beacon funding" };
  const approval = await requestApproval(terms, `Advance ${usd(advance)} of platform capital so Beacon's held contractors are paid today?`);
  if (approval) {
    assertApproved(terms, approval);
    const t = await transferToCustomer(awx, { to: accts.BEACON!, amount: advance, currency: "USD", reason: "wages_salary", reference: "PAYROLL-ADVANCE-W42-BEACON" });
    say.ok(`advance ${usd(advance)} platform → Beacon: ${await waitSettled(awx, "connected_account_transfers", t.id)}`);
    const re = planEmployer("BEACON", await balanceOf(awx, accts.BEACON), bp.hold);
    for (const l of re.pay) await payLine(beacon, l);
  } else say.warn("advance declined: Marta Silva held; Beacon asked to top up today");
}
await collectFee(beacon, paid.BEACON!.length);

say.beat("execute", "Cobalt Games: now funded from its own deposit.");
const cp = planEmployer("COBALT", await balanceOf(awx, accts.COBALT), price(cobalt.contractors, rates));
say.decision("Cobalt Games", cp.action, cp.reason);
for (const l of cp.pay) await payLine(cobalt, l);
await collectFee(cobalt, cp.pay.length);

say.beat("result", awx.mode === "emulated" ? "Per-employer state (platform rail EMULATED on this account)." : "Per-employer state read back from Airwallex.");
const rows = [];
for (const e of EMPLOYERS) rows.push({ employer: e.spec.name, paid: paid[e.key]!.join(", "), held: e.contractors.filter((c) => !paid[e.key]!.includes(c.name)).map((c) => c.name).join(", ") || "none", wallet_usd: await balanceOf(awx, accts[e.key]) });
say.table(rows);
const paidCount = Object.values(paid).flat().length, total = EMPLOYERS.flatMap((e) => e.contractors).length;
say[paidCount === total ? "ok" : "fail"](`${paidCount}/${total} contractors paid · no employer's funds used for another`);
say.step(`audit log: ${auditPath}`);
