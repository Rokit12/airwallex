import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, type DisputeFacts } from "./policy.ts";
import { CASES } from "./cases.ts";

const factsFor = (key: "A" | "B" | "C", over: Partial<DisputeFacts> = {}): DisputeFacts => {
  const c = CASES.find((x) => x.key === key)!;
  const category = ({ "10.4": "FRAUD", "13.1": "NOT_RECEIVED", "13.6": "CREDIT_NOT_PROCESSED" } as const)[c.visaReason];
  return { disputeId: `dst_${key}`, amount: c.amount, currency: c.currency, stage: c.stage, category, hoursToDeadline: c.dueInHours, evidence: c.facts, issuerRejections: 0, ...over };
};

test("A: large fraud claim with device/IP history and a signature is challenged, with approval", () => {
  const d = decide(factsFor("A"));
  assert.equal(d.action, "CHALLENGE");
  assert.equal(d.action === "CHALLENGE" && d.reason, "PURCHASE_HISTORY");
  assert.equal(d.needsApproval, true);
});

test("B: small not-received claim without signature is accepted as low value, autonomously", () => {
  const d = decide(factsFor("B"));
  assert.equal(d.action, "ACCEPT");
  assert.equal(d.action === "ACCEPT" && d.reason, "LOW_VALUE_TRANSACTION");
  assert.equal(d.needsApproval, false);
  assert.ok(d.costAccept < d.costChallenge);
});

test("C: credit not processed with unanswered support emails is escalated", () => {
  assert.equal(decide(factsFor("C")).action, "ESCALATE");
});

test("A after issuer rejection at chargeback: still worth challenging, at a lower win probability", () => {
  const first = decide(factsFor("A"));
  const second = decide(factsFor("A", { stage: "CHARGEBACK", issuerRejections: 1 }));
  assert.equal(second.action, "CHALLENGE");
  assert.ok(second.winProbability < first.winProbability);
});

test("A's evidence on a small amount flips to accept: same evidence, different economics", () => {
  assert.equal(decide(factsFor("A", { amount: 20, stage: "CHARGEBACK", issuerRejections: 2 })).action, "ACCEPT");
});

test("weak case near the deadline goes to a person", () => {
  assert.equal(decide(factsFor("B", { amount: 300, hoursToDeadline: 4 })).action, "ESCALATE");
});

import { isEvidence } from "./policy.ts";
import { screenUntrusted } from "../../src/core/untrusted.ts";

test("instructions hidden in a forwarded statement are flagged, and ordinary case notes are not", () => {
  const a = CASES.find((c) => c.key === "A")!;
  const found = screenUntrusted(a.statement!);
  assert.ok(found.length >= 3, `expected several findings, got ${JSON.stringify(found)}`);
  assert.ok(found.some((f) => /account named in the text/.test(f.why)));
  assert.ok(found.some((f) => /approval that only a person can give/.test(f.why)));
  for (const c of CASES) assert.deepEqual(screenUntrusted(c.notes), [], `case ${c.key} notes are ordinary text`);
});

test("the model can only hand back evidence fields: no amounts, accounts or actions", () => {
  const good = { priorOrdersSameDevice: 3, ipMatchesPriorOrders: true, deliveryScanned: true, deliverySigned: true, unansweredSupportContacts: 0, refundAlreadyIssued: false };
  assert.equal(isEvidence(good), true);
  assert.equal(isEvidence({ ...good, action: "ACCEPT" }), false);
  assert.equal(isEvidence({ ...good, refundTo: "GB33BUKB20201555555555" }), false);
  assert.equal(isEvidence({ ...good, deliverySigned: "yes" }), false);
});

test("the decision for the injected case comes from evidence and policy alone", () => {
  // The statement never reaches the decision: it uses the extracted evidence fields and the policy only.
  assert.equal(decide(factsFor("A")).action, "CHALLENGE");
});

import { freshEvidence } from "./policy.ts";
test("after a rejection, evidence already submitted is never sent again", () => {
  const docs = [{ id: "invoice" }, { id: "tracking" }, { id: "session-log" }];
  const sent = new Set(["invoice", "tracking"]);
  assert.deepEqual(freshEvidence(docs, sent, (d) => d.id).map((d) => d.id), ["session-log"]);
  assert.deepEqual(freshEvidence(docs.slice(0, 2), sent, (d) => d.id), [], "nothing new: escalate instead");
  assert.equal(freshEvidence([{ id: "x" }, { id: "x" }], new Set(), (d) => d.id).length, 1, "no duplicates within one submission");
});
