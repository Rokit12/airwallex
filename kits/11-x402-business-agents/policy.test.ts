import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAllocation, proposeReallocation, sweepAmount, afterTimeout, depositDecision, resolveDisputedBatch, type AgentState } from "./policy.ts";

// The guide's numbers: 20 *USDZ between three agents; sourcing 10 at most 3c, support 4, treasury 6.
// After 150 queries at 2c upstream, sourcing has spent 3.00; support refunded one 5c query.
const agents = (): AgentState[] => [
  { agent: "SOURCING", capCents: 3, budgetCents: 1_000, payees: "LISTED", spentCents: 300 },
  { agent: "SUPPORT", capCents: 10, budgetCents: 400, payees: "ANY", spentCents: 5 },
  { agent: "TREASURY", capCents: 600, budgetCents: 600, payees: "LISTED", spentCents: 0 },
];

test("budgets must stay within the 20 *USDZ the agents share, and what they may still spend must fit the balance after gas", () => {
  assert.equal(checkAllocation(2_300, agents()).ok, true);
  assert.equal(checkAllocation(1_900, agents()).ok, false, "1,695 still spendable > 1,600 room");
  const tooMuch = agents().map((a) => (a.agent === "SUPPORT" ? { ...a, budgetCents: 500 } : a));
  assert.equal(checkAllocation(100_000, tooMuch).withinCeiling, false, "21 *USDZ of budgets breaks the ceiling however large the balance");
});

test("upstream at 4c above the 3c cap: raise the cap, fund the shortfall within the 20 *USDZ, and raise the query price to keep the margin", () => {
  const r = proposeReallocation({ agents: agents(), balanceCents: 2_750, newUpstreamPriceCents: 4, apiPriceCents: 5, remainingCalls: 200, treasuryNeedCents: 600 });
  assert.equal(r.action, "REALLOCATE");
  const s = r.limits.find((l) => l.agent === "SOURCING")!;
  assert.equal(s.capCents, 5, "4c + 10%, rounded up");
  assert.equal(r.shortfallCents, 800 - 700);
  assert.equal(s.budgetCents - 300, 800, "room for every expected purchase");
  assert.deepEqual(r.moves, [{ from: "SUPPORT", cents: 100 }], "nothing is unallocated inside the 20, so support gives above its refund reserve");
  assert.equal(r.limits.reduce((t, l) => t + l.budgetCents, 0), 2_000, "still exactly 20 *USDZ between them");
  assert.equal(r.apiPriceCents, 6, "a 1c margin is below the 2c minimum, so the query price rises to 6c");
  assert.ok(checkAllocation(2_750, r.limits).ok);
});

test("with a healthy margin the proposal keeps the query price", () => {
  const r = proposeReallocation({ agents: agents(), balanceCents: 2_750, newUpstreamPriceCents: 3, apiPriceCents: 5, remainingCalls: 100, treasuryNeedCents: 600 });
  assert.equal(r.apiPriceCents, 5);
});

test("when support and treasury cannot give more, it rations queries instead of breaking the refund reserve", () => {
  const r = proposeReallocation({ agents: agents(), balanceCents: 2_750, newUpstreamPriceCents: 4, apiPriceCents: 5, remainingCalls: 1_000, treasuryNeedCents: 600 });
  assert.equal(r.action, "RATION_CALLS");
  assert.ok(r.servableCalls < 1_000);
  assert.equal(r.limits.find((l) => l.agent === "SUPPORT")!.budgetCents - 5, 100, "support keeps exactly the refund reserve");
});

test("an upstream price that would more than double the query price needs customers, not just new limits", () => {
  assert.equal(proposeReallocation({ agents: agents(), balanceCents: 2_750, newUpstreamPriceCents: 10, apiPriceCents: 5, remainingCalls: 10, treasuryNeedCents: 0 }).action, "RAISE_API_PRICE");
});

test("a disputed batch: signed orders stand, wrong data is refunded, nothing is refunded twice", () => {
  const c = (id: string, version: string, extra: Partial<{ signedOnChain: boolean; alreadyRefunded: boolean }> = {}) => ({ paymentId: id, signedOnChain: true, dataVersion: version, alreadyRefunded: false, ...extra });
  const d = resolveDisputedBatch([c("a", "good"), c("b", "bad"), c("c", "bad", { alreadyRefunded: true }), c("d", "good", { signedOnChain: false })], ["bad"], () => 5);
  assert.deepEqual(d.lines.map((l) => l.outcome), ["UPHOLD_SIGNED", "REFUND_WRONG_DATA", "ALREADY_REFUNDED", "NO_SUCH_CHARGE"]);
  assert.equal(d.refundCents, 5);
});

test("the sweep leaves what sourcing and support may still spend, plus gas", () => {
  assert.equal(sweepAmount(2_750, agents()), 2_750 - 700 - 395 - 300);
});

test("a timed-out payout is read before anything is resent", () => {
  assert.equal(afterTimeout("paid"), "DONE");
  assert.equal(afterTimeout("pending"), "WAIT");
  assert.equal(afterTimeout("not_found"), "RESEND_SAME_ID");
  assert.equal(depositDecision(["0xABC"], "0xabc"), "SKIP_ALREADY_CREDITED");
  assert.equal(depositDecision([], "0xabc"), "CREDIT");
});
