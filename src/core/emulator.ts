/**
 * Card emulator for sandbox accounts where Airwallex has not enabled card
 * issuing or card acceptance. It answers the same paths with the same shapes
 * and follows the documented rules:
 *
 *  Issuing  — virtual cards go ACTIVE; authorization controls are enforced in
 *             the order currency → merchant category → limits; PER_TRANSACTION
 *             limits are inclusive; MONTHLY / ALL_TIME are cumulative; a card
 *             that is not ACTIVE declines with CARD_INACTIVE.
 *  Payments — payment intents confirm with the sandbox test card; disputes move
 *             RFI → (challenge) → escalate → CHARGEBACK / REQUIRES_RESPONSE →
 *             resolve; escalating from CHARGEBACK is rejected; PRE_CHARGEBACK
 *             auto-accepts; challenges at CHARGEBACK need product_type.
 *
 * Every object it returns carries `_emulated: true`.
 */
import { randomUUID } from "node:crypto";
import { AwxError } from "./client.ts";

type Obj = Record<string, any>;
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "+0000");
const fail = (status: number, code: string, message: string, path: string): never => {
  throw new AwxError(status, code, message, { code, message, emulated: true }, path);
};

const TEST_CARDS = new Set(["4035501000000008", "4012000300001003", "4111111111111111", "4242424242424242", "5555555555554444", "2223000010181375", "5307837360544518", "4646464646464644"]);
/** Documented sandbox decline triggers: Mastercard test cards decline by amount; 4646… is always risk-declined. */
const DECLINES: { cards: string[]; amount?: number; code: string; message: string }[] = [
  { cards: ["2223000010181375", "5307837360544518"], amount: 80.51, code: "issuer_declined", message: "Insufficient Funds (51)" },
  { cards: ["2223000010181375", "5307837360544518"], amount: 80.05, code: "issuer_declined", message: "Do not Honor (05)" },
  { cards: ["4646464646464644"], code: "risk_declined", message: "Declined by fraud risk engine" },
];
const DISPUTE_CODES: Record<string, { type: string; description: string }> = {
  "10.4": { type: "FRAUD", description: "Other Fraud - Card Absent Environment" },
  "13.1": { type: "PRODUCT_NOT_RECEIVED", description: "Merchandise/Services Not Received" },
  "13.6": { type: "CREDIT_NOT_PROCESSED", description: "Credit Not Processed" },
};

/** Optional wallet hooks: on-behalf cards draw from the customer's wallet (platform kits). */
export interface CardFunding {
  /** Return a decline reason (e.g. INSUFFICIENT_FUNDS) or null when the owner can cover the amount. */
  check(owner: string, amount: number, currency: string): string | null;
  debit(owner: string, amount: number, currency: string): void;
}

export class CardEmulator {
  constructor(private readonly funding?: CardFunding) {}
  /** card_id → owning account (x-on-behalf-of), for funding checks. */
  readonly owners = new Map<string, string>();
  private cards = new Map<string, Obj>();
  private txs: Obj[] = [];
  private intents = new Map<string, Obj>();
  private disputes = new Map<string, Obj>();
  private refunds: Obj[] = [];
  private requestIds = new Map<string, string>();

