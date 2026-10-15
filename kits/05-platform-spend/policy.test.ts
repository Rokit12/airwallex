import { test } from "node:test";
import assert from "node:assert/strict";
import { rationBridges, repayProbability, type BridgeRequest } from "./policy.ts";
import { CUSTOMERS } from "./fixtures.ts";

const reqs: BridgeRequest[] = CUSTOMERS.map((c) => ({ customer: c.key, dueToday: c.cardPayment.amount, balance: c.initialDeposit, ...c.bridge }));
const find = (r: ReturnType<typeof rationBridges>, k: string) => r.decisions.find((d) => d.customer === k)!;

test("capital covers one late customer, not both: the better-evidenced one is bridged", () => {
  const r = rationBridges(reqs);
  assert.equal(find(r, "ACME").action, "NOT_NEEDED");
  assert.equal(find(r, "BLUEFIN").action, "BRIDGE");
  assert.equal(find(r, "BLUEFIN").amount, 1800);
  assert.equal(find(r, "CORNER").action, "DECLINE");
  assert.ok(r.remaining >= 0);
});

test("bank pre-notification beats the customer's word", () => {
  assert.ok(repayProbability(reqs[1]!) > repayProbability(reqs[2]!));
});

test("with more capital, the weaker request is bridged but only with a person's approval", () => {
  const r = rationBridges(reqs, { capital: 12000, reserveFloor: 2000, maxShareOfDeposit: 0.5, autoMinProbability: 0.85, autoLimit: 2000 });
  assert.equal(find(r, "CORNER").action, "BRIDGE_WITH_APPROVAL");
});

test("never bridge more than half the expected deposit", () => {
  const r = rationBridges([{ ...reqs[1]!, expectedDeposit: 3000 }], { capital: 20000, reserveFloor: 0, maxShareOfDeposit: 0.5, autoMinProbability: 0.85, autoLimit: 5000 });
  assert.equal(r.decisions[0]!.action, "DECLINE");
});
