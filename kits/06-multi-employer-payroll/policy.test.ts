import { test } from "node:test";
import assert from "node:assert/strict";
import { price, planEmployer, naivePooledCheck } from "./policy.ts";
import { EMPLOYERS } from "./fixtures.ts";

const rates = { USD: 1, EUR: 1.13, GBP: 1.34 };
const plan = (k: string, bal?: number) => {
  const e = EMPLOYERS.find((x) => x.key === k)!;
  return planEmployer(e.key, bal ?? e.deposit, price(e.contractors, rates));
};

test("SWIFT fees are priced before converting", () => {
  const l = price(EMPLOYERS[0]!.contractors, rates)[0]!;
  assert.equal(l.needed, 4012.85);
});

test("Atlas covers its own payroll", () => {
  assert.equal(plan("ATLAS").action, "PAY_ALL");
});

test("Beacon is short: pay Kai in full, hold Marta, request a platform advance", () => {
  const p = plan("BEACON");
  assert.equal(p.action, "PAY_PARTIAL_AND_REQUEST_ADVANCE");
  assert.deepEqual(p.pay.map((x) => x.name), ["Kai Chen"]);
  assert.deepEqual(p.hold.map((x) => x.name), ["Marta Silva"]);
  assert.ok(p.shortfall > 0 && p.shortfall <= 1000);
});

test("pooling every tenant's balance hides Beacon's shortfall", () => {
  const ps = ["ATLAS", "BEACON"].map((k) => plan(k));
  const naive = naivePooledCheck(ps.map((p) => p.balance), ps.map((p) => p.totalUsd));
  assert.equal(naive.saysEnough, true);
  assert.notEqual(ps[1]!.action, "PAY_ALL");
});

test("Cobalt's mid-run deposit funds Cobalt only; Beacon's plan is unchanged", () => {
  assert.equal(plan("COBALT", 9000).action, "PAY_ALL");
  assert.equal(plan("BEACON").action, "PAY_PARTIAL_AND_REQUEST_ADVANCE");
});
