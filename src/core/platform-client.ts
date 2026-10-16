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
const CARD_PATH = /^\/(issuing|simulation\/issuing)\//;
type Controls = { transaction_limits?: { currency: string; limits: { amount: number; interval: string }[] }; [k: string]: unknown };

export class PlatformClient extends AirwallexClient {
  mode: "live" | "emulated" = process.env.RAILS === "emulated" ? "emulated" : "live";
  readonly emu: PlatformEmulator;
  /** Live card_id → { connected account it belongs to, controls the platform set }. */
  private readonly liveCards = new Map<string, { owner: string; controls: Controls }>();

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
    try {
      return await super.call<T>(method, path, opts);
    } catch (err) {
      if (err instanceof AwxError && path === "/accounts/create" && /cannot onboard/i.test(err.message) && process.env.RAILS !== "live") {
        this.mode = "emulated";
        say.warn(`Airwallex has not enabled connected accounts on this sandbox account ("${(err.message.split(" (")[0] ?? "").replace(/^400 \w+: /, "")}"). Running the platform rail on the platform emulator; FX rates stay live. Results are labelled EMULATED.`);
        audit({ kind: "rail_switch", rail: "platform", to: "emulated", cause: err.message });
        return this.emulate<T>(method, path, opts);
      }
      throw err;
    }
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
      const tx = await live();
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
