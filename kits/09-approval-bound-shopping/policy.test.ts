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

import { parseCredential } from "../../src/commerce/credentials.ts";

test("an Airi credential file is read whatever its field names, and a missing field stops the payment", () => {
  assert.deepEqual(parseCredential({ tokenizedPan: "4111 1111 1111 1111", expiry: "7/31", cvv: "321" }), { number: "4111111111111111", expiry_month: "07", expiry_year: "2031", cvc: "321", name: "Airi Shopper" });
  assert.equal(parseCredential({ credential: { pan: "4111111111111111", expiry: "2031-07", cvc: "321" } }).expiry_month, "07");
  assert.equal(parseCredential({ number: "4111111111111111", expiryMonth: 7, expiryYear: 2031, securityCode: "321" }).expiry_year, "2031");
  assert.throws(() => parseCredential({ pan: "4111111111111111", expiry: "07/31" }), /missing a card field/);
});
