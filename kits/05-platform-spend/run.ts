/**
 * Kit 5 — Platform Spend Controller
 *
 * You are a card platform for small businesses. Each customer is a connected
 * account with its own wallet; card spend draws from that wallet.
 *  1. Open three customers, fund their wallets, issue each a card on their behalf.
 *  2. Simulate spend, including a decline from the platform's card controls.
 *  3. Two customers' deposits are late and both have a card payment due today.
 *     Bridge capital covers only one: ration it in code.
 *  4. Bridge the chosen customer; the other's payment declines as predicted.
 *  5. The late deposit lands: collect the bridge back and the monthly fee.
 */
import { newRequestId } from "../../src/core/client.ts";
import { PlatformClient } from "../../src/core/platform-client.ts";
import { onboardAndFund, transferToCustomer, chargeCustomer, waitSettled, balanceOf, depositAndWait } from "../../src/core/platform.ts";
import { say, usd } from "../../src/core/narrate.ts";
import { explain } from "../../src/core/llm.ts";
import { requestApproval, assertApproved, type Terms } from "../../src/core/approval.ts";
import { auditPath } from "../../src/core/audit.ts";
import { rationBridges, DEFAULT_BRIDGE_POLICY as P, type BridgeRequest } from "./policy.ts";
import { CUSTOMERS, CARD_CONTROLS, MONTHLY_FEE } from "./fixtures.ts";

const awx = new PlatformClient();

async function spend(acct: string, cardId: string, amount: number, mcc: string, merchant: string) {
  const tx = await awx.post("/simulation/issuing/create", { card_id: cardId, transaction_amount: amount, transaction_currency: "USD", merchant_category_code: mcc, merchant_info: merchant, single_phase: true }, { onBehalfOf: acct });
  if (tx.airwallex_failure_reason) say.step(`Airwallex declined the authorization (${tx.airwallex_failure_reason}): the card limit mirrors the customer's wallet`);
  return tx.failure_reason ?? (tx.status === "FAILED" ? "FAILED" : "APPROVED");
}

say.title("Kit 5 · Platform Spend Controller — card platform for three small businesses");
say.beat("goal", `Keep customers' card payments working without risking more than ${usd(P.capital - P.reserveFloor)} of bridge capital.`);

say.beat("setup", "Open three connected accounts, fund their wallets, issue a card on each customer's behalf.");
const accts: Record<string, { id: string; card: string; name: string }> = {};
for (const c of CUSTOMERS) {
  const a = await onboardAndFund(awx, c.spec, c.initialDeposit);
  const holder = await awx.post("/issuing/cardholders/create", { type: "DELEGATE", email: c.spec.email }, { onBehalfOf: a.id });
  const card = await awx.post("/issuing/cards/create", { request_id: newRequestId(), cardholder_id: holder.cardholder_id, is_personalized: false, form_factor: "VIRTUAL", program: { purpose: "COMMERCIAL" }, created_by: "Platform", authorization_controls: CARD_CONTROLS }, { onBehalfOf: a.id });
  accts[c.key] = { id: a.id, card: card.card_id, name: c.spec.name };
  say.step(`${c.spec.name}: ${a.id} ${a.status} · wallet ${usd(await balanceOf(awx, a.id))} · card ${card.card_id.slice(0, 8)}…`);
}
if (awx.mode === "emulated") await awx.fundPlatform(P.capital, "Platform bridge capital");
say.step(`platform bridge capital: ${usd(P.capital)}, floor ${usd(P.reserveFloor)}${awx.mode === "emulated" ? ` · platform wallet ${usd(await balanceOf(awx, undefined))}` : " (envelope on the live platform wallet)"}`);

say.beat("spend", "Customers use their cards; the platform's controls apply to every card.");
const acme = CUSTOMERS[0]!;
say.step(`${acme.spec.name} pays ${acme.cardPayment.merchant} ${usd(acme.cardPayment.amount)} → ${await spend(accts.ACME!.id, accts.ACME!.card, acme.cardPayment.amount, acme.cardPayment.mcc, acme.cardPayment.merchant)}`);
say.step(`${acme.spec.name} tries equipment ${usd(4000)} → ${await spend(accts.ACME!.id, accts.ACME!.card, 4000, "5111", "RESTAURANT DEPOT")} (per-transaction limit ${usd(3500)})`);

say.beat("new information", "Two customers' deposits are late, and both have a card payment due today.");
const requests: BridgeRequest[] = [];
for (const c of CUSTOMERS.filter((x) => x.key !== "ACME")) {
  const balance = await balanceOf(awx, accts[c.key]!.id);
  requests.push({ customer: c.key, dueToday: c.cardPayment.amount, balance, ...c.bridge });
  say.step(`${c.spec.name}: due today ${usd(c.cardPayment.amount)} to ${c.cardPayment.merchant}, wallet ${usd(balance)}, expected deposit ${usd(c.bridge.expectedDeposit)} (${c.bridge.evidence.toLowerCase().replace("_", " ")}, ${Math.round(c.bridge.onTimeRate * 100)}% on time${c.bridge.priorLateRepayment ? ", repaid a past bridge late" : ""})`);
}
const plan = rationBridges(requests);
say.table(plan.decisions.map((d) => ({ customer: d.customer, shortfall: d.shortfall, repay_p: d.repayProbability, action: d.action, bridge: d.amount })));
for (const d of plan.decisions) say.decision(d.customer, d.action, await explain({ ...d }, d.reason));
say.step(`bridge capital: ${usd(plan.available)} available → ${usd(plan.remaining)} left`);

