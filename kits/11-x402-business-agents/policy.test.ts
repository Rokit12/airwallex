import { test } from "node:test";
import assert from "node:assert/strict";
import { checkAllocation, proposeReallocation, sweepAmount, afterTimeout, depositDecision, type AgentState } from "./policy.ts";

const agents = (): AgentState[] => [
  { agent: "SOURCING", capCents: 5, budgetCents: 300, payees: "LISTED", spentCents: 160 },
  { agent: "SUPPORT", capCents: 50, budgetCents: 500, payees: "ANY", spentCents: 20 },
  { agent: "TREASURY", capCents: 6000, budgetCents: 6000, payees: "LISTED", spentCents: 0 },
];

test("what agents may still spend must fit inside the balance with the gas reserve left over", () => {
  assert.equal(checkAllocation(10_000, agents()).ok, true);
  assert.equal(checkAllocation(6_500, agents()).ok, false); // 6,620 still spendable > 6,200 room
  assert.equal(checkAllocation(6_920, agents()).unallocatedCents, 0);
});

test("a price rise above the cap raises the cap and funds the shortfall from unallocated, then support above its reserve", () => {
  const r = proposeReallocation({ agents: agents(), balanceCents: 10_000, newUpstreamPriceCents: 7, apiPriceCents: 10, remainingCalls: 120, treasuryNeedCents: 4_500 });
  assert.equal(r.action, "REALLOCATE");
  const s = r.limits.find((l) => l.agent === "SOURCING")!;
  assert.equal(s.capCents, 8); // 7c + 10%, rounded up
  assert.equal(r.shortfallCents, 840 - 140);
  assert.equal(s.budgetCents - 160, 840); // room for every expected call
  assert.deepEqual(r.moves.map((m) => m.from), ["UNALLOCATED"]);
  assert.ok(checkAllocation(10_000, r.limits).ok, "what agents may still spend stays inside the balance");
});

test("with no unallocated room it takes support above the refund reserve, then treasury above its needs", () => {
  const r = proposeReallocation({ agents: agents(), balanceCents: 6_920, newUpstreamPriceCents: 7, apiPriceCents: 10, remainingCalls: 120, treasuryNeedCents: 5_600 });
  assert.equal(r.action, "REALLOCATE");
  assert.deepEqual(r.moves, [{ from: "SUPPORT", cents: 380 }, { from: "TREASURY", cents: 320 }]);
  assert.equal(r.limits.find((l) => l.agent === "SUPPORT")!.budgetCents - 20, 100, "support keeps exactly the refund reserve");
});

test("when nothing can move, it rations calls instead of breaking the refund reserve", () => {
  const r = proposeReallocation({ agents: agents(), balanceCents: 6_920, newUpstreamPriceCents: 7, apiPriceCents: 10, remainingCalls: 1_000, treasuryNeedCents: 6_000 });
  assert.equal(r.action, "RATION_CALLS");
  assert.ok(r.servableCalls < 1_000);
});

test("an upstream price at or above the API price reprices instead of buying at a loss", () => {
  assert.equal(proposeReallocation({ agents: agents(), balanceCents: 10_000, newUpstreamPriceCents: 10, apiPriceCents: 10, remainingCalls: 10, treasuryNeedCents: 0 }).action, "RAISE_API_PRICE");
});

test("the sweep leaves what sourcing and support may still spend, plus gas", () => {
  assert.equal(sweepAmount(10_000, agents()), 10_000 - 140 - 480 - 300);
});

test("a timed-out payout is read before anything is resent", () => {
  assert.equal(afterTimeout("paid"), "DONE");
  assert.equal(afterTimeout("pending"), "WAIT");
  assert.equal(afterTimeout("not_found"), "RESEND_SAME_ID");
  assert.equal(depositDecision(["0xABC"], "0xabc"), "SKIP_ALREADY_CREDITED");
  assert.equal(depositDecision([], "0xabc"), "CREDIT");
});
