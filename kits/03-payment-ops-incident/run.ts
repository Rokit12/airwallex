/**
 * Kit 3 — Payment Ops Incident Commander
 *
 * Goal: a supplier says invoice INV-20931 (USD 4,800) never arrived and their
 * deadline has passed. Get them paid exactly once.
 *  1. The original transfer is SENT and late. The agent traces it rather than
 *     resending, and flags the supplier's emailed bank-detail change as a fraud risk.
 *  2. The bank returns the payment. The agent reads the failure type: the old
 *     routing was wrong, so a resend to the same account would fail again.
 *  3. A person verifies the new details by call-back and approves the exact
 *     replacement. The agent pays under a duplicate lock and proves that a
 *     restart cannot pay a second time.
 */
import { writeFileSync } from "node:fs";
import { AirwallexClient, AwxError, newRequestId } from "../../src/core/client.ts";
import { Sandbox } from "../../src/core/sandbox.ts";
import { say, usd } from "../../src/core/narrate.ts";
import { extract, explain, llmEnabled } from "../../src/core/llm.ts";
import { requestApproval, assertApproved, type Terms } from "../../src/core/approval.ts";
import { acquire, update, readLock, resetLock } from "../../src/core/lock.ts";
import { auditPath } from "../../src/core/audit.ts";
import { decideIncident, isFinal, type IncidentFacts } from "./policy.ts";
import { SUPPLIER, OLD_BANK, NEW_BANK, SUPPLIER_EMAIL, INVOICE, EMAIL_FALLBACK, type EmailFacts } from "./fixtures.ts";

const awx = new AirwallexClient();
const sb = new Sandbox(awx);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The scenario starts three days after the original payment went out. */
const SCENARIO_AGE_HOURS = Number(process.env.SCENARIO_AGE_HOURS ?? 72);
const startedAt = Date.now();
/**
 * Payment reference = invoice number. Sandbox reruns add a short run tag so a
 * previous run's PAID transfer doesn't (correctly) block this one as a duplicate.
 */
const REF = process.env.INVOICE_REF ?? `${INVOICE.id}-${Date.now().toString(36).slice(-4).toUpperCase()}`;
const ageHours = () => SCENARIO_AGE_HOURS + (Date.now() - startedAt) / 3_600_000;

async function createBeneficiary(bank: typeof OLD_BANK) {
  const ben = await awx.post("/beneficiaries/create", {
    request_id: newRequestId(),
    transfer_methods: ["LOCAL"],
    nickname: `${SUPPLIER.name} ${bank.label}`.slice(0, 40),
    beneficiary: {
      entity_type: "COMPANY",
      company_name: SUPPLIER.name,
      address: SUPPLIER.address,
      bank_details: {
        account_currency: "USD",
        account_name: SUPPLIER.name,
        account_number: bank.accountNumber,
        account_routing_type1: "aba",
        account_routing_value1: bank.routing,
        bank_country_code: "US",
        bank_account_category: "Checking",
        local_clearing_system: "ACH",
      },
    },
  });
  return ben.id ?? ben.beneficiary_id;
}

/** Create a payout under the invoice lock. The lock is written before the call. */
async function payInvoice(beneficiaryId: string, note: string) {
  const requestId = newRequestId();
  acquire(REF, requestId, note);
  try {
    const tr = await awx.post("/transfers/create", {
      request_id: requestId,
      beneficiary_id: beneficiaryId,
      transfer_amount: String(INVOICE.amount),
      transfer_currency: "USD",
      source_currency: "USD",
      transfer_method: "LOCAL",
      reference: REF,
      reason: "freight",
    });
    update(REF, requestId, { transferId: tr.id, state: "IN_FLIGHT" });
    return { requestId, transfer: tr };
  } catch (err) {
    // Outcome unknown: leave the lock in INTENT so nothing else pays until someone checks Airwallex for this request_id.
    update(REF, requestId, { note: `create failed: ${(err as Error).message}` });
    throw err;
  }
}

/** Every transfer Airwallex has for this invoice, matched on our reference. */
async function attemptsOnInvoice(): Promise<any[]> {
  const res = await awx.get("/transfers", { query: { page_size: 100 } });
  return (res.items ?? []).filter((t: any) => t.reference === REF);
}