  handle(method: "GET" | "POST", path: string, body: Obj = {}, query: Obj = {}): Obj {
    if (method === "POST" && body.request_id) {
      const key = `${path}`;
      const seen = this.requestIds.get(body.request_id);
      if (seen && seen !== key) fail(400, "duplicate_request_id", "The request_id has been used for a different request.", path);
      this.requestIds.set(body.request_id, key);
    }
    let m: RegExpMatchArray | null;
    const route = (re: RegExp) => (m = path.match(re));

    // ── Issuing ──────────────────────────────────────────────────────────
    if (method === "POST" && route(/^\/issuing\/cards\/create$/)) return this.createCard(body);
    if (method === "GET" && route(/^\/issuing\/cards\/([\w-]+)\/limits$/)) return this.limits(this.card(m![1]!, path));
    if (method === "POST" && route(/^\/issuing\/cards\/([\w-]+)\/update$/)) return this.updateCard(this.card(m![1]!, path), body);
    if (method === "GET" && route(/^\/issuing\/cards\/([\w-]+)$/)) return this.card(m![1]!, path);
    if (method === "GET" && route(/^\/issuing\/cards$/)) return { has_more: false, items: [...this.cards.values()] };
    if (method === "GET" && route(/^\/issuing\/transactions$/)) {
      return { has_more: false, items: this.txs.filter((t) => !query.card_id || t.card_id === query.card_id) };
    }
    if (method === "POST" && route(/^\/simulation\/issuing\/create$/)) return this.authorize(body, path);
    if (method === "POST" && route(/^\/simulation\/issuing\/([\w-]+)\/capture$/)) return this.settleTx(m![1]!, "CLEARING", path);
    if (method === "POST" && route(/^\/simulation\/issuing\/([\w-]+)\/reverse$/)) return this.settleTx(m![1]!, "REVERSAL", path);

    // ── Payments and disputes ────────────────────────────────────────────
    if (method === "POST" && route(/^\/pa\/payment_intents\/create$/)) return this.createIntent(body);
    if (method === "POST" && route(/^\/pa\/payment_intents\/([\w-]+)\/confirm$/)) return this.confirmIntent(this.intent(m![1]!, path), body, path);
    if (method === "GET" && route(/^\/pa\/payment_intents\/([\w-]+)$/)) return this.intent(m![1]!, path);
    if (method === "POST" && route(/^\/simulation\/pa\/payment_disputes\/create$/)) return this.createDispute(body, path);
    if (method === "POST" && route(/^\/simulation\/pa\/payment_disputes\/([\w-]+)\/escalate$/)) return this.escalate(this.dispute(m![1]!, path), body, path);
    if (method === "POST" && route(/^\/simulation\/pa\/payment_disputes\/([\w-]+)\/resolve$/)) return this.resolve(this.dispute(m![1]!, path), body);
    if (method === "POST" && route(/^\/pa\/payment_disputes\/([\w-]+)\/accept$/)) return this.accept(this.dispute(m![1]!, path), body, path);
    if (method === "POST" && route(/^\/pa\/payment_disputes\/([\w-]+)\/challenge$/)) return this.challenge(this.dispute(m![1]!, path), body, path);
    if (method === "GET" && route(/^\/pa\/payment_disputes\/([\w-]+)$/)) return this.dispute(m![1]!, path);
    if (method === "GET" && route(/^\/pa\/payment_disputes$/)) return { items: [...this.disputes.values()] };
    if (method === "GET" && route(/^\/pa\/refunds$/)) return { items: this.refunds };

    return fail(404, "not_found", `Emulator does not handle ${method} ${path}`, path);
  }

  /** True for the paths a given rail owns. */
  static owns(rail: "issuing" | "payments", path: string): boolean {
    return rail === "issuing"
      ? /^\/(issuing\/(cards|transactions)|simulation\/issuing)/.test(path)
      : /^\/(pa\/|simulation\/pa\/)/.test(path);
  }

  // ── Issuing internals ──────────────────────────────────────────────────
  private card(id: string, path: string) {
    return this.cards.get(id) ?? fail(404, "resource_not_found", `Card ${id} not found`, path);
  }

  private createCard(b: Obj) {
    const ac = b.authorization_controls ?? {};
    const card = {
      _emulated: true,
      card_id: randomUUID(),
      cardholder_id: b.cardholder_id,
      card_number: `4035 50** **** ${String(Math.floor(1000 + Math.random() * 9000))}`,
      brand: "VISA",
      card_status: "ACTIVE", // virtual cards activate automatically
      form_factor: b.form_factor ?? "VIRTUAL",
      is_personalized: Boolean(b.is_personalized),
      nick_name: b.nick_name,
      purpose: b.purpose,
      program: { purpose: "COMMERCIAL", type: "DEBIT", ...(b.program ?? {}) },
      created_by: b.created_by,
      created_at: now(),
      authorization_controls: {
        allowed_transaction_count: ac.allowed_transaction_count ?? "MULTIPLE",
        allowed_currencies: ac.allowed_currencies ?? [],
        allowed_merchant_categories: ac.allowed_merchant_categories ?? [],
        transaction_limits: ac.transaction_limits ?? { currency: "USD", limits: [{ amount: 10000, interval: "PER_TRANSACTION" }] },
      },
    };
    this.cards.set(card.card_id, card);
    return card;
  }

  private updateCard(card: Obj, b: Obj) {
    if (b.card_status) card.card_status = b.card_status;
    if (b.authorization_controls) card.authorization_controls = { ...card.authorization_controls, ...b.authorization_controls };
    card.updated_at = now();
    return card;
  }

  private spent(cardId: string, interval: string) {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    return this.txs
      .filter((t) => t.card_id === cardId && t.status !== "FAILED" && t.transaction_type !== "REVERSAL")
      .filter((t) => interval === "ALL_TIME" || (interval === "MONTHLY" && new Date(t.created_at.replace("+0000", "Z")) >= monthStart))
      .reduce((s, t) => s + t.transaction_amount, 0);
  }

