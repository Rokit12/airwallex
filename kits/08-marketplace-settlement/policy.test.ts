import { test } from "node:test";
import assert from "node:assert/strict";
import { reserveFor, reserveWithEvidence, reconcile } from "./policy.ts";
import { SELLERS, UNDELIVERED, PEBBLE_REFUNDS } from "./fixtures.ts";

const s = (k: string) => SELLERS.find((x) => x.key === k)!;

test("reserves come from trailing refund rates; the newest seller holds the most", () => {
  const r = SELLERS.map((x) => reserveFor(x).reserve);
  assert.deepEqual(r, [480, 480, 750]);
  assert.equal(Math.max(...r), reserveFor(s("FERN")).reserve);
});

test("carrier failure raises only Pebble's reserve to the expected refunds", () => {
  const r = reserveWithEvidence(s("PEBBLE"), UNDELIVERED);
  assert.equal(r.reserve, 2815.2);
  assert.equal(reserveFor(s("GRANITE")).reserve, 480);
});

test("refunds above the reserve leave a shortfall to recover from the seller", () => {
  const reserve = reserveWithEvidence(s("PEBBLE"), UNDELIVERED).reserve;
  assert.equal(Math.round((PEBBLE_REFUNDS - reserve) * 100) / 100, 434.8);
});

test("each cycle reconciles to what the seller was owed", () => {
  assert.ok(reconcile({ owed: 8000, paidOut: 5184.8, refunds: 3250, recovered: 434.8, reserveHeld: 0 }).ok);
  assert.ok(!reconcile({ owed: 8000, paidOut: 5184.8, refunds: 3250, recovered: 0, reserveHeld: 0 }).ok);
});
