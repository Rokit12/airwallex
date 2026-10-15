/** Synthetic revenue-based-advance portfolio. */
import type { CustomerSpec } from "../../src/core/platform.ts";

export const PLATFORM_CAPITAL = 40_000;

export interface BorrowerFixture {
  key: "JUNIPER" | "HARBOR" | "MEADOW";
  spec: CustomerSpec;
  outstanding: number;
  repayRate: number;
  expectedRevenue: number;
  actualRevenue: number;
  /** Paid out of the wallet by the borrower before collection day (its own supplier). */
  ownSpending: number;
  /** Approved but not yet disbursed. */
  approved?: number;
}

export const BORROWERS: BorrowerFixture[] = [
  {
    key: "JUNIPER",
    spec: { name: "Juniper Coffee Co", email: "owner@junipercoffee.example", ein: "61-3300101", person: { first: "Ana", last: "Ruiz" }, address: { address_line1: "21 Bean St", suburb: "Portland", state: "OR", postcode: "97209" } },
    outstanding: 12_000,
    repayRate: 0.12,
    expectedRevenue: 15_000,
    actualRevenue: 15_000,
    ownSpending: 0,
  },
  {
    key: "HARBOR",
    spec: { name: "Harbor Bikes LLC", email: "owner@harborbikes.example", ein: "61-3300102", person: { first: "Sam", last: "Okafor" }, address: { address_line1: "5 Dock Rd", suburb: "San Diego", state: "CA", postcode: "92101" } },
    outstanding: 8_000,
    repayRate: 0.15,
    expectedRevenue: 10_000,
    actualRevenue: 4_000,
    ownSpending: 3_550,
  },
  {
    key: "MEADOW",
    spec: { name: "Meadow Florist LLC", email: "owner@meadowflorist.example", ein: "61-3300103", person: { first: "Ivy", last: "Moss" }, address: { address_line1: "88 Bloom Ave", suburb: "Austin", state: "TX", postcode: "78704" } },
    outstanding: 0,
    repayRate: 0.1,
    expectedRevenue: 0,
    actualRevenue: 0,
    ownSpending: 0,
    approved: 25_000,
  },
];
