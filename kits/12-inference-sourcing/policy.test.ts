import { test } from "node:test";
import assert from "node:assert/strict";
import { route, minCostToFinish, overrun, rationFloat, settleHold, type ProviderView, type Step } from "./policy.ts";

const providers = (): ProviderView[] => [
  // The guide's prices: 1, 2 and 5 cents a paragraph; a search 2 cents.
  { id: "atlas-large", kind: "model", tier: "premium", priceMicros: 50_000, latencyMs: 400, up: true },
  { id: "beacon-mid", kind: "model", tier: "standard", priceMicros: 20_000, latencyMs: 300, up: true },
  { id: "cobalt-mini", kind: "model", tier: "budget", priceMicros: 10_000, latencyMs: 200, up: true },
  { id: "scout-search", kind: "search", tier: "standard", priceMicros: 20_000, latencyMs: 250, up: true },
];
const draft: Step = { id: "draft", kind: "model", chunks: 40, worthPremium: true, slaMs: 1_500 };
const notes: Step = { id: "notes", kind: "model", chunks: 10, worthPremium: false, slaMs: 1_500 };

test("a step worth premium goes premium when the job can afford it", () => {
  assert.equal(route(draft, providers(), 3_000_000).provider, "atlas-large");
});

test("premium falls back to the cheapest provider when the job cannot afford it", () => {
  assert.equal(route(draft, providers(), 500_000).provider, "cobalt-mini");
});

test("a provider slower than the SLA is skipped even when it is cheapest", () => {
  const ps = providers();
  ps.find((p) => p.id === "cobalt-mini")!.latencyMs = 2_500;
  const r = route(notes, ps, 1_000_000);
  assert.equal(r.provider, "beacon-mid");
  assert.match(r.reason, /cobalt-mini/);
});

test("the price used is the latest offer, so a price change reroutes", () => {
  const ps = providers();
  ps.find((p) => p.id === "beacon-mid")!.priceMicros = 1_000;
  assert.equal(route(notes, ps, 1_000_000).provider, "beacon-mid");
  assert.equal(minCostToFinish([notes], ps), 10_000);
});

test("a provider slower than the SLA does not count as the cheapest way to finish", () => {
  const ps = providers();
  ps.find((p) => p.id === "cobalt-mini")!.latencyMs = 2_500;
  assert.equal(minCostToFinish([notes], ps), 200_000);
});

test("an overrun raises the hold before topping up, and never tops up beyond the hold", () => {
  const o = overrun({ holdCents: 120, spentMicros: 400_000, projectedRestMicros: 1_200_000, depositSpendableMicros: 500_000 });
  assert.equal(o.action, "RAISE_HOLD_THEN_TOP_UP");
  assert.equal(o.newHoldCents, Math.ceil((1_600_000 * 1.1) / 10_000));
  assert.equal(o.topUpMicros, 700_000);
  assert.equal(overrun({ holdCents: 200, spentMicros: 400_000, projectedRestMicros: 600_000, depositSpendableMicros: 500_000 }).action, "TOP_UP");
  assert.equal(overrun({ holdCents: 200, spentMicros: 400_000, projectedRestMicros: 400_000, depositSpendableMicros: 500_000 }).action, "CONTINUE");
});

test("the float is rationed above its floor, nearest-to-done first", () => {
  const r = rationFloat(900_000, [{ job: "A", micros: 400_000, progress: 0.3 }, { job: "B", micros: 500_000, progress: 0.6 }]);
  // floor 50,000: 850,000 can be granted
  assert.deepEqual(r.grants, [{ job: "B", micros: 500_000, waiting: 0 }, { job: "A", micros: 350_000, waiting: 50_000 }]);
});

test("each hold is captured once from the position, never above the hold; failed jobs are cancelled", () => {
  assert.deepEqual(settleHold(1_234_567, 150, false), { action: "CAPTURE", captureCents: 124, absorbedMicros: 0 });
  assert.equal(settleHold(2_000_000, 150, false).captureCents, 150);
  assert.equal(settleHold(2_000_000, 150, false).absorbedMicros, 500_000);
  assert.equal(settleHold(300_000, 100, true).action, "CANCEL");
});
