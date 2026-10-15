import { test } from "node:test";
import assert from "node:assert/strict";
import { decideIncident, type IncidentFacts } from "./policy.ts";

const base: IncidentFacts = {
  invoice: "INV-20931",
  amount: 4800,
  currency: "USD",
  original: { status: "SENT", hoursSinceCreated: 72 },
  otherAttempts: [],
  expectedSettlementHours: 24,
  supplierDeadlinePassed: true,
  newBankDetailsRequested: true,
  newDetailsVerified: false,
};

test("late but in flight: trace, never replace, and flag the bank-detail change", () => {
  const d = decideIncident(base);
  assert.equal(d.action, "TRACE");
  assert.equal(d.warnings.length, 1);
});

test("in flight and on time: wait", () => {
  assert.equal(decideIncident({ ...base, original: { status: "SENT", hoursSinceCreated: 10 } }).action, "WAIT");
});

test("original arrived: close with proof", () => {
  assert.equal(decideIncident({ ...base, original: { status: "PAID", hoursSinceCreated: 72 } }).action, "CLOSE_PAID");
});

test("returned for bad routing with unverified new details: verify first", () => {
  const d = decideIncident({ ...base, original: { status: "CANCELLED", failureType: "INCORRECT_ROUTING", hoursSinceCreated: 74 } });
  assert.equal(d.action, "VERIFY_NEW_DETAILS");
  assert.equal(d.needsApproval, true);
});

test("returned for bad routing, details verified: replace with approval", () => {
  const d = decideIncident({ ...base, newDetailsVerified: true, original: { status: "CANCELLED", failureType: "INCORRECT_ROUTING", hoursSinceCreated: 74 } });
  assert.equal(d.action, "REPLACE_NEW_DETAILS");
  assert.equal(d.needsApproval, true);
});

test("returned for bad routing with no new details: ask the supplier", () => {
  assert.equal(decideIncident({ ...base, newBankDetailsRequested: false, original: { status: "CANCELLED", failureType: "INCORRECT_ROUTING", hoursSinceCreated: 74 } }).action, "ASK_SUPPLIER");
});

test("transient failure on a small amount: resend automatically", () => {
  const d = decideIncident({ ...base, amount: 600, newBankDetailsRequested: false, original: { status: "CANCELLED", failureType: "CHANNEL_TIMEOUT", hoursSinceCreated: 30 } });
  assert.equal(d.action, "REPLACE_SAME_DETAILS");
  assert.equal(d.needsApproval, false);
});

test("a replacement already in flight blocks any further payment", () => {
  const d = decideIncident({ ...base, newDetailsVerified: true, original: { status: "CANCELLED", failureType: "INCORRECT_ROUTING", hoursSinceCreated: 74 }, otherAttempts: [{ status: "SENT" }] });
  assert.equal(d.action, "BLOCK_DUPLICATE");
});

test("unrecognised failure type with new details offered: verify, never auto-resend", () => {
  const d = decideIncident({ ...base, original: { status: "CANCELLED", failureType: "SOMETHING_NEW", hoursSinceCreated: 74 } });
  assert.equal(d.action, "VERIFY_NEW_DETAILS");
  assert.equal(d.needsApproval, true);
});
