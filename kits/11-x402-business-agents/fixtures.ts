/** Synthetic data for kit 11: Trailhead sells a trail-conditions API to other agents per call. */
import type { AgentLimits } from "./policy.ts";

export const API = {
  name: "Trailhead Trail Conditions API",
  path: "/conditions",
  priceCents: 10, // what buyer agents pay per call
};

export const UPSTREAM = {
  name: "Summit Weather Data",
  path: "/forecast",
  priceCents: 4,
  raisedPriceCents: 7,
  notice: `From: billing@summit-weather.example
Subject: Price change for the /forecast endpoint

Hi Trailhead team, from today /forecast costs USDZ 0.07 per call (was 0.04), reflecting new satellite data costs.
The new price is already in our x402 offers. Thanks for building with us.`,
};

export const BUYERS = ["RouteBuddy planner", "Peakfinder app", "CampCast agent"];

/** Opening limits. Sourcing and treasury may pay only listed payees; support may refund anyone, up to 50c each. */
export const OPENING_LIMITS: AgentLimits[] = [
  { agent: "SOURCING", capCents: 5, budgetCents: 300, payees: "LISTED" },
  { agent: "SUPPORT", capCents: 50, budgetCents: 500, payees: "ANY" },
  { agent: "TREASURY", capCents: 6_000, budgetCents: 6_000, payees: "LISTED" },
];

/** The owner's opening *USDZ balance (testnet faucet grants plus last period's earnings). */
export const OPENING_BALANCE_CENTS = 10_000;

/** Calls served before and after the price change, and calls still expected this period. */
export const CALLS_BEFORE = 40;
export const CALLS_AFTER = 20;
export const REMAINING_CALLS_EXPECTED = 120;

export const CONTRACTOR = {
  name: "Fenwick Cartography Ltd",
  invoice: "FC-2026-10",
  amount: 30,
  currency: "GBP",
  method: "LOCAL",
  beneficiary: {
    transfer_methods: ["LOCAL"],
    beneficiary: {
      entity_type: "COMPANY",
      company_name: "Fenwick Cartography Ltd",
      address: { street_address: "14 Grainger St", city: "Newcastle upon Tyne", postcode: "NE1 5JG", country_code: "GB" },
      bank_details: { account_currency: "GBP", account_name: "Fenwick Cartography Ltd", account_number: "12345678", account_routing_type1: "sort_code", account_routing_value1: "200415", bank_country_code: "GB", local_clearing_system: "FASTER_PAYMENTS" },
    },
  },
};
