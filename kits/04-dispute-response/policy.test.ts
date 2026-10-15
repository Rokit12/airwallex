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
