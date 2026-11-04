/**
 * Merchant side of Airwallex Agentic Commerce (kit 10), pure functions only:
 *
 *  - verifySignature(): Airwallex signs every call to the merchant's Create
 *    Checkout endpoint (and every webhook) with a hex HMAC-SHA256 of
 *    `x-timestamp` followed by the raw body. Verify before parsing; reject
 *    stale timestamps.
 *  - checkoutResponse(): prices a cart for Airwallex: stock per line, one
 *    SHIPPING method (plus in-store PICKUP) covering every line, totals in
 *    minor units without a fulfillment row (Airwallex adds the chosen option).
 *  - toGmc(): one catalogue product in Google Merchant Center attributes, the
 *    format Airwallex ingests.
 *
 * Money rules live here, in code: the assistant and Airwallex only see what
 * these functions return.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Product } from "../commerce/catalog.ts";

export const MAX_SKEW_MS = 5 * 60_000;

export function sign(secret: string, timestamp: string, rawBody: string): string {
  return createHmac("sha256", secret).update(timestamp + rawBody).digest("hex");
}

/** True only for a fresh timestamp and a matching signature (constant-time compare). */
export function verifySignature(secret: string, timestamp: string | undefined, rawBody: string, signature: string | undefined, now = Date.now()): boolean {
  if (!secret || !timestamp || !signature || !/^\d{10,16}$/.test(timestamp)) return false;
  const ms = timestamp.length <= 10 ? Number(timestamp) * 1000 : Number(timestamp); // epoch ms per the guide; tolerate seconds
  if (!Number.isFinite(ms) || Math.abs(now - ms) > MAX_SKEW_MS) return false;
  const expected = Buffer.from(sign(secret, timestamp, rawBody), "hex");
  const given = Buffer.from(signature.trim().toLowerCase(), "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const minor = (major: number) => Math.round(major * 100);

export const SHIPPING_OPTIONS = [
  { id: "ship_standard", title: "Standard (5 business days)", carrier: "UPS Ground", cost: 6, days: 5 },
  { id: "ship_express", title: "Express (2 business days)", carrier: "UPS 2nd Day Air", cost: 14, days: 2 },
] as const;
export const PICKUP_STORE = {
  id: "store_denver",
  name: "Trailhead Outfitters Denver",
  address: { street: "1550 Wynkoop Street", city: "Denver", state: "CO", postcode: "80202", country_code: "US" },
};

export interface CheckoutRequest {
  line_items: { id: string; item_id: string; requested_quantity: number }[];
  currency: string;
  customer?: { id?: string; email?: string; first_name?: string; last_name?: string; phone_number?: string };
  shipping_address?: { street?: string; city?: string; state?: string; postcode?: string; country_code?: string };
}

export function validCheckoutRequest(v: any): v is CheckoutRequest {
  return (
    v && Array.isArray(v.line_items) && v.line_items.length > 0 && v.line_items.length <= 50 &&
    v.line_items.every((l: any) => typeof l?.id === "string" && typeof l?.item_id === "string" && Number.isInteger(l?.requested_quantity) && l.requested_quantity > 0 && l.requested_quantity <= 100) &&
    typeof v.currency === "string" && /^[A-Z]{3}$/.test(v.currency)
  );
}

const addDays = (from: Date, d: number) => new Date(from.getTime() + d * 86_400_000).toISOString();

export interface PricedCheckout {
  response: Record<string, unknown>;
  /** What was priced, for the order record. */
  lines: { id: string; sku: string; name: string; unit: number; qty: number }[];
  subtotalMinor: number;
}

/**
 * Prices a cart. Unknown or out-of-stock items get available_quantity 0; a
 * partial stock gets the quantity that can be supplied. Only USD is sold.
 */
export function checkoutResponse(req: CheckoutRequest, catalog: Product[], orderId: string, orderPageUrl: string, now = new Date()): PricedCheckout {
  const sellable = req.currency === "USD";
  const lines = req.line_items.map((l) => {
    const p = catalog.find((x) => x.sku === l.item_id);
    const qty = sellable && p ? Math.min(l.requested_quantity, p.stock) : 0;
    return { li: l, p, qty };
  });
  const subtotalMinor = lines.reduce((s, x) => s + (x.p ? minor(x.p.price) * x.qty : 0), 0);
  const ids = req.line_items.map((l) => l.id);
  const a = req.shipping_address;
  const destinations = a && a.street && a.city && a.country_code
    ? [{ id: "dest_shopper", name: [req.customer?.first_name, req.customer?.last_name].filter(Boolean).join(" ") || "Delivery address", address: { street: a.street, city: a.city, state: a.state ?? "", postcode: a.postcode ?? "", country_code: a.country_code } }]
    : [{ id: "dest_shopper", name: "Delivery address" }];
  const response = {
    id: orderId,
    line_items: lines.map(({ li, qty }) => ({ id: li.id, item_id: li.item_id, requested_quantity: li.requested_quantity, available_quantity: qty })),
    fulfillment: {
      methods: [
        {
          id: "method_shipping",
          type: "SHIPPING",
          line_item_ids: ids,
          destinations,
          options: SHIPPING_OPTIONS.map((o) => ({ id: o.id, title: o.title, carrier: o.carrier, cost: minor(o.cost), description: o.title, earliest_delivery_at: addDays(now, o.days), latest_delivery_at: addDays(now, o.days + 2) })),
        },
        {
          id: "method_pickup",
          type: "PICKUP",
          line_item_ids: ids,
          destinations: [PICKUP_STORE],
          options: [{ id: "pickup_store", title: "Free in-store pickup", cost: 0, description: "Ready next business day", earliest_delivery_at: addDays(now, 1), latest_delivery_at: addDays(now, 2) }],
        },
      ],
    },
    // No fulfillment row: Airwallex adds the selected option's cost.
    totals: [
      { type: "subtotal", amount: subtotalMinor, display_text: "Subtotal" },
      { type: "tax", amount: 0, display_text: "Tax (none on this sandbox store)" },
      { type: "total", amount: subtotalMinor, display_text: "Total" },
    ],
    permalink_url: orderPageUrl,
  };
  return {
    response,
    lines: lines.filter((x) => x.p && x.qty > 0).map(({ li, p, qty }) => ({ id: li.id, sku: p!.sku, name: p!.name, unit: p!.price, qty })),
    subtotalMinor,
  };
}

/** Airwallex's fulfillment rules, checked before we answer (a violation fails the shopper's checkout). */
export function fulfillmentProblems(res: any): string[] {
  const problems: string[] = [];
  const methods: any[] = res?.fulfillment?.methods ?? [];
  const types = methods.map((m) => m.type);
  if (new Set(types).size !== types.length) problems.push("multiple_fulfillment_methods_per_type");
  if (types.some((t) => !["SHIPPING", "PICKUP"].includes(t))) problems.push("unsupported_fulfillment_method_type");
  const lineIds = (res?.line_items ?? []).map((l: any) => l.id);
  if (methods.some((m) => !lineIds.every((id: string) => m.line_item_ids?.includes(id)))) problems.push("fulfillment_does_not_cover_cart");
  const allIds = methods.flatMap((m) => [m.id, ...(m.destinations ?? []).map((d: any) => d.id), ...(m.options ?? []).map((o: any) => o.id)]);
  if (new Set(allIds).size !== allIds.length) problems.push("duplicate_fulfillment_id");
  return problems;
}

const IMAGE: Record<string, string> = { Tents: "tents", Sleeping: "sleeping", Hydration: "hydration", Kitchen: "kitchen", Packs: "packs", Lighting: "lighting" };

/** One product in GMC attributes (snake_case names, "229.00 USD" prices). */
export function toGmc(p: Product, merchantBase: string, imageBase: string): Record<string, string | string[]> {
  return {
    id: p.sku,
    title: p.name,
    description: `${p.description} Ships in ${p.shipsInDays} day${p.shipsInDays === 1 ? "" : "s"}. ${p.returnsAccepted ? "30-day returns." : "Final sale, no returns."}`,
    link: `${merchantBase}/shop/product/${p.sku}`,
    image_link: `${imageBase}/shop/img/${IMAGE[p.category] ?? "packs"}.png`,
    availability: p.stock > 0 ? "in_stock" : "out_of_stock",
    price: `${p.price.toFixed(2)} USD`,
    brand: "Trailhead Outfitters",
    condition: "new",
    product_type: [`Outdoor > ${p.category}`], // repeatable in GMC: Airwallex takes a list
    sku: p.sku,
  };
}

/** Finds our order id (TRL-ORD-…) anywhere in a webhook payload, whatever field Airwallex carries it in. */
export function findOrderId(payload: unknown): string | null {
  const m = JSON.stringify(payload ?? {}).match(/TRL-ORD-[A-Z0-9]{8}/);
  return m ? m[0] : null;
}
