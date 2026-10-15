/** Synthetic vendor quote and cash forecast for the kit 2 demo. */
import type { Forecast, Quote } from "./policy.ts";

export const QUOTE_TEXT = `From: sales@northwind-analytics.example
Subject: Your Northwind Analytics Team plan quote

Hi! Thanks for the call. Team plan, 40 seats:
 • Monthly billing: USD 1,200.00 per month, cancel any time.
 • Annual billing: USD 11,808.00 paid up front (18% off monthly), non-refundable.
Charges appear as NORTHWIND ANALYTICS under MCC 5734 (computer software stores);
some add-ons bill under MCC 5817 (digital goods: software). All prices in USD.`;

/** Rules fallback (and the check on the model's reading of QUOTE_TEXT). */
export const QUOTE: Quote = {
  vendor: "Northwind Analytics",
  currency: "USD",
  monthlyPrice: 1200,
  annualPrice: 11808,
  mccs: ["5734", "5817"],
  annualRefundable: false,
};

/**
 * 13-week forecast. Week 7 (index 6) carries quarterly tax and contractor
 * payments; a customer receivable lands in week 9 (index 8).
 */
export const FORECAST = (startingCash: number): Forecast => ({
  startingCash,
  reserveFloor: 12_000,
  weeklyNet: [1000, 1000, 1000, 1000, 1000, 1000, -12_000, 1000, 12_000, 1000, 1000, 1000, 1000],
});

export const PRICE_CHANGE_EMAIL = `From: billing@northwind-analytics.example
Subject: Updated pricing for your Team plan

Effective with your next invoice, the Team plan moves to USD 1,350.00 per month.`;
