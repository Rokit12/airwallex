import { test } from "node:test";
import assert from "node:assert/strict";
import { choose, diffTerms, afterUnconfirmedSubmit, type Offer } from "./policy.ts";
import { buildCatalog } from "../../src/commerce/catalog.ts";
import { DELIVERY } from "../../src/commerce/store.ts";

const offers: Offer[] = buildCatalog().filter((p) => p.category === "Tents");
const intent = { need: "2-person backpacking tent", budget: 260, arriveWithinDays: 8, returnsRequired: true };

test("picks the best-rated tent that arrives in time and fits the budget", () => {
  const { pick, rejected } = choose(offers, [...DELIVERY], intent);
  assert.equal(pick?.offer.sku, "TRL-1001");
  assert.equal(pick?.total, 238);
  assert.ok(rejected.some((r) => r.sku === "TRL-1002" && /over budget/.test(r.why)));
});

test("a price change after approval is detected field by field", () => {
  const a = { merchant: "M", sku: "TRL-1001", product: "Summit", delivery: "STANDARD", total: 238, currency: "USD" };
  assert.deepEqual(diffTerms(a, { ...a, total: 255 }), ["total: 238 → 255"]);
  assert.deepEqual(diffTerms(a, a), []);
});

test("after a timed-out submission, check the order before any retry", () => {
  assert.equal(afterUnconfirmedSubmit("PAID"), "DONE");
  assert.equal(afterUnconfirmedSubmit("PROCESSING"), "WAIT");
  assert.equal(afterUnconfirmedSubmit("PAYMENT_FAILED"), "RETRY_SAME_CHECKOUT");
  assert.equal(afterUnconfirmedSubmit("NOT_FOUND"), "STOP");
});

test("a cheaper, better-rated 3-person tent is rejected: it is not what the shopper asked for", () => {
  const { pick, rejected } = choose(offers, [...DELIVERY], intent);
  assert.ok(!pick?.offer.name.includes("3-Person"));
  assert.ok(rejected.some((r) => r.sku === "TRL-1005" && /2-person/.test(r.why)));
});