async function facts(originalId: string, email: EmailFacts, verified: boolean, knownFailureType?: string): Promise<IncidentFacts> {
  const original = await awx.get(`/transfers/${originalId}`);
  const others = (await attemptsOnInvoice()).filter((t) => t.id !== originalId);
  return {
    invoice: INVOICE.id,
    amount: INVOICE.amount,
    currency: "USD",
    original: { status: original.status, failureType: original.failure_type ?? knownFailureType, hoursSinceCreated: ageHours() },
    otherAttempts: others.map((t) => ({ status: t.status })),
    expectedSettlementHours: 24,
    supplierDeadlinePassed: email.deadlinePassed,
    newBankDetailsRequested: Boolean(email.newRouting && email.newAccount),
    newDetailsVerified: verified,
  };
}

const isEmailFacts = (v: any): v is EmailFacts =>
  v && typeof v.invoice === "string" && typeof v.amountClaimed === "number" && typeof v.deadlinePassed === "boolean" && (v.newRouting === null || typeof v.newRouting === "string") && (v.newAccount === null || typeof v.newAccount === "string");

// ── Main ─────────────────────────────────────────────────────────────────────
say.title(`Kit 3 · Payment Ops Incident Commander — ${INVOICE.id}, ${SUPPLIER.name}`);
say.beat("goal", `Get ${SUPPLIER.name} paid ${usd(INVOICE.amount)} for ${INVOICE.id} exactly once.`);
say.step(`model: ${llmEnabled() ? "Claude reads the supplier's email" : "rules only (set ANTHROPIC_API_KEY to let Claude read the email)"}`);
resetLock(REF);
const startBalance = await sb.ensureUsd(INVOICE.amount * 3);

say.beat("setup", `Recreate the original payment: sent ${SCENARIO_AGE_HOURS}h ago, now SENT and unconfirmed.`);
const oldBen = await createBeneficiary(OLD_BANK);
const { transfer: original } = await payInvoice(oldBen, "original");
await sb.transferTransition(original.id, "SENT");
say.step(`original ${original.id}: ${usd(INVOICE.amount)} LOCAL/ACH to routing ${OLD_BANK.routing}, fee ${usd(original.fee_amount ?? 0)} → SENT`);

say.beat("incident", "Supplier email arrives.");
say.document(SUPPLIER_EMAIL);
const { value: email, source } = await extract(
  "Extract JSON: invoice (string), amountClaimed (number), deadlinePassed (boolean), newRouting (string or null), newAccount (string or null).",
  SUPPLIER_EMAIL,
  isEmailFacts,
  () => EMAIL_FALLBACK,
);
say.step(`email read by ${source}: invoice ${email.invoice}, ${usd(email.amountClaimed)}, deadline passed: ${email.deadlinePassed}, new bank details: ${email.newRouting ? `routing ${email.newRouting}` : "none"}`);
if (email.invoice !== INVOICE.id || email.amountClaimed !== INVOICE.amount) {
  say.warn("email does not match the invoice on file — stopping for a person");
  process.exit(0);
}

say.beat("plan", "Read the original from Airwallex and decide.");
let f = await facts(original.id, email, false);
let d = decideIncident(f);
say.step(`original status ${f.original.status} after ${Math.round(f.original.hoursSinceCreated)}h; other transfers with reference ${REF}: ${f.otherAttempts.length}`);
say.decision("incident", d.action, await explain({ ...d }, d.rationale));
d.warnings.forEach((w) => say.warn(w));
writeFileSync(
  `runs/trace-${INVOICE.id}.json`,
  JSON.stringify({ ask: "Request a bank trace on this ACH payout", transfer: original.id, amount: INVOICE.amount, routing: OLD_BANK.routing, reply_to_supplier: "Payment is in flight; we are tracing it with the bank and will not resend until it is confirmed returned. Bank-detail changes are verified by phone." }, null, 2),
);
say.step(`trace request for a person → runs/trace-${INVOICE.id}.json`);

say.beat("new information", "The receiving bank returns the payment (sandbox simulation).");
const failedEvent = await sb.transferTransition(original.id, "FAILED", "BENEFICIARY_BANK_RETURNED");
// Airwallex auto-cancels within seconds and the read can lose failure_reason, so keep it from the event.
const failureType: string = failedEvent.failure_type ?? "BENEFICIARY_BANK_RETURNED";
say.step(`payout.transfer.failed: ${failedEvent.failure_reason} (type ${failureType})`);
let status = "";
for (let i = 0; i < 10 && !isFinal(status); i++) {
  status = (await awx.get(`/transfers/${original.id}`)).status;
  if (!isFinal(status)) await sleep(1000);
}
say.step(`original now ${status} — final; the money did not go and will not go`);
update(REF, readLock(REF).attempts[0]!.requestId, { state: "FAILED", note: failureType });

f = await facts(original.id, email, false, failureType);
d = decideIncident(f);
say.decision("incident", d.action, await explain({ ...d }, d.rationale));

