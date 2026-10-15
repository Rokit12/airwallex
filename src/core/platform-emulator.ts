/**
 * Platform emulator for kits 5–8, used only when Airwallex has not enabled
 * connected accounts and platform payments on the sandbox account.
 *
 * It keeps one multi-currency wallet per account (the platform plus each
 * connected account) and follows the behaviour the hackathon guide documents:
 *  - x-on-behalf-of scopes balances, global accounts, deposits, FX, beneficiaries,
 *    transfers and card issuing to one connected account.
 *  - Connected accounts go CREATED → SUBMITTED → ACTIVE (via simulation); FX is
 *    refused before ACTIVE.
 *  - connected_account_transfers (platform → customer) and charges (customer →
 *    platform) return NEW and settle on a later read; reference is required;
 *    reason is a closed enum; destination/source are plain account ids.
 *  - Insufficient funds: transfers → balance_insufficient, charges →
 *    insufficient_fund, conversions → insufficient_funds.
 *  - Transfers made on behalf stay PROCESSING until a simulation transition;
 *    SWIFT payouts carry a flat fee; failures end CANCELLED.
 *  - platform_reports BALANCE_REPORT returns every account's balances.
 *
 * FX uses live Airwallex rates through `rates`. Every object carries `_emulated`.
 */
import { randomUUID } from "node:crypto";
import { AwxError } from "./client.ts";
import { CardEmulator } from "./emulator.ts";

type Obj = Record<string, any>;
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "+0000");
const r2 = (n: number) => Math.round(n * 100) / 100;
const fail = (status: number, code: string, message: string, path: string): never => {
  throw new AwxError(status, code, message, { code, message, emulated: true }, path);
};

export const PLATFORM = "platform";
const SWIFT_FEE: Record<string, number> = { EUR: 12.85, GBP: 12.85, USD: 15 };
const TRANSFER_REASONS = new Set(["wages_salary", "professional_business_services", "loan_credit_repayment", "goods_purchased", "business_expenses", "other_services", "investment_capital", "transfer_to_own_account"]);

export type RateFn = (buy: string, sell: string) => Promise<number>;

export class PlatformEmulator {
  private wallets = new Map<string, Map<string, number>>();
  private accounts = new Map<string, Obj>();
  private globalAccounts = new Map<string, Obj>();
  private beneficiaries = new Map<string, Obj>();
  private transfers = new Map<string, Obj>();
  private cats = new Map<string, Obj>();
  private charges = new Map<string, Obj>();
  private reports = new Map<string, Obj>();
  private requestIds = new Map<string, string>();
  readonly cards: CardEmulator;

  constructor(private readonly rates: RateFn) {
    this.cards = new CardEmulator({
      check: (owner, amount, ccy) => (this.bal(owner, ccy) + 1e-9 < amount ? "INSUFFICIENT_FUNDS" : null),
      debit: (owner, amount, ccy) => this.move(owner, ccy, -amount),
    });
  }

  // ── Wallet helpers ─────────────────────────────────────────────────────
  private wallet(acct: string) {
    let w = this.wallets.get(acct);
    if (!w) this.wallets.set(acct, (w = new Map()));
    return w;
  }
  bal(acct: string, ccy: string) {
    return this.wallet(acct).get(ccy) ?? 0;
  }
  private move(acct: string, ccy: string, delta: number) {
    this.wallet(acct).set(ccy, r2(this.bal(acct, ccy) + delta));
  }
  private balances(acct: string) {
    const ccys = new Set(["USD", "EUR", "GBP", ...this.wallet(acct).keys()]);
    return [...ccys].map((c) => ({ currency: c, available_amount: this.bal(acct, c), pending_amount: 0, reserved_amount: 0, total_amount: this.bal(acct, c) }));
  }

  private requireActive(acct: string, path: string, code = "forbidden") {
    if (acct === PLATFORM) return;
    const a = this.accounts.get(acct) ?? fail(404, "resource_not_found", `Account ${acct} not found`, path);
    if (a.status !== "ACTIVE") fail(403, code, `Connected account ${acct} is ${a.status}, not ACTIVE`, path);
  }

