/**
 * Test storefront ("Trailhead Outfitters store") shared by kits 9 and 10.
 *
 * Holds carts, checkouts and orders. Payment runs through the Airwallex
 * payment intents API: create an intent for the checkout total, confirm it
 * with the card entered on the hosted payment page. Card data only ever passes
 * from that page to the store's server, never to an agent.
 *
 * Scenario hooks let the demo change a price after approval or make a
 * checkout submission time out after it succeeds.
 */
import { randomUUID } from "node:crypto";
import { AirwallexClient, newRequestId } from "../core/client.ts";
import { buildCatalog, searchProducts, type Product } from "./catalog.ts";

export const MERCHANT = { name: "Trailhead Outfitters store", url: "https://shop.trailhead.example" };

export const DELIVERY = [
  { id: "STANDARD", label: "Standard (5 business days)", price: 6, days: 5 },
  { id: "EXPRESS", label: "Express (2 business days)", price: 14, days: 2 },
] as const;
export type DeliveryId = (typeof DELIVERY)[number]["id"];

export interface Checkout {
  id: string;
  ref: string;
  idempotencyKey?: string;
  items: { sku: string; name: string; unitPrice: number; qty: number }[];
  delivery: { id: DeliveryId; label: string; price: number; days: number };
  total: number;
  currency: "USD";
  status: "OPEN" | "PAID" | "PAYMENT_FAILED";
  paymentIntentId?: string;
  attempts: { at: string; outcome: string; last4: string }[];
  orderNumber?: string;
  createdAt: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export class Store {
  readonly catalog: Product[] = buildCatalog();
  private checkouts = new Map<string, Checkout>();
  private byKey = new Map<string, string>();
  private orderSeq = 10040;
  /** Demo hook: delay the response of the next payment submission (it still completes). */
  slowNextPaymentMs = 0;

  constructor(private readonly awx: AirwallexClient) {}

  product(sku: string) {
    return this.catalog.find((p) => p.sku === sku);
  }
  search(q: string, f?: Parameters<typeof searchProducts>[2]) {
    return searchProducts(this.catalog, q, f);
  }
  /** Merchant changes a price (affects checkouts that are not yet paid). */
  setPrice(sku: string, price: number) {
    const p = this.product(sku);
    if (p) p.price = price;
    for (const c of this.checkouts.values()) {
      if (c.status === "PAID") continue;
      this.reprice(c);
      c.paymentIntentId = undefined; // the old intent was for the old total; the next payment creates a new one
    }
  }

  private reprice(c: Checkout) {
    for (const i of c.items) i.unitPrice = this.product(i.sku)!.price;
    c.total = r2(c.items.reduce((s, i) => s + i.unitPrice * i.qty, 0) + c.delivery.price);
  }

  /** Same idempotency key → same checkout, so an agent retry never creates a second order. */
  createCheckout(items: { sku: string; qty: number }[], delivery: DeliveryId, idempotencyKey?: string): Checkout {
    if (idempotencyKey && this.byKey.has(idempotencyKey)) return this.checkouts.get(this.byKey.get(idempotencyKey)!)!;
    const d = DELIVERY.find((x) => x.id === delivery) ?? DELIVERY[0];
    const lines = items.map((i) => {
      const p = this.product(i.sku);
      if (!p) throw new Error(`Unknown product ${i.sku}`);
      if (p.stock < i.qty) throw new Error(`${p.name} is out of stock`);
      return { sku: p.sku, name: p.name, unitPrice: p.price, qty: i.qty };
    });
    const c: Checkout = { id: randomUUID(), ref: `CO-${Date.now().toString(36).toUpperCase()}`, idempotencyKey, items: lines, delivery: { ...d }, total: 0, currency: "USD", status: "OPEN", attempts: [], createdAt: new Date().toISOString() };
    this.reprice(c);
    this.checkouts.set(c.id, c);
    if (idempotencyKey) this.byKey.set(idempotencyKey, c.id);
    return c;
  }

  getCheckout(id: string) {
    return this.checkouts.get(id) ?? [...this.checkouts.values()].find((c) => c.ref === id);
  }

  /** Called by the hosted payment page. Returns the updated checkout. */
  async pay(checkoutId: string, card: { number: string; expiry_month: string; expiry_year: string; cvc: string; name: string }): Promise<Checkout> {
    const c = this.getCheckout(checkoutId);
    if (!c) throw new Error("Unknown checkout");
    if (c.status === "PAID") return c; // never charge a paid checkout twice
    if (!c.paymentIntentId) {
      const pi = await this.awx.post("/pa/payment_intents/create", { request_id: newRequestId(), amount: c.total, currency: c.currency, merchant_order_id: c.ref, descriptor: "TRAILHEAD STORE" });
      c.paymentIntentId = pi.id;
    }
    const res = await this.awx.post(`/pa/payment_intents/${c.paymentIntentId}/confirm`, {
      request_id: newRequestId(),
      payment_method: { type: "card", card },
      payment_method_options: { card: { auto_capture: true } },
    });
    const ok = res.status === "SUCCEEDED";
    c.attempts.push({ at: new Date().toISOString(), outcome: ok ? "SUCCEEDED" : `${res.latest_payment_attempt?.failure_code ?? "failed"}: ${res.latest_payment_attempt?.failure_message ?? res.status}`, last4: card.number.slice(-4) });
    if (ok) {
      c.status = "PAID";
      c.orderNumber = `TRL-ORD-${this.orderSeq++}`;
      for (const i of c.items) this.product(i.sku)!.stock -= i.qty;
    } else c.status = "PAYMENT_FAILED";
    return c;
  }
}
