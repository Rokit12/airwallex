/**
 * Kit 9 policy: a shopping agent may only pay for exactly what the shopper
 * approved. Selection, delivery choice, term comparison and retry safety are
 * code; the browser automation just reads and fills pages.
 */

export interface Intent {
  need: string;
  /** Total budget including delivery. */
  budget: number;
  /** Must arrive within this many business days (processing + delivery). */
  arriveWithinDays: number;
  returnsRequired: boolean;
}

export interface Offer {
  sku: string;
  name: string;
  price: number;
  shipsInDays: number;
  returnsAccepted: boolean;
  stock: number;
  rating: number;
}

export interface DeliveryOption {
  id: string;
  price: number;
  days: number;
}

export interface Pick {
  offer: Offer;
  delivery: DeliveryOption;
  total: number;
  eta: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Hard attributes in the need (capacity like "2-person", sizes like "32 oz", "55L")
 * must appear in the product name. A search engine's ranking is not the shopper's intent.
 */
export function mismatch(need: string, name: string): string | null {
  const hard = need.toLowerCase().match(/\b\d+(?:[-\s]?(?:person|p|l|oz|ft|in))\b/g) ?? [];
  const n = name.toLowerCase();
  const missing = hard.filter((h) => !n.includes(h.replace(/\s/, "-")) && !n.includes(h));
  return missing.length ? `does not match "${missing.join(", ")}"` : null;
}

/** Cheapest delivery that meets the deadline for each offer, then the best-rated offer that fits the budget. */
export function choose(offers: Offer[], delivery: DeliveryOption[], intent: Intent): { pick: Pick | null; rejected: { sku: string; why: string }[] } {
  const rejected: { sku: string; why: string }[] = [];
  const fits: Pick[] = [];
  for (const o of offers) {
    const off = mismatch(intent.need, o.name);
    if (off) { rejected.push({ sku: o.sku, why: off }); continue; }
    if (o.stock < 1) { rejected.push({ sku: o.sku, why: "out of stock" }); continue; }
    if (intent.returnsRequired && !o.returnsAccepted) { rejected.push({ sku: o.sku, why: "final sale, returns required" }); continue; }
    const d = [...delivery].sort((a, b) => a.price - b.price).find((x) => o.shipsInDays + x.days <= intent.arriveWithinDays);
    if (!d) { rejected.push({ sku: o.sku, why: `cannot arrive within ${intent.arriveWithinDays} days` }); continue; }
    const total = r2(o.price + d.price);
    if (total > intent.budget) { rejected.push({ sku: o.sku, why: `total ${total} over budget ${intent.budget}` }); continue; }
    fits.push({ offer: o, delivery: d, total, eta: o.shipsInDays + d.days });
  }
  fits.sort((a, b) => b.offer.rating - a.offer.rating || a.total - b.total);
  return { pick: fits[0] ?? null, rejected };
}

export interface ShownTerms {
  merchant: string;
  sku: string;
  product: string;
  delivery: string;
  total: number;
  currency: string;
}

/** What changed between the terms the shopper approved and the terms on the page now. */
export function diffTerms(approved: ShownTerms, now: ShownTerms): string[] {
  return (Object.keys(approved) as (keyof ShownTerms)[]).filter((k) => approved[k] !== now[k]).map((k) => `${k}: ${approved[k]} → ${now[k]}`);
}

/** After an unconfirmed submission, decide from the merchant's order status, never by resubmitting blindly. */
export function afterUnconfirmedSubmit(status: string): "DONE" | "RETRY_SAME_CHECKOUT" | "STOP" {
  if (status === "PAID") return "DONE";
  if (status === "OPEN" || status === "PAYMENT_FAILED") return "RETRY_SAME_CHECKOUT";
  return "STOP"; // unknown: cannot verify the first attempt, so do not pay again
}
