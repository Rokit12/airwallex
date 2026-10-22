/**
 * Kit 4 — Dispute Response Agent
 *
 * Goal: work a chargeback queue so the merchant loses as little money as possible.
 *  1. Take three card payments (test card) and stage a dispute on each.
 *  2. Read each dispute from the API, extract evidence from case notes, decide
 *     accept / challenge / escalate in policy code, and act.
 *  3. The issuer rejects the evidence on the challenged case. The agent
 *     re-prices it at chargeback stage, asks for approval of the new
 *     submission, and challenges again.
 */
process.env.KIT ??= "kit04";
import { writeFileSync } from "node:fs";
import { newRequestId } from "../../src/core/client.ts";
import { RailsClient } from "../../src/core/rails.ts";
import { Sandbox, awxTime, inHours } from "../../src/core/sandbox.ts";
import { say, usd } from "../../src/core/narrate.ts";
import { extract, explain, llmEnabled } from "../../src/core/llm.ts";
import { requestApproval, assertApproved, type Terms } from "../../src/core/approval.ts";
import { textPdf } from "../../src/core/pdf.ts";
import { auditPath } from "../../src/core/audit.ts";
import { BUSINESS } from "../../src/core/business.ts";
import { CASES, SECOND_ROUND_DOCS, type DemoCase } from "./cases.ts";
import { decide, VISA_REASON, DEFAULT_POLICY, type DisputeFacts, type Evidence, type Decision, type Stage } from "./policy.ts";

const TEST_CARD = { number: "4035501000000008", expiry_month: "12", expiry_year: "2030", cvc: "123" };

const awx = new RailsClient();
const sb = new Sandbox(awx);

// ── Payments and disputes ────────────────────────────────────────────────────
async function takePayment(c: DemoCase): Promise<string> {
  const pi = await awx.post("/pa/payment_intents/create", {
    request_id: newRequestId(),
    amount: c.amount,
    currency: c.currency,
    merchant_order_id: `${c.orderId}-${Date.now().toString(36)}`,
    descriptor: BUSINESS.tradingName.toUpperCase(),
  });
  const confirmed = await awx.post(`/pa/payment_intents/${pi.id}/confirm`, {
    request_id: newRequestId(),
    payment_method: { type: "card", card: { ...TEST_CARD, name: c.customer.name } },
    payment_method_options: { card: { auto_capture: true } },
  });
  if (!["SUCCEEDED", "REQUIRES_CAPTURE"].includes(confirmed.status)) {
    throw new Error(`Payment ${pi.id} not authorised: ${confirmed.status}`);
  }
  return pi.id;
}

async function readDispute(id: string) {
  return awx.get(`/pa/payment_disputes/${id}`);
}

function toFacts(d: any, evidence: Evidence, rejections: number): DisputeFacts {
  const code: string = d.reason?.original_code ?? d.reason_code ?? "";
  const category = VISA_REASON[code];
  if (!category) throw new Error(`Unhandled reason code ${code} on ${d.id}`);
  return {
    disputeId: d.id,
    amount: Number(d.amount),
    currency: d.currency,
    stage: d.stage as Stage,
    category,
    hoursToDeadline: (new Date(d.due_at).getTime() - Date.now()) / 3_600_000,
    evidence,
    issuerRejections: rejections,
  };
}

// ── Evidence ─────────────────────────────────────────────────────────────────
const isEvidence = (v: any): v is Evidence =>
  v && typeof v.priorOrdersSameDevice === "number" && ["ipMatchesPriorOrders", "deliveryScanned", "deliverySigned", "refundAlreadyIssued"].every((k) => typeof v[k] === "boolean") && typeof v.unansweredSupportContacts === "number";

async function readEvidence(c: DemoCase): Promise<Evidence> {
  const { value, source } = await extract(
    `Extract dispute evidence as JSON with exactly these keys:
priorOrdersSameDevice (number of earlier undisputed orders from the same device),
ipMatchesPriorOrders (boolean), deliveryScanned (boolean), deliverySigned (boolean),
unansweredSupportContacts (number of customer contacts with no reply), refundAlreadyIssued (boolean).`,
    c.notes,
    isEvidence,
    () => c.facts,
  );
  const diff = Object.keys(c.facts).filter((k) => (value as any)[k] !== (c.facts as any)[k]);
  say.step(`evidence read by ${source}${diff.length ? ` (differs from ledger on: ${diff.join(", ")} — using ledger)` : ""}`);
  return diff.length ? c.facts : value; // ledger facts win over a model misread
}

async function uploadDocs(docs: DemoCase["documents"]) {
  const out: { type: string; description: string; file_ids: string[] }[] = [];
  for (const d of docs) {
    const { file_id } = await awx.uploadFile(d.name, textPdf(d.title, d.lines), "application/pdf", d.title);
    say.step(`uploaded ${d.name} → ${file_id}`);
    out.push({ type: d.type, description: d.title, file_ids: [file_id] });
  }
  return out;
}