say.beat("approval", "A person verifies the new account by call-back and approves the exact replacement.");
const terms: Terms = {
  action: "REPLACE_SUPPLIER_PAYMENT",
  amount: INVOICE.amount,
  currency: "USD",
  counterparty: SUPPLIER.name,
  invoice: INVOICE.id,
  routing: NEW_BANK.routing,
  account: `****${NEW_BANK.accountNumber.slice(-4)}`,
  verified_by_callback_to: SUPPLIER.phoneOnFile,
};
const approval = await requestApproval(terms, `Confirm you called ${SUPPLIER.phoneOnFile} (number on file, not from the email) and the supplier confirmed these details.`);
if (!approval) {
  say.warn("not verified — no replacement sent; incident stays open");
  process.exit(0);
}
f = await facts(original.id, email, true, failureType);
d = decideIncident(f);
say.decision("incident", d.action, d.rationale);
if (d.action !== "REPLACE_NEW_DETAILS") process.exit(0);
assertApproved(terms, approval);

const newBen = await createBeneficiary(NEW_BANK);
const { requestId: replReq, transfer: repl } = await payInvoice(newBen, "replacement, details verified by call-back");
say.ok(`replacement ${repl.id}: ${usd(INVOICE.amount)} to routing ${NEW_BANK.routing} (new request id)`);

say.beat("restart", "Simulate the agent restarting and re-running the replace step.");
const f2 = await facts(original.id, email, true, failureType);
const d2 = decideIncident(f2);
say.decision("rerun", d2.action, d2.rationale);
try {
  acquire(REF, newRequestId(), "rerun");
  say.fail("lock allowed a second payment — this should not happen");
} catch (err) {
  say.ok(`invoice lock refused: ${(err as Error).message}`);
}
try {
  const again = await awx.post("/transfers/create", {
    request_id: replReq, // same request id as the replacement: Airwallex must not create a second transfer
    beneficiary_id: newBen, transfer_amount: String(INVOICE.amount), transfer_currency: "USD", source_currency: "USD", transfer_method: "LOCAL", reference: REF, reason: "freight",
  });
  say.ok(`retry with the same request id returned ${again.id === repl.id ? "the same transfer" : `transfer ${again.id}`}`);
} catch (err) {
  say.ok(`retry with the same request id rejected by Airwallex: ${err instanceof AwxError ? err.code : err}`);
}

say.beat("settle", "Replacement clears (sandbox simulation).");
await sb.transferTransition(repl.id, "SENT");
try {
  await sb.transferTransition(repl.id, "PAID");
} catch (err) {
  // The sandbox can answer 500 here and still apply the change: an error is unconfirmed, so re-read before deciding anything.
  say.warn(`PAID transition answered ${(err as Error).message.split(" (")[0]} — reading the transfer to confirm`);
}
let replFinal = await awx.get(`/transfers/${repl.id}`);
for (let i = 0; i < 10 && !isFinal(replFinal.status); i++) {
  await sleep(1500);
  replFinal = await awx.get(`/transfers/${repl.id}`);
}
update(REF, replReq, { state: replFinal.status === "PAID" ? "PAID" : "IN_FLIGHT" });
say.step(`replacement ${repl.id} → ${replFinal.status}`);

say.beat("result", "Close the incident only with both outcomes recorded.");
const all = await attemptsOnInvoice();
say.table(all.map((t) => ({ transfer: t.id, amount: t.amount_beneficiary_receives ?? t.transfer_amount, status: t.status, routing: t.beneficiary?.bank_details?.account_routing_value1 ?? "", created: t.created_at })));
const paid = all.filter((t) => t.status === "PAID").length;
const endBalance = await sb.available("USD");
const report = {
  invoice: INVOICE.id,
  reference: REF,
  supplier: SUPPLIER.name,
  original: { transfer: original.id, outcome: status, failure: failureType, reason: failedEvent.failure_reason },
  replacement: { transfer: repl.id, outcome: replFinal.status, approved_by: approval.approvedBy, verification: `call-back to ${SUPPLIER.phoneOnFile}` },
  times_paid: paid,
  wallet_change: Math.round((endBalance - startBalance) * 100) / 100,
};
writeFileSync(`runs/incident-${INVOICE.id}.json`, JSON.stringify(report, null, 2));
say[paid === 1 ? "ok" : "fail"](`${INVOICE.id} paid ${paid}× · wallet change ${usd(report.wallet_change)} (one payment plus fees; the returned payment came back) · report runs/incident-${INVOICE.id}.json`);
say.step(`audit log: ${auditPath}`);