say.beat("act", "Bridge the chosen customer, then let today's card payments run.");
for (const d of plan.decisions.filter((x) => x.action === "BRIDGE" || x.action === "BRIDGE_WITH_APPROVAL")) {
  const a = accts[d.customer]!;
  const terms: Terms = { action: "BRIDGE_ADVANCE", amount: d.amount, currency: "USD", counterparty: a.name, account: a.id, repay_from: "next deposit" };
  if (d.action === "BRIDGE_WITH_APPROVAL") assertApproved(terms, await requestApproval(terms, `Advance ${usd(d.amount)} of platform capital to ${a.name}?`));
  const t = await transferToCustomer(awx, { to: a.id, amount: d.amount, currency: "USD", reason: "business_expenses", reference: `BRIDGE-${d.customer}` });
  say.ok(`bridged ${a.name} ${usd(d.amount)} → ${t.status} → ${await waitSettled(awx, "connected_account_transfers", t.id)}`);
}
for (const c of CUSTOMERS.filter((x) => x.key !== "ACME")) {
  const a = accts[c.key]!;
  const d = plan.decisions.find((x) => x.customer === c.key)!;
  const outcome = await spend(a.id, a.card, c.cardPayment.amount, c.cardPayment.mcc, c.cardPayment.merchant);
  const expected = d.amount > 0 || d.action === "NOT_NEEDED" ? "APPROVED" : "INSUFFICIENT_FUNDS";
  say[outcome === expected ? "ok" : "fail"](`${a.name} pays ${c.cardPayment.merchant} ${usd(c.cardPayment.amount)} → ${outcome} (expected ${expected})`);
  if (outcome === "INSUFFICIENT_FUNDS") say.warn(`notify ${a.name}: payment declined, wallet ${usd(await balanceOf(awx, a.id))}; offer to split the payment or top up today`);
}

say.beat("new information", "Bluefin Studio's late deposit lands.");
const bluefin = CUSTOMERS.find((c) => c.key === "BLUEFIN")!;
const ga = (await awx.get("/global_accounts", { onBehalfOf: accts.BLUEFIN!.id })).items[0];
await depositAndWait(awx, accts.BLUEFIN!.id, ga.id, bluefin.lateDeposit, "Client payment");
say.step(`${bluefin.spec.name} wallet now ${usd(await balanceOf(awx, accts.BLUEFIN!.id))}`);

say.beat("collect", "Recover the bridge and charge each customer the monthly platform fee.");
for (const d of plan.decisions.filter((x) => x.amount > 0)) {
  const a = accts[d.customer]!;
  const bal = await balanceOf(awx, a.id);
  if (bal < d.amount) {
    say.warn(`${a.name} holds ${usd(bal)} < bridge ${usd(d.amount)}: recording a receivable instead of a charge that would fail`);
    continue;
  }
  const ch = await chargeCustomer(awx, { from: a.id, amount: d.amount, currency: "USD", reason: "professional_business_services", reference: `BRIDGE-REPAY-${d.customer}` });
  say.ok(`bridge repaid by ${a.name}: ${usd(d.amount)} → ${await waitSettled(awx, "charges", ch.id)}`);
}
for (const c of CUSTOMERS) {
  const a = accts[c.key]!;
  const bal = await balanceOf(awx, a.id);
  if (bal < MONTHLY_FEE) {
    say.warn(`${a.name} holds ${usd(bal)}: fee deferred, receivable recorded`);
    continue;
  }
  const ch = await chargeCustomer(awx, { from: a.id, amount: MONTHLY_FEE, currency: "USD", reason: "professional_business_services", reference: "PLATFORM-FEE-2026-10" });
  say.step(`fee ${usd(MONTHLY_FEE)} from ${a.name} → ${await waitSettled(awx, "charges", ch.id)}`);
}

say.beat("result", awx.mode === "emulated" ? "Balances (platform rail EMULATED on this account)." : "Balances read back from Airwallex.");
const rows = [];
for (const c of CUSTOMERS) rows.push({ account: accts[c.key]!.name, wallet_usd: await balanceOf(awx, accts[c.key]!.id) });
if (awx.mode === "emulated") rows.push({ account: "Platform", wallet_usd: await balanceOf(awx, undefined) });
say.table(rows);
say.ok(`bridged ${plan.decisions.filter((d) => d.amount > 0).map((d) => d.customer).join(", ")}; declined ${plan.decisions.filter((d) => d.action === "DECLINE").map((d) => d.customer).join(", ")}; fees collected ${usd(MONTHLY_FEE * CUSTOMERS.length)}`);
say.step(`audit log: ${auditPath}`);
