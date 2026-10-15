/**
 * Airwallex client that tries the live sandbox first and moves a card rail to
 * the emulator only when Airwallex refuses that feature for this account:
 *
 *   payments: POST /pa/payment_intents/create → configuration_error
 *   issuing:  POST /issuing/cards/create      → "Invalid issuance details" / "not allowed to set ... card type"
 *
 * Everything else (balances, deposits, FX, transfers, file uploads, cardholders)
 * always stays live. RAILS=live disables the fallback; RAILS=emulated forces it.
 */
import { AirwallexClient, AwxError, type CallOptions } from "./client.ts";
import { CardEmulator } from "./emulator.ts";
import { audit } from "./audit.ts";
import { say } from "./narrate.ts";

type Rail = "issuing" | "payments";
type Mode = "live" | "emulated";

const REFUSED: Record<Rail, { path: RegExp; match: (e: AwxError) => boolean; label: string }> = {
  payments: {
    path: /^\/pa\/payment_intents\/create$/,
    match: (e) => e.code === "configuration_error",
    label: "card acceptance",
  },
  issuing: {
    path: /^\/issuing\/cards\/create$/,
    match: (e) => /issuance details|not allowed to set/i.test(e.message),
    label: "card issuing",
  },
};

export class RailsClient extends AirwallexClient {
  private readonly emu = new CardEmulator();
  readonly mode: Record<Rail, Mode>;

  constructor() {
    super();
    const forced = process.env.RAILS;
    const m: Mode = forced === "emulated" ? "emulated" : "live";
    this.mode = { issuing: m, payments: m };
  }

  private railFor(path: string): Rail | null {
    if (CardEmulator.owns("issuing", path)) return "issuing";
    if (CardEmulator.owns("payments", path)) return "payments";
    return null;
  }

  override async call<T = any>(method: "GET" | "POST", path: string, opts: CallOptions = {}): Promise<T> {
    const rail = this.railFor(path);
    if (rail && this.mode[rail] === "emulated") return this.emulate<T>(method, path, opts);
    try {
      return await super.call<T>(method, path, opts);
    } catch (err) {
      const rule = rail ? REFUSED[rail] : undefined;
      if (rail && rule && err instanceof AwxError && rule.path.test(path) && rule.match(err) && process.env.RAILS !== "live") {
        this.mode[rail] = "emulated";
        say.warn(`Airwallex has not enabled ${rule.label} on this sandbox account (${err.code}). Switching ${rule.label} to the card emulator; results are labelled EMULATED.`);
        audit({ kind: "rail_switch", rail, to: "emulated", cause: err.message });
        return this.emulate<T>(method, path, opts);
      }
      throw err;
    }
  }

  private emulate<T>(method: "GET" | "POST", path: string, opts: CallOptions): T {
    try {
      const res = this.emu.handle(method, path, (opts.body ?? {}) as any, (opts.query ?? {}) as any);
      audit({ kind: "call", emulated: true, method, path, status: 200, req: opts.body, res });
      return res as T;
    } catch (err) {
      audit({ kind: "call", emulated: true, method, path, status: (err as AwxError).status, req: opts.body, error: (err as Error).message });
      throw err;
    }
  }
}
