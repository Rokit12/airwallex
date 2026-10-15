import { test } from "node:test";
import assert from "node:assert/strict";
import { collection, decideDisbursement } from "./policy.ts";
import { BORROWERS, PLATFORM_CAPITAL } from "./fixtures.ts";

const b = (k: string) => { const x = BORROWERS.find((y) => y.key === k)!; return { key: x.key, outstanding: x.outstanding, repayRate: x.repayRate }; };

test("repayment is a share of revenue", () => {
  assert.equal(collection(b("JUNIPER"), 15000, 15000).collect, 1800);
});

test("a short wallet becomes a receivable, never a failing charge", () => {
  const c = collection(b("HARBOR"), 4000, 450);
  assert.equal(c.due, 600);
  assert.equal(c.collect, 450);
  assert.equal(c.receivable, 150);
});

test("full advance would breach the floor: disburse a partial tranche on the forecast", () => {
  const d = decideDisbursement(PLATFORM_CAPITAL + 1800 + 1500, 25000);
  assert.equal(d.action, "PARTIAL");
  assert.equal(d.now, 23300);
  assert.equal(d.needsApproval, true);
});

test("a short repayment shrinks the tranche", () => {
  const forecast = decideDisbursement(PLATFORM_CAPITAL + 1800 + 1500, 25000);
  const actual = decideDisbursement(PLATFORM_CAPITAL + 1800 + 450, 25000);
  assert.ok(actual.now < forecast.now);
  assert.equal(actual.now, 22200);
});

test("too little headroom: delay rather than a token tranche", () => {
  assert.equal(decideDisbursement(30000, 25000).action, "DELAY");
});

test("the floor is never breached", () => {
  for (const cap of [20000, 25000, 40000, 60000]) {
    const d = decideDisbursement(cap, 25000);
    assert.ok(cap - d.now >= 20000);
  }
});
