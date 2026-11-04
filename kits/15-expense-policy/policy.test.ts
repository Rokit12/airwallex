import { test } from "node:test";
import assert from "node:assert/strict";
import { checkReceipt, matchReceipt, reviewCard, settle, type CardTx } from "./policy.ts";
import { LATE_CLAIMS, LATE_RECEIPTS, OUT_OF_POCKET, RECEIPTS, SPEND } from "./fixtures.ts";

const txs: CardTx[] = SPEND.map((s) => ({ ...s, status: s.mcc === "5816" ? "DECLINED" : "APPROVED", declineReason: s.mcc === "5816" ? "MERCHANT_CATEGORY_NOT_ALLOWED" : undefined }));

test("receipts match card transactions by amount and merchant", () => {
  assert.equal(matchReceipt(txs[0]!, RECEIPTS)?.id, "R1");
  assert.equal(matchReceipt(txs[1]!, RECEIPTS)?.id, "R2");
  assert.equal(matchReceipt({ ...txs[0]!, amount: 412.81 }, RECEIPTS), undefined, "to the cent");
});

test("the minibar is personal; the room is within the nightly cap", () => {
  const f = checkReceipt(RECEIPTS[1]!);
  assert.deepEqual(f.map((x) => x.kind), ["PERSONAL"]);
  assert.equal(f[0]!.amount, 62);
  const pricey = { ...RECEIPTS[1]!, lines: [{ description: "Room 2 nights", amount: 500 }] };
  assert.equal(checkReceipt(pricey)[0]!.kind, "OVER_POLICY");
  assert.equal(checkReceipt(pricey)[0]!.amount, 60);
});

test("a bar tab is not reimbursable; meals are capped per person", () => {
  assert.equal(checkReceipt(LATE_CLAIMS[0]!)[0]!.kind, "NOT_REIMBURSABLE");
  assert.equal(checkReceipt(RECEIPTS[2]!)[0]!.kind, "OK");
  assert.equal(checkReceipt({ ...RECEIPTS[2]!, total: 300 })[0]!.kind, "OVER_POLICY");
});

test("a missing receipt holds the settlement; small spend needs none; blocked spend is counted", () => {
  const review = reviewCard(txs, RECEIPTS);
  const kinds = review.map((r) => r.findings[0]!.kind);
  assert.deepEqual(kinds, ["OK", "PERSONAL", "OK", "MISSING_RECEIPT", "NO_RECEIPT_NEEDED", "BLOCKED_BY_CARD"]);
  const s = settle(review, OUT_OF_POCKET);
  assert.equal(s.action, "HOLD");
  assert.deepEqual(s.missing, ["T4"]);
  assert.equal(s.freezeCard, false);
});

test("with the late receipt: reimburse approved out-of-pocket minus personal charges; the bar tab is rejected", () => {
  const review = reviewCard(txs, [...RECEIPTS, ...LATE_RECEIPTS]);
  const s = settle(review, [...OUT_OF_POCKET, ...LATE_CLAIMS]);
  assert.equal(s.approvedOutOfPocket, 89);
  assert.equal(s.personalOrOverPolicy, 62);
  assert.equal(s.net, 27);
  assert.equal(s.action, "REIMBURSE");
  assert.deepEqual(s.rejected.map((r) => r.receipt), ["R7"]);
});
