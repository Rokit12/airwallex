import { test } from "node:test";
import assert from "node:assert/strict";
import { matchDeposits, placementPlan, refundAllowed, referencedInvoices, tieOut, tolerance, customerFor, type Deposit } from "./policy.ts";
import { AFTERNOON, CUSTOMERS, INVOICES, MORNING, OBLIGATIONS } from "./fixtures.ts";

const withIds = (ds: Omit<Deposit, "id">[], prefix: string) => ds.map((d, i) => ({ ...d, id: `${prefix}${i + 1}` }));
const statement = [...withIds(MORNING, "m"), ...withIds(AFTERNOON, "a")];

test("each kind of deposit is recognised", () => {
  const { matches, openInvoices } = matchDeposits(INVOICES, statement, CUSTOMERS);
  assert.deepEqual(matches.map((m) => m.kind), ["MATCHED", "MATCHED_COMBINED", "MATCHED_SHORT", "MATCHED", "DUPLICATE", "UNIDENTIFIED"]);
  assert.deepEqual(matches[1]!.invoiceIds, ["INV-1002", "INV-1003"]);
  assert.equal(matches[2]!.writeOff, 18);
  assert.deepEqual(openInvoices.map((i) => i.id), ["INV-1006"], "the duplicate does not pay the other open invoice");
});

test("every cent on the statement is explained", () => {
  const { matches } = matchDeposits(INVOICES, statement, CUSTOMERS);
  const t = tieOut(statement, matches);
  assert.equal(t.statement, 42192);
  assert.equal(t.identified, 13412);
  assert.equal(t.owedBack, 3780);
  assert.equal(t.held, 25000);
  assert.equal(t.difference, 0);
});

test("a short payment above the fee tolerance is not written off", () => {
  const { matches } = matchDeposits(INVOICES, [{ id: "x", payer: "Basalt Trading", amount: 4900, currency: "USD", reference: "INV 1004" }], CUSTOMERS);
  assert.equal(matches[0]!.kind, "UNAPPLIED");
  assert.equal(tolerance(5000), 25);
  assert.equal(tolerance(1000), 5);
});

test("ambiguous amounts go to a person instead of a guess", () => {
  const inv = [{ id: "INV-2001", customer: "Alder Supply Co", amount: 500, currency: "USD" as const, due: "" }, { id: "INV-2002", customer: "Alder Supply Co", amount: 500, currency: "USD" as const, due: "" }];
  const { matches } = matchDeposits(inv, [{ id: "y", payer: "Alder Supply Co", amount: 500, currency: "USD", reference: "payment" }], CUSTOMERS);
  assert.equal(matches[0]!.kind, "UNAPPLIED");
});

test("references and payer names are read leniently, but strictly enough", () => {
  assert.deepEqual(referencedInvoices("Remittance 1002/1003", INVOICES), ["INV-1002", "INV-1003"]);
  assert.equal(customerFor("Cirrus Outdoor LLC", CUSTOMERS), "Cirrus Outdoor");
  assert.equal(customerFor("Cirrus Outdoorsy Holdings", CUSTOMERS), undefined);
  assert.equal(customerFor("Halvorsen Shipping AS", CUSTOMERS), undefined);
});

test("placement: plan on expected cash funds both bills; on identified cash only GBP fits", () => {
  const usdPer = { EUR: 1.08, GBP: 1.27 };
  const expected = placementPlan(INVOICES.reduce((s, i) => s + i.amount, 0), OBLIGATIONS, usdPer);
  assert.deepEqual(expected.lines.filter((l) => l.currency !== "USD").map((l) => l.action), ["FUND", "FUND"]);
  const actual = placementPlan(13412, OBLIGATIONS, usdPer);
  assert.equal(actual.buffer, 8800);
  const byId = Object.fromEntries(actual.lines.map((l) => [l.obligation, l]));
  assert.equal(byId.HANSE!.action, "DEFER", "EUR needs about 6,480 but only 4,612 is free");
  assert.equal(byId.PENNINE!.action, "FUND");
  assert.equal(byId.PENNINE!.needsApproval, true, "3,048 is above the 2,500 autonomous FX limit");
  assert.equal(actual.unplaced, 1564);
});

test("refunds go only to the account on file, never above what is owed back", () => {
  const onFile = { customer: "Cirrus Outdoor", account: "000555010004" };
  assert.equal(refundAllowed({ customer: "Cirrus Outdoor", amount: 3780, toAccount: "000555010004" }, onFile, 3780), true);
  assert.equal(refundAllowed({ customer: "Cirrus Outdoor", amount: 3780, toAccount: "NO9386011117947" }, onFile, 3780), false);
  assert.equal(refundAllowed({ customer: "Cirrus Outdoor", amount: 3781, toAccount: "000555010004" }, onFile, 3780), false);
  assert.equal(refundAllowed({ customer: "Halvorsen Shipping", amount: 25000, toAccount: "NO9386011117947" }, undefined, 25000), false);
});
