import { test } from "node:test";
import assert from "node:assert/strict";
import { startSeller, payFetch, exactPayment, MandateFacilitator, PaymentRefused } from "./x402.ts";
import { EmulatedMandates, inBatches } from "./mandates.ts";
import { MetalRefused, type Address } from "./emulator.ts";

const payTo = "0x00000000000000000000000000000000000000aa" as Address;

test("inBatches keeps order and never runs more than n at once", async () => {
  let live = 0, peak = 0;
  const out = await inBatches([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
    live++; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 5 + (x % 3) * 3));
    live--;
    return x * 10;
  });
  assert.deepEqual(out, [10, 20, 30, 40, 50, 60, 70]);
  assert.equal(peak, 3);
});

test("a mandate refusal is a 402; a failed settlement is not a refusal", async () => {
  const chain = new EmulatedMandates();
  const owner = await chain.openAccount("o", 100);
  const m = await chain.bind(owner, "SOURCING", { payees: [], capCents: 3, budgetCents: 50, expiresAt: Date.now() + 60_000, description: "t" });
  let price = 2;
  const flaky = new MandateFacilitator(chain);
  let fail = false;
  const facilitator = { settle: (p: any, o: any) => (fail ? Promise.reject(new Error("fetch failed")) : flaky.settle(p, o)) };
  const s = await startSeller("t", { "/x": { scheme: "exact", price: () => price, payTo, description: "x", handle: () => ({ ok: true }) } }, facilitator);
  try {
    assert.equal((await payFetch(`${s.url}/x`, exactPayment(m.id))).price, 2);
    price = 4;
    await assert.rejects(payFetch(`${s.url}/x`, exactPayment(m.id)), (e: unknown) => e instanceof PaymentRefused && e.reason === "OverPerPaymentCap");
    price = 2;
    fail = true;
    await assert.rejects(payFetch(`${s.url}/x`, exactPayment(m.id)), (e: unknown) => !(e instanceof PaymentRefused) && /502/.test(String((e as Error).message)));
  } finally {
    await s.close();
  }
  assert.equal((await chain.status(m.id)).spentCents, 2);
  void MetalRefused;
});

test("a payment id pays at most once", async () => {
  const chain = new EmulatedMandates();
  const owner = await chain.openAccount("o", 100);
  const m = await chain.bind(owner, "TREASURY", { payees: [payTo], capCents: 50, budgetCents: 50, expiresAt: Date.now() + 60_000, description: "t" });
  const a = await chain.pull(m.id, payTo, 30, { paymentId: "sweep-1" });
  const b = await chain.pull(m.id, payTo, 30, { paymentId: "sweep-1" });
  assert.equal(a.tx, b.tx);
  assert.equal(await chain.balanceOf(payTo), 30);
});
