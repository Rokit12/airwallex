/**
 * Client for the platform kits (5–8). Tries the live sandbox first. If Airwallex
 * refuses to open a connected account ("This account cannot onboard ..."), the
 * platform rail switches to the PlatformEmulator for the rest of the run:
 * every call goes there except FX rates and quotes, which stay live so
 * conversions use real Airwallex prices. RAILS=live disables the fallback.
 *
 * Card issuing stays live even then. Cards a customer would hold are issued on
 * the platform's own Airwallex account (cardholder per customer email), and
 * authorizations run on Airwallex. Because the customer's wallet is emulated,
 * the platform mirrors it onto the card before each authorization: the card's
 * per-transaction limit is set to min(platform control, wallet balance), so
 * Airwallex itself approves or declines. Approved spend is debited from the
 * emulated wallet. A decline caused by the wallet mirror is reported as
 * INSUFFICIENT_FUNDS, with Airwallex's own reason kept in airwallex_failure_reason.
 */
import { AirwallexClient, AwxError, newRequestId, type CallOptions } from "./client.ts";
import { PlatformEmulator } from "./platform-emulator.ts";
import { audit } from "./audit.ts";
import { say } from "./narrate.ts";

const LIVE_ALWAYS = /^\/(fx\/rates\/current|fx\/quotes\/create|reference\/)/;
const FEE_UNCONFIGURED = new Set(["unconfigured_client_fee", "fee_unknown"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CARD_PATH = /^\/(issuing|simulation\/issuing)\//;
type Controls = { transaction_limits?: { currency: string; limits: { amount: number; interval: string }[] }; [k: string]: unknown };

export class PlatformClient extends AirwallexClient {
  mode: "live" | "emulated" = process.env.RAILS === "emulated" ? "emulated" : "live";
  readonly emu: PlatformEmulator;
  /** Live card_id → { connected account it belongs to, controls the platform set }. */
  private readonly liveCards = new Map<string, { owner: string; controls: Controls }>();
  /** Bodies of beneficiaries created on a customer's behalf, so a rerouted payout can recreate them on the platform. */
  private readonly beneficiaryBodies = new Map<string, unknown>();
  /** Transfers that were paid out from the platform account for a customer: id → customer. */
  private readonly rerouted = new Map<string, string>();
  private routeViaPlatform = false;
  /** Set when Airwallex's authorization simulator refuses this account. */
  private authEmulated = process.env.RAILS === "emulated";

  constructor() {
    super();
    // Live mid-market-ish client rate for buy/sell, used by emulated conversions.
    this.emu = new PlatformEmulator(async (buy, sell) => {
      if (buy === sell) return 1;
      const q = await super.call("GET", "/fx/rates/current", { query: { buy_currency: buy, sell_currency: sell, buy_amount: 1000 } });
      // Airwallex quotes the pair as BASE/QUOTE: if buy is the base, rate = sell per buy.
      return String(q.currency_pair).startsWith(buy) ? Number(q.rate) : 1 / Number(q.rate);
    });
  }

  override async call<T = any>(method: "GET" | "POST", path: string, opts: CallOptions = {}): Promise<T> {
    if (this.mode === "emulated" && CARD_PATH.test(path) && process.env.RAILS !== "emulated") return this.liveCard<T>(method, path, opts);
    if (this.mode === "emulated" && !LIVE_ALWAYS.test(path)) return this.emulate<T>(method, path, opts);
    if (this.mode === "live") {
      const t = path.match(/^\/(?:simulation\/)?transfers\/([\w-]+)/);
      if (t && this.rerouted.has(t[1]!)) return super.call<T>(method, path, { ...opts, onBehalfOf: undefined });
      if (this.routeViaPlatform && opts.onBehalfOf && method === "POST" && (path === "/fx/conversions/create" || path === "/transfers/create")) return this.viaPlatform<T>(path, opts);
    }
    try {
      const res = await super.call<T>(method, path, opts);
      if (method === "POST" && path === "/beneficiaries/create" && opts.onBehalfOf) this.beneficiaryBodies.set(String((res as any).id ?? (res as any).beneficiary_id), opts.body);
      return res;
    } catch (err) {
      if (err instanceof AwxError && FEE_UNCONFIGURED.has(err.code) && opts.onBehalfOf && method === "POST" && (path === "/fx/conversions/create" || path === "/transfers/create")) {
        if (!this.routeViaPlatform) {
          this.routeViaPlatform = true;
          say.warn(`Airwallex has not configured FX and payout pricing inside connected accounts (${err.code}). Routing each customer's FX and payouts through the platform, live: the customer's own balance is charged, the platform converts or pays out, and converted money goes back to the customer. Customer funds are still never mixed.`);
          audit({ kind: "rail_switch", rail: "connected_account_fx_payouts", to: "via_platform", cause: err.message });
        }
        return this.viaPlatform<T>(path, opts);
      }
      if (err instanceof AwxError && path === "/accounts/create" && /cannot onboard/i.test(err.message) && process.env.RAILS !== "live") {
        this.mode = "emulated";
        say.warn(`Airwallex has not enabled connected accounts on this sandbox account ("${(err.message.split(" (")[0] ?? "").replace(/^400 \w+: /, "")}"). Running the platform rail on the platform emulator; FX rates stay live. Results are labelled EMULATED.`);
        audit({ kind: "rail_switch", rail: "platform", to: "emulated", cause: err.message });
        return this.emulate<T>(method, path, opts);
      }
      throw err;
    }
  }

  /**
   * Charge a customer. A deposit that just landed can take a moment to become
   * available; insufficient_fund is a definite refusal (nothing was created), so
   * each retry is a new request.
   */
  private async chargeOwner(body: Record<string, unknown>) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await super.call<any>("POST", "/charges/create", { body: { ...body, request_id: newRequestId() } });
      } catch (err) {
        if (!(err instanceof AwxError && err.code === "insufficient_fund") || attempt >= 6) throw err;
        await sleep(2500);
      }
    }
  }

  private async settle(kind: "charges" | "connected_account_transfers", id: string) {
    let status = "";
    for (let i = 0; i < 16; i++) {
      try {
        status = (await super.call<any>("GET", `/${kind}/${id}`)).status;
      } catch (err) {
        if (!(err instanceof AwxError && err.status === 404) || i >= 10) throw err;
        status = "NOT_VISIBLE_YET";
      }
      if (status === "SETTLED" || status === "FAILED") break;
      await sleep(1500);
    }
    if (status !== "SETTLED") throw new Error(`${kind} ${id} ended ${status}`);
  }

  /**
   * FX or a payout for a connected account, routed through the platform account
   * (live). Only the customer's own balance funds it.
   */
  private async viaPlatform<T>(path: string, opts: CallOptions): Promise<T> {
    const owner = opts.onBehalfOf!;
    const b = (opts.body ?? {}) as any;
    const ref = `ROUTED-${owner.slice(-6)}-${Date.now().toString(36)}`.toUpperCase();
    if (path === "/fx/conversions/create") {
      const q = await super.call<any>("POST", "/fx/quotes/create", { body: { request_id: newRequestId(), buy_currency: b.buy_currency, sell_currency: b.sell_currency, ...(b.buy_amount ? { buy_amount: b.buy_amount } : { sell_amount: b.sell_amount }), validity: "MIN_1" } });
      const charge = await this.chargeOwner({ request_id: newRequestId(), amount: Number(q.sell_amount), currency: b.sell_currency, source: owner, reason: "professional_business_services", reference: `${ref}-FX` });
      await this.settle("charges", charge.id);
      const conv = await super.call<any>("POST", "/fx/conversions/create", { body: { request_id: b.request_id ?? newRequestId(), quote_id: q.quote_id, buy_currency: b.buy_currency, sell_currency: b.sell_currency, ...(b.buy_amount ? { buy_amount: b.buy_amount } : { sell_amount: b.sell_amount }) } });
      const back = await super.call<any>("POST", "/connected_account_transfers/create", { body: { request_id: newRequestId(), amount: Number(conv.buy_amount), currency: b.buy_currency, destination: owner, reason: "business_expenses", reference: `${ref}-FX` } });
      await this.settle("connected_account_transfers", back.id);
      audit({ kind: "routed_via_platform", what: "fx", owner, charge: charge.id, conversion: conv.id, transfer_back: back.id });
      return { ...conv, routed_via_platform: true, charge_id: charge.id, connected_account_transfer_id: back.id } as T;
    }
    const benBody = this.beneficiaryBodies.get(String(b.beneficiary_id));
    if (!benBody) throw new Error(`cannot reroute payout: beneficiary ${b.beneficiary_id} was not created in this run`);
    const ben = await super.call<any>("POST", "/beneficiaries/create", { body: { ...(benBody as object), request_id: newRequestId() } });
    const charge = await this.chargeOwner({ request_id: newRequestId(), amount: Number(b.transfer_amount), currency: b.source_currency ?? b.transfer_currency, source: owner, reason: "professional_business_services", reference: `${ref}-PAYOUT` });
    await this.settle("charges", charge.id);
    const tr = await super.call<any>("POST", "/transfers/create", { body: { ...b, request_id: b.request_id ?? newRequestId(), beneficiary_id: ben.id ?? ben.beneficiary_id } });
    this.rerouted.set(tr.id, owner);
    audit({ kind: "routed_via_platform", what: "payout", owner, charge: charge.id, transfer: tr.id });
    return { ...tr, routed_via_platform: true, charge_id: charge.id } as T;
  }

  /** Card issuing on the live Airwallex account for an emulated connected account (see header). */
  private async liveCard<T>(method: "GET" | "POST", path: string, opts: CallOptions): Promise<T> {
    const owner = opts.onBehalfOf;
    const body = (opts.body ?? {}) as any;
    const live = (b?: unknown) => super.call<any>(method, path, { ...opts, body: b ?? opts.body, onBehalfOf: undefined });

    if (method === "POST" && path === "/issuing/cardholders/create") {
      const found = await super.call<any>("GET", "/issuing/cardholders", { query: { email: body.email } }).catch(() => ({ items: [] }));
      const existing = (found.items ?? []).find((h: any) => h.email === body.email);
      return (existing ?? (await live())) as T;
    }
    if (method === "POST" && path === "/issuing/cards/create") {
      const card = await live();
      if (owner) this.liveCards.set(card.card_id, { owner, controls: body.authorization_controls ?? {} });
      return card as T;
    }
    if (method === "POST" && path === "/simulation/issuing/create" && this.liveCards.has(body.card_id) && this.authEmulated) {
      const { owner: acct, controls } = this.liveCards.get(body.card_id)!;
      this.emu.cards.adoptCard(await super.call<any>("GET", `/issuing/cards/${body.card_id}`), acct, controls);
      return this.emulate<T>(method, path, opts);
    }
    if (method === "POST" && path === "/simulation/issuing/create" && this.liveCards.has(body.card_id)) {
      const { owner: acct, controls } = this.liveCards.get(body.card_id)!;
      const ccy = String(body.transaction_currency ?? "USD");
      const wallet = this.emu.bal(acct, ccy);
      const limits = controls.transaction_limits?.limits ?? [];
      const perTx = limits.find((l) => l.interval === "PER_TRANSACTION")?.amount ?? Infinity;
      const mirror = Math.max(0.01, Math.min(perTx, Math.floor(wallet * 100) / 100));
      await super.call("POST", `/issuing/cards/${body.card_id}/update`, {
        body: { authorization_controls: { ...controls, transaction_limits: { currency: controls.transaction_limits?.currency ?? ccy, limits: [...limits.filter((l) => l.interval !== "PER_TRANSACTION"), { amount: mirror, interval: "PER_TRANSACTION" }] } } },
      });
      audit({ kind: "card_wallet_mirror", card: body.card_id, owner: acct, wallet, per_transaction_limit: mirror });
      let tx: any;
      try {
        tx = await live();
      } catch (err) {
        if (!(err instanceof AwxError && err.code === "bad_request" && /failed to process transaction/i.test(err.message)) || process.env.RAILS === "live") throw err;
        this.authEmulated = true;
        say.warn(`Airwallex's card authorization simulator refused this account ("failed to process transaction"). Cards stay live; authorizations are checked by the card emulator against each card's controls and the customer's wallet, labelled EMULATED.`);
        audit({ kind: "rail_switch", rail: "card_authorizations", to: "emulated", cause: err.message });
        return this.liveCard<T>(method, path, opts);
      }
      const declined = Boolean(tx.failure_reason) || tx.status === "FAILED";
      if (!declined) this.emu.move(acct, ccy, -Number(body.transaction_amount));
      else if (Number(body.transaction_amount) > wallet && Number(body.transaction_amount) <= perTx) {
        tx.airwallex_failure_reason = tx.failure_reason;
        tx.failure_reason = "INSUFFICIENT_FUNDS";
      }
      return tx as T;
    }
    return (await live()) as T;
  }

  private async emulate<T>(method: "GET" | "POST", path: string, opts: CallOptions): Promise<T> {
    try {
      const res = await this.emu.handle(method, path, (opts.body ?? {}) as any, (opts.query ?? {}) as any, opts.onBehalfOf);
      audit({ kind: "call", emulated: true, method, path, onBehalfOf: opts.onBehalfOf, status: 200, req: opts.body, res });
      return res as T;
    } catch (err) {
      audit({ kind: "call", emulated: true, method, path, onBehalfOf: opts.onBehalfOf, status: (err as AwxError).status, req: opts.body, error: (err as Error).message });
      throw err;
    }
  }

  /** Fund the platform's own USD wallet with a simulated deposit (live or emulated). */
  async fundPlatform(amount: number, payer: string) {
    const gas = await this.get<{ items: any[] }>("/global_accounts");
    const usd = (gas.items ?? []).find((g) => g.currency === "USD") ?? (await this.post("/global_accounts/create", { request_id: newRequestId(), country_code: "US", required_features: [{ currency: "USD", transfer_method: "LOCAL" }] }));
    await this.post("/simulation/deposit/create", { global_account_id: usd.id, amount, payer_name: payer });
  }
}