  private limits(card: Obj) {
    const tl = card.authorization_controls.transaction_limits;
    return {
      _emulated: true,
      currency: tl.currency,
      limits: tl.limits.map((l: Obj) => ({ ...l, remaining: l.interval === "PER_TRANSACTION" ? l.amount : Math.max(0, l.amount - this.spent(card.card_id, l.interval)) })),
    };
  }

  private decline(card: Obj, b: Obj): string | null {
    if (card.card_status !== "ACTIVE") return "CARD_INACTIVE";
    const ac = card.authorization_controls;
    if (ac.allowed_currencies.length && !ac.allowed_currencies.includes(b.transaction_currency)) return "CURRENCY_NOT_ALLOWED";
    if (ac.allowed_merchant_categories.length && !ac.allowed_merchant_categories.includes(b.merchant_category_code)) return "MERCHANT_CATEGORY_NOT_ALLOWED";
    for (const l of ac.transaction_limits.limits) {
      const used = l.interval === "PER_TRANSACTION" ? 0 : this.spent(card.card_id, l.interval);
      if (used + Number(b.transaction_amount) > l.amount) return "LIMIT_EXCEEDED"; // inclusive: equal to the limit passes
    }
    if (ac.allowed_transaction_count === "SINGLE" && this.txs.some((t) => t.card_id === card.card_id && t.status !== "FAILED")) return "LIMIT_EXCEEDED";
    return b.transaction_failure_reason ?? null;
  }

  private authorize(b: Obj, path: string) {
    const card = this.card(b.card_id, path);
    const owner = this.owners.get(card.card_id);
    // Airwallex checks funding before card controls: an unfunded wallet declines first.
    const fundingReason = owner && this.funding && card.card_status === "ACTIVE" ? this.funding.check(owner, Number(b.transaction_amount), b.transaction_currency) : null;
    const reason = fundingReason ?? this.decline(card, b);
    if (!reason && owner && this.funding) this.funding.debit(owner, Number(b.transaction_amount), b.transaction_currency);
    const tx = {
      _emulated: true,
      transaction_id: randomUUID(),
      card_id: card.card_id,
      card_nickname: card.nick_name,
      transaction_amount: Number(b.transaction_amount),
      transaction_currency: b.transaction_currency,
      billing_amount: Number(b.transaction_amount),
      billing_currency: b.transaction_currency,
      merchant: { name: b.merchant_info ?? "", category_code: b.merchant_category_code ?? "" },
      transaction_type: reason ? "AUTHORIZATION" : b.single_phase ? "CLEARING" : "AUTHORIZATION",
      status: reason ? "FAILED" : "PENDING",
      failure_reason: reason ?? undefined,
      created_at: now(),
    };
    this.txs.push(tx);
    return tx;
  }

  private settleTx(id: string, type: string, path: string) {
    const tx = this.txs.find((t) => t.transaction_id === id) ?? fail(404, "resource_not_found", `Transaction ${id} not found`, path);
    tx.transaction_type = type;
    return tx;
  }

  // ── Payments internals ─────────────────────────────────────────────────
  private intent(id: string, path: string) {
    return this.intents.get(id) ?? fail(404, "resource_not_found", `PaymentIntent ${id} not found`, path);
  }

  private createIntent(b: Obj) {
    const pi = { _emulated: true, id: `int_emu_${randomUUID().replace(/-/g, "").slice(0, 18)}`, request_id: b.request_id, amount: Number(b.amount), currency: b.currency, merchant_order_id: b.merchant_order_id, descriptor: b.descriptor, status: "REQUIRES_PAYMENT_METHOD", created_at: now() };
    this.intents.set(pi.id, pi);
    return pi;
  }

  private confirmIntent(pi: Obj, b: Obj, path: string) {
    const number = String(b.payment_method?.card?.number ?? "");
    if (!TEST_CARDS.has(number)) fail(400, "validation_error", "Use a sandbox test card number.", path);
    const decline = DECLINES.find((d) => d.cards.includes(number) && (d.amount === undefined || d.amount === pi.amount));
    if (decline) {
      pi.status = "REQUIRES_PAYMENT_METHOD"; // a declined attempt leaves the intent open for another card
      pi.latest_payment_attempt = { id: `att_emu_${randomUUID().slice(0, 8)}`, status: "FAILED", failure_code: decline.code, failure_message: decline.message, payment_method: { type: "card", card: { last4: number.slice(-4), brand: number.startsWith("4") ? "visa" : "mastercard" } } };
      pi.attempts = [...(pi.attempts ?? []), pi.latest_payment_attempt];
      return pi;
    }
    pi.status = b.payment_method_options?.card?.auto_capture === false ? "REQUIRES_CAPTURE" : "SUCCEEDED";
    pi.latest_payment_attempt = { id: `att_emu_${randomUUID().slice(0, 8)}`, status: pi.status === "SUCCEEDED" ? "SETTLED" : "AUTHORIZED", payment_method: { type: "card", card: { last4: number.slice(-4), brand: "visa" } } };
    return pi;
  }