  // ── Router ─────────────────────────────────────────────────────────────
  async handle(method: "GET" | "POST", path: string, body: Obj = {}, query: Obj = {}, onBehalfOf?: string): Promise<Obj> {
    const acct = onBehalfOf ?? PLATFORM;
    if (onBehalfOf && !this.accounts.has(onBehalfOf)) fail(400, "invalid_argument", `x-on-behalf-of ${onBehalfOf} is not a connected account of this platform`, path);
    if (method === "POST" && body.request_id) {
      const key = `${acct}:${path}`;
      const seen = this.requestIds.get(body.request_id);
      if (seen && seen !== key) fail(400, "duplicate_request_id", `The request ID ${body.request_id} has been used before`, path);
      if (seen) {
        const prior = this.findByRequestId(body.request_id);
        if (prior) return prior; // same operation retried: return the original
      }
      this.requestIds.set(body.request_id, key);
    }
    let m: RegExpMatchArray | null;
    const route = (re: RegExp) => (m = path.match(re));

    // Connected accounts
    if (method === "POST" && route(/^\/accounts\/create$/)) return this.createAccount(body);
    if (method === "POST" && route(/^\/accounts\/([\w-]+)\/submit$/)) return this.setStatus(m![1]!, "SUBMITTED", path);
    if (method === "POST" && route(/^\/simulation\/accounts\/([\w-]+)\/update_status$/)) return this.setStatus(m![1]!, body.next_status, path);
    if (method === "GET" && route(/^\/accounts\/([\w-]+)$/)) return this.accounts.get(m![1]!) ?? fail(404, "resource_not_found", "Account not found", path);

    // Wallets
    if (method === "GET" && route(/^\/balances\/current$/)) return this.balances(acct) as any;
    if (method === "GET" && route(/^\/global_accounts$/)) return { items: [...this.globalAccounts.values()].filter((g) => g.owner === acct) };
    if (method === "POST" && route(/^\/global_accounts\/create$/)) return this.createGlobalAccount(acct, body);
    if (method === "POST" && route(/^\/simulation\/deposit\/create$/)) return this.deposit(acct, body, path);

    // FX
    if (method === "POST" && route(/^\/fx\/conversions\/create$/)) return this.convert(acct, body, path);

    // Payouts
    if (method === "POST" && route(/^\/beneficiaries\/(create|validate)$/)) return this.beneficiary(acct, body, m![1] === "validate");
    if (method === "POST" && route(/^\/transfers\/create$/)) return this.createTransfer(acct, body, path);
    if (method === "POST" && route(/^\/simulation\/transfers\/([\w-]+)\/transition$/)) return this.transition(m![1]!, body, path);
    if (method === "GET" && route(/^\/transfers\/([\w-]+)$/)) return this.transfers.get(m![1]!) ?? fail(404, "resource_not_found", "Transfer not found", path);
    if (method === "GET" && route(/^\/transfers$/)) return { items: [...this.transfers.values()].filter((t) => t.owner === acct) };

    // Platform money movement
    if (method === "POST" && route(/^\/connected_account_transfers\/create$/)) return this.platformMove("cat", body, path);
    if (method === "GET" && route(/^\/connected_account_transfers\/([\w-]+)$/)) return this.settle(this.cats.get(m![1]!), path);
    if (method === "POST" && route(/^\/charges\/create$/)) return this.platformMove("charge", body, path);
    if (method === "GET" && route(/^\/charges\/([\w-]+)$/)) return this.settle(this.charges.get(m![1]!), path);
    if (method === "POST" && route(/^\/platform_reports\/create$/)) return this.report(body, path);
    if (method === "GET" && route(/^\/platform_reports\/([\w-]+)$/)) return this.reports.get(m![1]!) ?? fail(404, "resource_not_found", "Report not found", path);

    // Card issuing on behalf of a customer
    if (method === "POST" && route(/^\/issuing\/cardholders\/create$/)) return { _emulated: true, cardholder_id: randomUUID(), email: body.email, type: body.type, status: "READY" };
    if (/^\/(issuing|simulation\/issuing)/.test(path)) {
      const res = this.cards.handle(method, path, body, query);
      if (method === "POST" && /^\/issuing\/cards\/create$/.test(path)) this.cards.owners.set(res.card_id, acct);
      return res;
    }
    return fail(404, "not_found", `Platform emulator does not handle ${method} ${path}`, path);
  }

