import { test } from "node:test";
import assert from "node:assert/strict";
import { assertApproved, hashTerms, separateApprover, PROPOSER, type Terms } from "./approval.ts";

const terms: Terms = { action: "BOOK_FX", amount: 6512.85, currency: "EUR", counterparty: "Airwallex FX" };

test("an approval must come from someone other than the proposing agent", () => {
  assert.equal(separateApprover("operator"), true);
  assert.equal(separateApprover("Robinson"), true);
  for (const who of [PROPOSER, "Agent", "agent:kit-04", "AI assistant", "model", "", "policy:auto"]) assert.equal(separateApprover(who), false, who);
  assert.throws(() => assertApproved(terms, { termsHash: hashTerms(terms), approvedBy: PROPOSER, at: "" }), /cannot approve it/);
  assert.doesNotThrow(() => assertApproved(terms, { termsHash: hashTerms(terms), approvedBy: "operator", at: "" }));
});

test("an approval covers exactly the terms that were shown", () => {
  const approval = { termsHash: hashTerms(terms), approvedBy: "operator", at: "" };
  assert.throws(() => assertApproved({ ...terms, amount: 6600 }, approval), /terms changed after approval/);
});
