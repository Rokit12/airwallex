import { test } from "node:test";
import assert from "node:assert/strict";
import { choosePlan, controlsFor, predict } from "./policy.ts";
import { QUOTE, FORECAST } from "./fixtures.ts";

test("annual is 18% cheaper but breaches the floor in week 7, so the agent picks monthly", () => {
  const d = choosePlan(QUOTE, FORECAST(25_000));
  assert.equal(d.plan, "MONTHLY");
  assert.equal(d.annualSavingPct, 18);
  assert.equal(d.paths.ANNUAL.firstBreachWeek, 6); // index 6 = week 7
  assert.equal(d.paths.MONTHLY.firstBreachWeek, null);
  assert.equal(d.reconsiderWeek, 8); // after the week-9 receivable
});

test("with more cash, annual is affordable and chosen", () => {
  assert.equal(choosePlan(QUOTE, FORECAST(40_000)).plan, "ANNUAL");
});

test("with too little cash, neither plan fits and a person decides", () => {
  assert.equal(choosePlan(QUOTE, FORECAST(10_000)).plan, "ESCALATE");
});

test("card controls admit exactly one monthly bill and nothing else", () => {
  const c = controlsFor(QUOTE, "MONTHLY");
  const ok = { amount: 1200, currency: "USD", mcc: "5734" };
  assert.equal(predict(c, ok, 0, true), "APPROVED"); // limit is inclusive
  assert.equal(predict(c, { ...ok, amount: 1200.01 }, 0, true), "LIMIT_EXCEEDED");
  assert.equal(predict(c, { ...ok, amount: 11808 }, 0, true), "LIMIT_EXCEEDED");
  assert.equal(predict(c, { ...ok, currency: "EUR" }, 0, true), "CURRENCY_NOT_ALLOWED");
  assert.equal(predict(c, { ...ok, mcc: "5812" }, 0, true), "MERCHANT_CATEGORY_NOT_ALLOWED");
  assert.equal(predict(c, ok, 1200, true), "LIMIT_EXCEEDED"); // monthly cap
  assert.equal(predict(c, ok, 0, false), "CARD_INACTIVE");
});