  private findByRequestId(id: string): Obj | undefined {
    for (const map of [this.transfers, this.cats, this.charges, this.globalAccounts, this.accounts]) {
      for (const v of map.values()) if (v.request_id === id) return v;
    }
  }

  // ── Accounts ───────────────────────────────────────────────────────────
  private createAccount(b: Obj) {
    const bd = b.account_details?.business_details ?? {};
    const id = `acct_emu_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const a = {
      _emulated: true,
      id,
      request_id: b.request_id,
      nickname: bd.business_name ?? id,
      status: "CREATED",
      account_details: b.account_details,
      primary_contact: b.primary_contact,
      created_at: now(),
    };
    this.accounts.set(id, a);
    return a;
  }

  private setStatus(id: string, next: string, path: string) {
    const a = this.accounts.get(id) ?? fail(404, "resource_not_found", `Account ${id} not found`, path);
    if (next === "SUBMITTED") {
      const ids = a.account_details?.business_details?.business_identifiers ?? [];
      if (!ids.some((x: Obj) => x.type === "EIN")) a.missing_ein = true; // the guide: no EIN → on-behalf transfers fail later
    }
    a.status = next;
    return a;
  }

  // ── Wallets ────────────────────────────────────────────────────────────
  private createGlobalAccount(acct: string, b: Obj) {
    const ccy = b.required_features?.[0]?.currency ?? "USD";
    const ga = { _emulated: true, id: randomUUID(), request_id: b.request_id, owner: acct, currency: ccy, country_code: b.country_code, status: "ACTIVE", account_number: String(Math.floor(1e9 + Math.random() * 9e9)), required_features: b.required_features };
    this.globalAccounts.set(ga.id, ga);
    return ga;
  }

  private deposit(acct: string, b: Obj, path: string) {
    const ga = this.globalAccounts.get(b.global_account_id) ?? fail(404, "resource_not_found", "Global account not found", path);
    if (ga.owner !== acct) fail(400, "invalid_argument", "Global account belongs to another account; check x-on-behalf-of", path);
    this.move(acct, ga.currency, Number(b.amount));
    return { _emulated: true, id: randomUUID(), amount: Number(b.amount), currency: ga.currency, global_account_id: ga.id, payer_name: b.payer_name, status: "PENDING" }; // posts immediately despite PENDING
  }

  // ── FX ─────────────────────────────────────────────────────────────────
  private async convert(acct: string, b: Obj, path: string) {
    this.requireActive(acct, path);
    const rate = await this.rates(b.buy_currency, b.sell_currency); // sell per 1 buy
    const buy = b.buy_amount != null ? Number(b.buy_amount) : r2(Number(b.sell_amount) / rate);
    const sell = b.sell_amount != null ? Number(b.sell_amount) : r2(buy * rate);
    if (this.bal(acct, b.sell_currency) + 1e-9 < sell) fail(400, "insufficient_funds", `Insufficient ${b.sell_currency} to sell ${sell}`, path);
    this.move(acct, b.sell_currency, -sell);
    this.move(acct, b.buy_currency, buy);
    return { _emulated: true, conversion_id: randomUUID(), request_id: b.request_id, buy_currency: b.buy_currency, sell_currency: b.sell_currency, buy_amount: buy, sell_amount: sell, client_rate: rate, status: "SETTLED", account: acct };
  }

  // ── Payouts ────────────────────────────────────────────────────────────
  private beneficiary(acct: string, b: Obj, validateOnly: boolean) {
    if (validateOnly) return { _emulated: true, valid: true };
    const ben = { _emulated: true, id: randomUUID(), owner: acct, ...b };
    this.beneficiaries.set(ben.id, ben);
    return ben;
  }

  private createTransfer(acct: string, b: Obj, path: string) {
    if (acct !== PLATFORM && this.accounts.get(acct)?.missing_ein) fail(400, "001", "payer is required for transfers on behalf of this account", path);
    const ben = this.beneficiaries.get(b.beneficiary_id) ?? fail(404, "resource_not_found", "Beneficiary not found", path);
    if (ben.owner !== acct) fail(400, "invalid_argument", "Beneficiary belongs to another account; check x-on-behalf-of", path);
    const ccy = b.transfer_currency;
    const amount = Number(b.transfer_amount);
    const fee = b.transfer_method === "SWIFT" ? (SWIFT_FEE[ccy] ?? 15) : 0;
    const source = b.source_currency ?? ccy;
    if (source !== ccy) fail(400, "invalid_argument", "Emulator supports same-currency payouts; convert first", path);
    if (this.bal(acct, ccy) + 1e-9 < amount + fee) fail(400, "balance_insufficient", `Balance ${this.bal(acct, ccy)} ${ccy} cannot cover ${amount} + fee ${fee}`, path);
    this.move(acct, ccy, -(amount + fee));
    const t = { _emulated: true, id: randomUUID(), request_id: b.request_id, owner: acct, beneficiary_id: ben.id, beneficiary: ben.beneficiary, transfer_amount: amount, transfer_currency: ccy, source_currency: source, transfer_method: b.transfer_method, fee_amount: fee, fee_currency: ccy, amount_payer_pays: r2(amount + fee), reference: b.reference, reason: b.reason, status: "PROCESSING", created_at: now() };
    this.transfers.set(t.id, t);
    return t;
  }

  private transition(id: string, b: Obj, path: string) {
    const t = this.transfers.get(id) ?? fail(404, "resource_not_found", "Transfer not found", path);
    const order = ["PROCESSING", "SENT", "PAID"];
    if (b.next_status === "FAILED" || b.next_status === "CANCELLED") {
      t.status = "CANCELLED"; // failures end CANCELLED
      t.failure_type = b.failure_type ?? "OTHER";
      this.move(t.owner, t.transfer_currency, t.transfer_amount); // principal returns; the fee does not
      return { ...t, status: "FAILED" };
    }
    if (order.indexOf(b.next_status) !== order.indexOf(t.status) + 1) fail(400, "invalid_argument", `Cannot move ${t.status} → ${b.next_status}`, path);
    t.status = b.next_status;
    return t;
  }

  // ── Platform money movement ────────────────────────────────────────────
  private platformMove(kind: "cat" | "charge", b: Obj, path: string) {
    if (!b.reference) fail(400, "field_required", "reference is required", path);
    if (!TRANSFER_REASONS.has(b.reason)) fail(400, "invalid_argument", `reason ${b.reason} is not supported`, path);
    const other = kind === "cat" ? b.destination : b.source;
    if (typeof other !== "string") fail(400, "invalid_argument", `${kind === "cat" ? "destination" : "source"} must be an account id string`, path);
    this.requireActive(other, path);
    const from = kind === "cat" ? PLATFORM : other;
    const to = kind === "cat" ? other : PLATFORM;
    const amount = Number(b.amount);
    if (this.bal(from, b.currency) + 1e-9 < amount) fail(400, kind === "charge" ? "insufficient_fund" : "balance_insufficient", `Insufficient ${b.currency} in ${from}`, path);
    this.move(from, b.currency, -amount);
    this.move(to, b.currency, amount);
    const obj = { _emulated: true, id: randomUUID(), request_id: b.request_id, amount, currency: b.currency, [kind === "cat" ? "destination" : "source"]: other, reason: b.reason, reference: b.reference, status: "NEW", created_at: now() };
    (kind === "cat" ? this.cats : this.charges).set(obj.id, obj);
    return { ...obj };
  }

  private settle(o: Obj | undefined, path: string) {
    if (!o) return fail(404, "resource_not_found", "Not found", path);
    o.status = "SETTLED"; // settles by the first read after creation
    return o;
  }

  private report(b: Obj, path: string) {
    if (!b.type) fail(400, "field_required", "type is required", path);
    const rows = [PLATFORM, ...this.accounts.keys()].flatMap((a) =>
      this.balances(a)
        .filter((x) => x.available_amount !== 0)
        .map((x) => ({ account: a === PLATFORM ? "platform" : a, name: a === PLATFORM ? "Platform" : this.accounts.get(a)?.nickname, currency: x.currency, available: x.available_amount })),
    );
    const r = { _emulated: true, id: randomUUID(), type: b.type, file_format: b.file_format ?? "CSV", status: "COMPLETED", rows, created_at: now() };
    this.reports.set(r.id, r);
    return r;
  }
}
