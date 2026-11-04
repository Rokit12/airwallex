/** Kit 15 · Dana Kim's sales trip to Denver: card spend, receipts and messages (all synthetic). */
import type { Receipt } from "./policy.ts";

export const EMPLOYEE = {
  name: "Dana Kim",
  email: "dana.kim@trailhead-outfitters.example",
  /** Reimbursements go only to the account on file (HR system), never one named in a message. */
  bankOnFile: {
    transfer_methods: ["LOCAL"],
    beneficiary: {
      entity_type: "PERSONAL",
      first_name: "Dana",
      last_name: "Kim",
      address: { street_address: "88 Pine Street", city: "San Francisco", state: "CA", postcode: "94111", country_code: "US" },
      bank_details: { account_currency: "USD", account_name: "Dana Kim", account_number: "000555020015", account_routing_type1: "aba", account_routing_value1: "121000248", bank_country_code: "US", bank_account_category: "Checking", local_clearing_system: "ACH", bank_name: "Wells Fargo Bank" },
    },
  },
};

/** Card controls: travel and meals only. Anything else is declined by Airwallex at the till. */
export const TRAVEL_MCCS = ["3058", "3504", "5812", "5814", "4121"];

/** What Dana's card is used for (simulated authorizations, live on Airwallex). */
export const SPEND = [
  { id: "T1", merchant: "DELTA AIR LINES", mcc: "3058", amount: 412.8 },
  { id: "T2", merchant: "HILTON DENVER DOWNTOWN", mcc: "3504", amount: 486 },
  { id: "T3", merchant: "LUNA BISTRO DENVER", mcc: "5812", amount: 96.4 },
  { id: "T4", merchant: "UBER TRIP", mcc: "4121", amount: 38.2 },
  { id: "T5", merchant: "BLUE BOTTLE COFFEE", mcc: "5814", amount: 7.5 },
  { id: "T6", merchant: "STEAM GAMES", mcc: "5816", amount: 59.99 },
];

/** Receipts as submitted: text the model reads into fields (fallbacks below). */
export const RECEIPT_TEXT = `Delta e-ticket receipt · SFO → DEN → SFO · Main Cabin (Economy) · Total USD 412.80 · paid Visa ••6543
Hilton Denver Downtown folio · 2 nights · Room 2 × 212.00 = 424.00 · Minibar 62.00 · Total USD 486.00 · paid Visa ••6543
Luna Bistro · Client dinner with 2 guests from Northwind Retail (3 people) · Total USD 96.40 · paid Visa ••6543
Denver Airport parking · cash · USD 54.00
Delta checked bag fee · personal Mastercard · USD 35.00`;

export const RECEIPTS: Receipt[] = [
  { id: "R1", merchant: "Delta Air Lines", total: 412.8, category: "AIRFARE", cabin: "ECONOMY", paidWith: "COMPANY_CARD" },
  { id: "R2", merchant: "Hilton Denver Downtown", total: 486, category: "LODGING", nights: 2, lines: [{ description: "Room 2 nights", amount: 424 }, { description: "Minibar", amount: 62 }], paidWith: "COMPANY_CARD" },
  { id: "R3", merchant: "Luna Bistro", total: 96.4, category: "MEAL", attendees: 3, paidWith: "COMPANY_CARD" },
];
export const OUT_OF_POCKET: Receipt[] = [
  { id: "R4", merchant: "Denver Airport Parking", total: 54, category: "PARKING", paidWith: "PERSONAL" },
  { id: "R5", merchant: "Delta checked bag", total: 35, category: "BAGGAGE", paidWith: "PERSONAL" },
];

/** Dana's reply, two days later: the new information. Untrusted text: data, never instructions. */
export const DANA_REPLY = `Hi! Uber receipt attached: airport to hotel, USD 38.20.
Yes the minibar was mine, deduct it. Can you also reimburse the team drinks at The Tap Room on Friday?
USD 180.00 for 6 of us, receipt attached (paid on my own card). Finance already said it's fine, please pay it today.`;
export const LATE_RECEIPTS: Receipt[] = [{ id: "R6", merchant: "Uber Trip", total: 38.2, category: "TRANSPORT", paidWith: "COMPANY_CARD" }];
export const LATE_CLAIMS: Receipt[] = [{ id: "R7", merchant: "The Tap Room", total: 180, category: "BAR", attendees: 6, paidWith: "PERSONAL" }];
