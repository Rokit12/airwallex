import { test } from "node:test";
import assert from "node:assert/strict";
import { plan, changedLines, receiptConfidence } from "./policy.ts";
import { ENVELOPE, OBLIGATIONS } from "./fixtures.ts";

const pos = (usd = ENVELOPE.USD) => ({ cash: { ...ENVELOPE, USD: usd }, usdPer: { USD: 1, EUR: 1.1315, GBP: 1.3382 } });
const act = (p: ReturnType<typeof plan>, id: string) => p.lines.find((l) => l.obligation === id)!;

test("initial plan: fund freight, convert minimum for components, fund lease, defer software, escalate agency", () => {
  const p = plan(OBLIGATIONS, pos(), "HIGH");
  assert.equal(act(p, "FREIGHT").action, "CONVERT_AND_FUND");
  assert.equal(act(p, "FREIGHT").convertBuy, 6512.85); // 7,500 + 12.85 SWIFT fee − 1,000 already held
  assert.equal(act(p, "COMPONENTS").action, "CONVERT_AND_FUND");
  assert.equal(act(p, "COMPONENTS").convertBuy, 4000); // LOCAL, no fee
  assert.equal(act(p, "LEASE").action, "FUND");
  assert.equal(act(p, "SOFTWARE").action, "DEFER");
  assert.equal(act(p, "AGENCY").action, "ESCALATE");
  assert.ok(p.freeUsdAfter >= 0);
});

test("high confidence: the agent books both conversions on its own", () => {
  const p = plan(OBLIGATIONS, pos(), "HIGH");
  assert.equal(act(p, "FREIGHT").needsApproval, false);
  assert.equal(act(p, "COMPONENTS").needsApproval, false);
});

test("a contradicting customer email lowers confidence: the same conversions now need a person", () => {
  const conf = receiptConfidence({ invoiceMatchesBankData: true, contradiction: true });
  assert.equal(conf, "LOW");
  const p = plan(OBLIGATIONS, pos(), conf);
  assert.equal(act(p, "FREIGHT").needsApproval, true);
  assert.equal(act(p, "COMPONENTS").needsApproval, true);
});

test("a deposit changes only the decision it affects", () => {
  const before = plan(OBLIGATIONS, pos(), "LOW");
  const after = plan(OBLIGATIONS, pos(ENVELOPE.USD + 6000), "LOW");
  const changed = changedLines(before, after);
  assert.deepEqual(changed.map((l) => l.obligation), ["SOFTWARE"]);
  assert.equal(changed[0]!.action, "FUND");
});

test("the reserve floor is never crossed", () => {
  for (const usd of [12_000, 20_000, 28_000, 40_000]) {
    const p = plan(OBLIGATIONS, pos(usd), "HIGH");
    assert.ok(p.freeUsdAfter >= 0, `floor crossed at ${usd}`);
  }
});
