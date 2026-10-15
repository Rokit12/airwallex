/** Synthetic treasury position, obligations and receivable for the kit 1 demo. */
import type { Obligation } from "./policy.ts";

/** The operating envelope this agent manages on the company wallet. */
export const ENVELOPE = { USD: 28_000, EUR: 1_000, GBP: 0 };

export const OBLIGATIONS: Obligation[] = [
  { id: "FREIGHT", payee: "Hanse Container Terminal GmbH", amount: 7500, currency: "EUR", method: "SWIFT", dueInHours: 24, priority: "CRITICAL", lateCostUsd: 2200, note: "Container release at Hamburg; production stops without it." },
  { id: "COMPONENTS", payee: "Calder Precision Ltd", amount: 4000, currency: "GBP", method: "LOCAL", dueInHours: 36, priority: "TIME_SENSITIVE", lateCostUsd: 900, note: "Holds our production slot for November." },
  { id: "LEASE", payee: "Mission Bay Properties", amount: 3500, currency: "USD", method: "LOCAL", dueInHours: 60, priority: "STANDARD", lateCostUsd: 175, note: "Office lease; 5% late fee." },
  { id: "SOFTWARE", payee: "Ledgerly Inc", amount: 2400, currency: "USD", method: "LOCAL", dueInHours: 72, priority: "STANDARD", lateCostUsd: 0, note: "Annual licence renewal; 30-day grace period." },
  { id: "AGENCY", payee: "Brightline Creative", amount: 12000, currency: "USD", method: "LOCAL", dueInHours: 72, priority: "STANDARD", lateCostUsd: 0, newVendor: true, note: "New marketing agency, first invoice." },
];

export const RECEIVABLE = {
  customer: "Northwind Retail",
  invoice: "INV-C-5512",
  amount: 9500,
  expected: "tomorrow",
  bankData: "ACH pre-notification received for USD 9,500.00 from NORTHWIND RETAIL, effective tomorrow; matches invoice INV-C-5512.",
};

export const CUSTOMER_EMAIL = `From: ap@northwind-retail.example
Subject: INV-C-5512 payment timing

Hi, our AP run slipped this week. We'll send USD 6,000.00 tomorrow and the remaining USD 3,500.00 next Thursday.
Sorry for the inconvenience.`;

export const CUSTOMER_EMAIL_FALLBACK = { contradiction: true, amountTomorrow: 6000, remainderLater: 3500 };

/** Real routing / IBAN formats Airwallex validates; account numbers are synthetic. */
export const BENEFICIARIES = {
  FREIGHT: {
    transfer_methods: ["SWIFT"],
    beneficiary: {
      entity_type: "COMPANY",
      company_name: "Hanse Container Terminal GmbH",
      address: { street_address: "Am Sandtorkai 1", city: "Hamburg", postcode: "20457", country_code: "DE" },
      bank_details: { account_currency: "EUR", account_name: "Hanse Container Terminal GmbH", iban: "DE89370400440532013000", swift_code: "COBADEFFXXX", bank_country_code: "DE" },
    },
  },
  SOFTWARE: {
    transfer_methods: ["LOCAL"],
    beneficiary: {
      entity_type: "COMPANY",
      company_name: "Ledgerly Inc",
      address: { street_address: "1 Market Plaza", city: "San Francisco", state: "CA", postcode: "94105", country_code: "US" },
      bank_details: { account_currency: "USD", account_name: "Ledgerly Inc", account_number: "000555012345", account_routing_type1: "aba", account_routing_value1: "121000248", bank_country_code: "US", bank_account_category: "Checking", local_clearing_system: "ACH" },
    },
  },
} as const;