// ── Actions ──────────────────────────────────────────────────────────────────
function termsFor(c: DemoCase, f: DisputeFacts, dec: Decision, evidenceFiles: string[] = []): Terms {
  return {
    action: `${dec.action}_DISPUTE`,
    amount: f.amount,
    currency: f.currency,
    counterparty: `${c.customer.name} / issuer`,
    dispute: f.disputeId,
    stage: f.stage,
    reason: "reason" in dec ? dec.reason : "n/a",
    evidence: evidenceFiles,
  };
}

async function accept(c: DemoCase, f: DisputeFacts, dec: Extract<Decision, { action: "ACCEPT" }>) {
  const terms = termsFor(c, f, dec);
  const approval = dec.needsApproval ? await requestApproval(terms, `Accept ${usd(f.amount)} dispute ${f.disputeId}?`) : { termsHash: "", approvedBy: "policy:auto", at: "" };
  if (dec.needsApproval) assertApproved(terms, approval);
  const res = await awx.post(`/pa/payment_disputes/${f.disputeId}/accept`, {
    request_id: newRequestId(),
    accepted_by: dec.needsApproval ? approval!.approvedBy : "dispute-agent",
    reason: dec.reason,
    description: dec.rationale.slice(0, 200),
    ...(f.stage === "RFI" ? { refund: { amount: f.amount, reason: "REQUESTED_BY_CUSTOMER" } } : {}),
  });
  say.ok(`accepted ${f.disputeId} (${dec.reason}) → status ${res.status}`);
}

async function challenge(c: DemoCase, f: DisputeFacts, dec: Extract<Decision, { action: "CHALLENGE" }>, docs: DemoCase["documents"]) {
  const documents = await uploadDocs(docs);
  const fileIds = documents.flatMap((d) => d.file_ids);
  const terms = termsFor(c, f, dec, fileIds);
  let approval = null;
  if (dec.needsApproval) {
    approval = await requestApproval(terms, `Submit challenge on ${usd(f.amount)} dispute ${f.disputeId} with ${fileIds.length} evidence file(s)?`);
    assertApproved(terms, approval); // binds approval to this stage, reason and these exact files
  }
  const chargeback = f.stage === "CHARGEBACK" || f.stage === "PRE_ARBITRATION";
  const body: Record<string, unknown> = {
    request_id: newRequestId(),
    challenged_by: approval?.approvedBy ?? "dispute-agent",
    reason: dec.reason,
    delivery_info: {
      shipping_company: "UPS",
      tracking_number: "1Z999AA10123456784",
      shipped_at: "2026-09-30T10:00:00Z",
      delivered_at: "2026-10-02T14:12:00Z",
      ...(chargeback ? {} : { status: "DELIVERED", address: c.customer.address, name: c.customer.name, shipping_method: "Ground" }),
    },
    supporting_documents: { documents },
  };
  if (chargeback) {
    Object.assign(body, {
      product_type: "PHYSICAL_GOODS",
      customer_info: { name: c.customer.name, email: c.customer.email, ip: c.customer.ip, device_id: c.customer.deviceId, billing_address: c.customer.address },
      refund_refusal_reason: "Cardholder placed the order from a known device after 2FA and signed for delivery; not eligible for a fraud refund.",
    });
  } else {
    body.seller_info = { name: BUSINESS.name, store_name: BUSINESS.tradingName, store_url: BUSINESS.storeUrl, store_physical_address: `${BUSINESS.address.street_address}, ${BUSINESS.address.city}, ${BUSINESS.address.state} ${BUSINESS.address.postcode}, ${BUSINESS.countryName}` };
  }
  const res = await awx.post(`/pa/payment_disputes/${f.disputeId}/challenge`, body);
  say.ok(`challenged ${f.disputeId} (${dec.reason}, ${fileIds.length} files) → status ${res.status}`);
}

function escalateToPerson(c: DemoCase, f: DisputeFacts, dec: Decision) {
  const ticket = {
    dispute: f.disputeId,
    order: c.orderId,
    amount: f.amount,
    currency: f.currency,
    due_in_hours: Math.round(f.hoursToDeadline),
    why: dec.rationale,
    suggested: "Refund the returned item and reply to the customer; then accept the dispute as AGREEMENT_REACHED_WITH_CUSTOMER.",
    notes: c.notes,
  };
  writeFileSync(`runs/escalation-${f.disputeId}.json`, JSON.stringify(ticket, null, 2));
  say.warn(`escalated ${f.disputeId} to a person → runs/escalation-${f.disputeId}.json (no API action taken)`);
}