  private dispute(id: string, path: string) {
    return this.disputes.get(id) ?? fail(404, "resource_not_found", `PaymentDispute ${id} not found`, path);
  }

  private createDispute(b: Obj, path: string) {
    const pi = this.intent(b.payment_intent_id, path);
    if (pi.status !== "SUCCEEDED") fail(400, "validation_error", "The PaymentIntent has no captured payment to dispute.", path);
    const code = DISPUTE_CODES[b.reason_code] ?? fail(400, "validation_error", `Invalid reason_code ${b.reason_code} for VISA`, path);
    const d = {
      _emulated: true,
      id: `dst_emu_${randomUUID().replace(/-/g, "").slice(0, 14)}`,
      payment_intent_id: pi.id,
      merchant_order_id: pi.merchant_order_id,
      amount: Number(b.amount ?? pi.amount),
      currency: pi.currency,
      stage: b.stage,
      status: b.stage === "PRE_CHARGEBACK" ? "ACCEPTED" : "REQUIRES_RESPONSE", // PRE_CHARGEBACK auto-accepts
      reason: { original_code: b.reason_code, type: code.type, description: code.description },
      due_at: b.due_at,
      issuer_comment: b.comment,
      payment_method_type: "card",
      created_at: now(),
      updated_at: now(),
      history: [] as Obj[],
    };
    this.disputes.set(d.id, d);
    return d;
  }

  private requireResponse(d: Obj, path: string) {
    if (d.status !== "REQUIRES_RESPONSE") fail(400, "validation_error", `Dispute is ${d.status}; it can be answered only in REQUIRES_RESPONSE.`, path);
  }

  private accept(d: Obj, b: Obj, path: string) {
    this.requireResponse(d, path);
    d.status = "ACCEPTED";
    d.accept_details = { reason: b.reason ?? "OTHERS", accepted_by: b.accepted_by, description: b.description };
    if (d.stage === "RFI") {
      const refund = { _emulated: true, id: `rfd_emu_${randomUUID().slice(0, 8)}`, payment_intent_id: d.payment_intent_id, amount: Number(b.refund?.amount ?? d.amount), currency: d.currency, reason: b.refund?.reason ?? "OTHERS", status: "SUCCEEDED", created_at: now() };
      this.refunds.push(refund);
      d.refunds = [refund.id];
    }
    d.history.push({ at: now(), event: "ACCEPTED", stage: d.stage });
    d.updated_at = now();
    return d;
  }

  private challenge(d: Obj, b: Obj, path: string) {
    this.requireResponse(d, path);
    if ((d.stage === "CHARGEBACK" || d.stage === "PRE_ARBITRATION") && !b.product_type) {
      fail(400, "validation_error", "product_type is required when the Payment Dispute stage is CHARGEBACK.", path);
    }
    const files = (b.supporting_documents?.documents ?? []).flatMap((x: Obj) => x.file_ids ?? []);
    d.status = "CHALLENGED";
    d.challenge_details = { reason: b.reason, challenged_by: b.challenged_by, files };
    d.history.push({ at: now(), event: "CHALLENGED", stage: d.stage, reason: b.reason, files: files.length });
    d.updated_at = now();
    return d;
  }

  private escalate(d: Obj, b: Obj, path: string) {
    if (d.stage === "CHARGEBACK" || d.stage === "PRE_ARBITRATION") fail(400, "validation_error", "Dispute transition is not supported", path);
    d.stage = "CHARGEBACK";
    d.status = "REQUIRES_RESPONSE";
    d.due_at = b.due_at ?? d.due_at;
    d.issuer_comment = b.comment ?? d.issuer_comment;
    d.history.push({ at: now(), event: "ESCALATED", stage: d.stage });
    d.updated_at = now();
    return d;
  }

  private resolve(d: Obj, b: Obj) {
    d.status = b.in_favor_of === "MERCHANT" ? "WON" : "LOST";
    d.history.push({ at: now(), event: d.status, stage: d.stage });
    d.updated_at = now();
    return d;
  }
}
