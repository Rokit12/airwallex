/** Synthetic marketplace: three sellers, one settlement cycle. */
import type { CustomerSpec } from "../../src/core/platform.ts";

export interface SellerFixture {
  key: "GRANITE" | "PEBBLE" | "FERN";
  spec: CustomerSpec;
  owed: number;
  refundRate: number;
  monthsActive: number;
}

export const SELLERS: SellerFixture[] = [
  { key: "GRANITE", spec: { name: "Granite Goods LLC", email: "payouts@granitegoods.example", ein: "93-4400101", person: { first: "Ben", last: "Stone" }, address: { address_line1: "10 Quarry Rd", suburb: "Boise", state: "ID", postcode: "83702" } }, owed: 12_000, refundRate: 0.02, monthsActive: 30 },
  { key: "PEBBLE", spec: { name: "Pebble Toys Co", email: "payouts@pebbletoys.example", ein: "93-4400102", person: { first: "Mia", last: "Lopez" }, address: { address_line1: "44 Play St", suburb: "Columbus", state: "OH", postcode: "43215" } }, owed: 8_000, refundRate: 0.03, monthsActive: 18 },
  { key: "FERN", spec: { name: "Fern & Flax LLC", email: "payouts@fernflax.example", ein: "93-4400103", person: { first: "June", last: "Park" }, address: { address_line1: "7 Linen Way", suburb: "Asheville", state: "NC", postcode: "28801" } }, owed: 5_000, refundRate: 0, monthsActive: 2 },
];

export const CARRIER_NOTICE = `From: alerts@swiftship-carrier.example
Subject: Service failure — Ohio regional hub

A sorting failure at our Columbus hub has stranded parcels shipped Oct 6–9.
Affected merchant: PEBBLE TOYS CO. Parcels affected: 46. Expected recovery: unknown.`;

export const UNDELIVERED = { orders: 46, avgValue: 68 };
/** Refunds the marketplace actually issued to Pebble's buyers after the notice. */
export const PEBBLE_REFUNDS = 3250;