// ── Main ─────────────────────────────────────────────────────────────────────
say.title(`Kit 4 · Dispute Response Agent — ${BUSINESS.tradingName} chargeback queue`);
say.beat("goal", "Clear three disputes before their deadlines while losing as little money as possible.");
say.step(`policy: chargeback fee ${usd(DEFAULT_POLICY.chargebackFee)}, response cost ${usd(DEFAULT_POLICY.responseCost)}, auto-accept ≤ ${usd(DEFAULT_POLICY.autoAcceptLimit)}, auto-challenge ≤ ${usd(DEFAULT_POLICY.autoChallengeLimit)}`);
say.step(`model: ${llmEnabled() ? "Claude reads notes and explains decisions" : "rules only (set ANTHROPIC_API_KEY to let Claude read the notes)"}`);

say.beat("setup", "Taking three card payments and staging a dispute on each (sandbox simulation).");
const staged: { c: DemoCase; disputeId: string }[] = [];
for (const c of CASES) {
  const piId = await takePayment(c);
  const d = await sb.createDispute({
    payment_intent_id: piId,
    stage: c.stage,
    reason_code: c.visaReason,
    due_at: awxTime(inHours(c.dueInHours)),
    comment: c.label,
  });
  say.step(`${c.key}: ${usd(c.amount)} payment ${piId} → dispute ${d.id} (${c.visaReason}, ${c.stage})`);
  staged.push({ c, disputeId: d.id });
}

say.beat("plan", "Reading each dispute from Airwallex, pricing it, and deciding.");
const facts = new Map<string, DisputeFacts>();
const decisions = new Map<string, Decision>();
for (const { c, disputeId } of staged.sort((a, b) => a.c.dueInHours - b.c.dueInHours)) {
  const d = await readDispute(disputeId);
  say.step(`${c.key} ${disputeId}: ${usd(Number(d.amount))}, reason ${d.reason?.original_code}, stage ${d.stage}, status ${d.status}, due ${d.due_at}`);
  const f = toFacts(d, await readEvidence(c), 0);
  const dec = decide(f);
  facts.set(c.key, f);
  decisions.set(c.key, dec);
  say.decision(`${c.key} ${c.label}`, dec.action + ("reason" in dec ? ` (${dec.reason})` : ""), await explain({ case: c.label, ...dec }, dec.rationale));
}
say.table(
  [...decisions.entries()].map(([k, d]) => ({ case: k, action: d.action, win_p: d.winProbability, cost_accept: d.costAccept, cost_challenge: d.costChallenge, approval: d.needsApproval })),
);

say.beat("act", "Executing decisions.");
for (const { c } of staged) {
  const f = facts.get(c.key)!;
  const dec = decisions.get(c.key)!;
  if (dec.action === "ACCEPT") await accept(c, f, dec);
  else if (dec.action === "CHALLENGE") await challenge(c, f, dec, c.documents);
  else escalateToPerson(c, f, dec);
}

const challenged = staged.find(({ c }) => decisions.get(c.key)?.action === "CHALLENGE");
if (challenged) {
  const { c, disputeId } = challenged;
  say.beat("new information", `Issuer rejects the evidence on ${c.key} and moves it to chargeback (sandbox simulation).`);
  await sb.escalateDispute(disputeId, {
    due_at: awxTime(inHours(48)),
    comment: "Evidence insufficient: provide proof the cardholder authorised the transaction.",
  });
  const d = await readDispute(disputeId);
  say.step(`${disputeId}: stage ${d.stage}, status ${d.status}, issuer says: "${d.issuer_comment ?? "(none)"}"`);

  const f2 = toFacts(d, c.facts, 1);
  const dec2 = decide(f2);
  const before = decisions.get(c.key)!;
  say.decision(
    `${c.key} after rejection`,
    dec2.action + ("reason" in dec2 ? ` (${dec2.reason})` : ""),
    `win p ${before.winProbability} → ${dec2.winProbability}; chargeback fee now certain; challenge ${dec2.costChallenge} vs accept ${dec2.costAccept}.`,
  );
  if (dec2.action === "CHALLENGE") {
    await challenge(c, f2, dec2, [...c.documents, ...SECOND_ROUND_DOCS]);
    await sb.resolveDispute(disputeId, { in_favor_of: "MERCHANT", comment: "Cardholder authentication and delivery signature accepted." });
  } else if (dec2.action === "ACCEPT") await accept(c, f2, dec2);
  else escalateToPerson(c, f2, dec2);
}

say.beat("result", awx.mode.payments === "emulated" ? "Final state read back (card payments EMULATED on this account)." : "Final state read back from Airwallex.");
const rows = [];
for (const { c, disputeId } of staged) {
  const d = await readDispute(disputeId);
  rows.push({ case: c.key, dispute: disputeId, amount: Number(d.amount), stage: d.stage, status: d.status });
}
say.table(rows);
const disputed = CASES.reduce((s, c) => s + c.amount, 0);
const kept = rows.filter((r) => r.status === "WON" || r.status === "REVERSED").reduce((s, r) => s + r.amount, 0);
say.ok(`disputed ${usd(disputed)} · recovered ${usd(kept)} · escalated ${CASES.filter((c) => decisions.get(c.key)?.action === "ESCALATE").map((c) => c.key).join(", ") || "none"}`);
say.step(`audit log: ${auditPath}`);
