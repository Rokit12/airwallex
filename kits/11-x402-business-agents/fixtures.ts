/**
 * Synthetic data for kit 11, following the guide: customers' agents buy market data
 * per query; a sourcing agent buys the upstream data, a support agent refunds
 * customers, and a treasury agent moves earnings to Airwallex and pays a monthly
 * licence fee invoiced in euros. The three agents may spend 20 *USDZ between them.
 */
import type { AgentLimits } from "./policy.ts";

export const API = {
  name: "Trailhead Market Data API",
  path: "/quote",
  priceCents: 5, // a query sells for 5 cents
};

export const UPSTREAM = {
  name: "Summit Market Feed",
  path: "/feed",
  priceCents: 2, // its data costs 2 cents
  raisedPriceCents: 4, // then rises to 4 cents, above the sourcing agent's 3-cent cap
  notice: `From: billing@summit-feed.example
Subject: Price change for /feed

Hi Trailhead team, from today /feed costs USDZ 0.04 per request (was 0.02).
The new price is already in our x402 offers. Thanks for building with us.`,
  /** Data version the upstream later withdraws as wrong (a bad batch it published). */
  badVersion: "feed-2026-10-28T09",
  correction: `From: data-quality@summit-feed.example
Subject: Correction: feed batch feed-2026-10-28T09

The quotes we published in batch feed-2026-10-28T09 used a stale reference price and were wrong.
Requests that returned that batch should be treated as incorrect. Later batches are correct.`,
};

export const BUYERS = ["Northgate Research agent", "Peakfinder Capital agent", "Lumen Analytics agent"];

/** The three agents spend 20 *USDZ between them: sourcing 10 (at most 3c a purchase), support 4, treasury 6. */
export const AGENT_CEILING_CENTS = 2_000;
export const OPENING_LIMITS: AgentLimits[] = [
  { agent: "SOURCING", capCents: 3, budgetCents: 1_000, payees: "LISTED" },
  { agent: "SUPPORT", capCents: 10, budgetCents: 400, payees: "ANY" },
  { agent: "TREASURY", capCents: 600, budgetCents: 600, payees: "LISTED" },
];

/** The owner's opening *USDZ: the 20 the agents may spend plus the gas reserve (testnet faucet grants). */
export const OPENING_BALANCE_CENTS = 2_300;

/** Queries served before the price change and after the new limits, and upstream purchases still expected. */
export const CALLS_BEFORE = 150;
export const CALLS_AFTER = 60;
export const REMAINING_CALLS_EXPECTED = 200;
/** The upstream published its bad batch for these queries (1-based, inclusive). */
export const BAD_BATCH_CALLS = { from: 121, to: 132 };

/** The customer whose agent disputes a batch of charges. */
export const DISPUTE = {
  buyerIndex: 0,
  /** Disputed queries (1-based call numbers): every one of this buyer's queries from call 100 to 151. */
  fromCall: 100,
  toCall: 151,
  message: `From: payments@northgate-research.example
Subject: Disputed charges

Our agent never placed these orders, and some of the data you sold us was wrong.
Please refund all of them.`,
};

/** Monthly data licence, invoiced in euros, paid by SWIFT like kit 1's EUR payout. */
export const LICENCE = {
  licensor: "Alpenkarten Daten GmbH",
  invoice: "LIC-2026-10",
  amount: 250,
  currency: "EUR",
  method: "SWIFT",
  beneficiary: {
    transfer_methods: ["SWIFT"],
    beneficiary: {
      entity_type: "COMPANY",
      company_name: "Alpenkarten Daten GmbH",
      address: { street_address: "Leopoldstrasse 12", city: "Munich", postcode: "80802", country_code: "DE" },
      bank_details: { account_currency: "EUR", account_name: "Alpenkarten Daten GmbH", iban: "DE89370400440532013000", swift_code: "COBADEFFXXX", bank_country_code: "DE" },
    },
  },
};
