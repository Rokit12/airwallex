/**
 * Client for the platform kits (5–8). Tries the live sandbox first. If Airwallex
 * refuses to open a connected account ("This account cannot onboard ..."), the
 * platform rail switches to the PlatformEmulator for the rest of the run:
 * every call goes there except FX rates and quotes, which stay live so
 * conversions use real Airwallex prices. RAILS=live disables the fallback.
 */
import { AirwallexClient, AwxError, newRequestId, type CallOptions } from "./client.ts";
import { PlatformEmulator } from "./platform-emulator.ts";
import { audit } from "./audit.ts";
import { say } from "./narrate.ts";

const LIVE_ALWAYS = /^\/(fx\/rates\/current|fx\/quotes\/create|reference\/)/;

export class PlatformClient extends AirwallexClient {
  mode: "live" | "emulated" = process.env.RAILS === "emulated" ? "emulated" : "live";
  readonly emu: PlatformEmulator;

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
