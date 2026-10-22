/** Three small-business customers of the card platform (synthetic, US, USD). */
import type { CustomerSpec } from "../../src/core/platform.ts";
import type { BridgeRequest } from "./policy.ts";

export interface Customer {
  key: "ACME" | "BLUEFIN" | "CORNER";
  spec: CustomerSpec;
  initialDeposit: number;
  cardPayment: { amount: number; mcc: string; merchant: string };
  bridge: Omit<BridgeRequest, "customer" | "dueToday" | "balance">;
  lateDeposit: number;
}

export const CUSTOMERS: Customer[] = [
  {
    key: "ACME",
    spec: { name: "Acme Bakery LLC", email: "finance@acmebakery.example", ein: "84-1234561", person: { first: "Rosa", last: "Alvarez" }, address: { address_line1: "12 Mill St", suburb: "Portland", state: "OR", postcode: "97205" } },
    initialDeposit: 8000, // enough that the per-transaction limit, not funding, decides the 4,000 test
    cardPayment: { amount: 1200, mcc: "5149", merchant: "PACIFIC FLOUR SUPPLY" },
    bridge: { expectedDeposit: 0, evidence: "BANK_PRENOTE", onTimeRate: 1, priorLateRepayment: false },
    lateDeposit: 0,
  },
  {
    key: "BLUEFIN",
    spec: { name: "Bluefin Studio LLC", email: "ops@bluefinstudio.example", ein: "84-1234562", person: { first: "Noah", last: "Kim" }, address: { address_line1: "88 Pier Ave", suburb: "Santa Monica", state: "CA", postcode: "90405" } },
    initialDeposit: 600,
    cardPayment: { amount: 2400, mcc: "7311", merchant: "ADWAVE MEDIA" },
    bridge: { expectedDeposit: 9000, evidence: "BANK_PRENOTE", onTimeRate: 11 / 12, priorLateRepayment: false },
    lateDeposit: 9000,
  },
  {
    key: "CORNER",
    spec: { name: "Corner Dental PLLC", email: "office@cornerdental.example", ein: "84-1234563", person: { first: "Priya", last: "Shah" }, address: { address_line1: "400 Elm St", suburb: "Denver", state: "CO", postcode: "80203" } },
    initialDeposit: 400,
    cardPayment: { amount: 3100, mcc: "5047", merchant: "SUMMIT DENTAL LAB" },
    bridge: { expectedDeposit: 5500, evidence: "CUSTOMER_SAYS", onTimeRate: 6 / 12, priorLateRepayment: true },
    lateDeposit: 0,
  },
];

/** Card controls the platform sets for every customer card. */
export const CARD_CONTROLS = {
  allowed_transaction_count: "MULTIPLE",
  allowed_currencies: ["USD"],
  allowed_merchant_categories: ["5149", "7311", "5047", "5734", "5111"],
  transaction_limits: { currency: "USD", limits: [{ amount: 3500, interval: "PER_TRANSACTION" }, { amount: 8000, interval: "MONTHLY" }] },
};

export const MONTHLY_FEE = 49;
