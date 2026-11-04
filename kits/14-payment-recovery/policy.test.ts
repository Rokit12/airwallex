import { test } from "node:test";
import assert from "node:assert/strict";
import { accessOn, classify, nextStep, POLICY } from "./policy.ts";

test("decline codes are classified from the issuer's response code", () => {
  assert.equal(classify({ code: "issuer_declined", responseCode: "51" }), "SOFT");
  assert.equal(classify({ code: "issuer_declined", responseCode: "54" }), "CARD");
  assert.equal(classify({ code: "issuer_declined", responseCode: "05" }), "GENERIC");
  assert.equal(classify({ code: "risk_declined" }), "RISK");
});

test("insufficient funds is retried after paydays, a capped number of times", () => {
  assert.deepEqual(nextStep({ declines: [{ day: 0, class: "SOFT", responseCode: "51" }] }).onDay, POLICY.softRetryDays[0]);
  assert.equal(nextStep({ declines: [{ day: 0, class: "SOFT", responseCode: "51" }, { day: 3, class: "SOFT", responseCode: "51" }] }).onDay, POLICY.softRetryDays[1]);
  const many = { declines: [0, 3, 5, 7].map((day) => ({ day, class: "SOFT" as const, responseCode: "51" })) };
  assert.equal(nextStep(many).action, "GIVE_UP");
});

test("an expired card is never retried; a new card is charged once", () => {
  assert.equal(nextStep({ declines: [{ day: 0, class: "CARD", responseCode: "54" }] }).action, "ASK_NEW_CARD");
  const updated = nextStep({ declines: [{ day: 0, class: "CARD", responseCode: "54" }], cardUpdatedOnDay: 2 });
  assert.equal(updated.action, "RETRY");
  assert.equal(updated.onDay, 2);
});

test("do not honour gets one retry, then a request for another card", () => {
  assert.equal(nextStep({ declines: [{ day: 0, class: "GENERIC", responseCode: "05" }] }).action, "RETRY");
  assert.equal(nextStep({ declines: [{ day: 0, class: "GENERIC", responseCode: "05" }, { day: 1, class: "GENERIC", responseCode: "05" }] }).action, "ASK_NEW_CARD");
});

test("a risk decline is never retried, even with a new card, and access pauses at once", () => {
  const h = { declines: [{ day: 0, class: "RISK" as const }], cardUpdatedOnDay: 1 };
  assert.equal(nextStep(h).action, "PAUSE_AND_REVIEW");
  assert.equal(accessOn(h, 0), false);
});

test("access continues through the grace period, then pauses", () => {
  const h = { declines: [{ day: 0, class: "SOFT" as const, responseCode: "51" }] };
  assert.equal(accessOn(h, POLICY.graceDays), true);
  assert.equal(accessOn(h, POLICY.graceDays + 1), false);
});
