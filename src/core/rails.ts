/**
 * Airwallex client that tries the live sandbox first and moves a card rail to
 * the emulator only when Airwallex refuses that feature for this account:
 *
 *   payments: POST /pa/payment_intents/create → configuration_error
 *             POST /pa/payment_intents/:id/confirm → "not enabled for native API access"
 *             (raw card details need PCI-level access; the live intent is handed to the emulator)
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

type Rule = { rail: Rail; path: RegExp; match: (e: AwxError) => boolean; label: string };
const REFUSED: Rule[] = [
  { rail: "payments", path: /^\/pa\/payment_intents\/create$/, match: (e) => e.code === "configuration_error", label: "card acceptance" },
  { rail: "payments", path: /^\/pa\/payment_intents\/[\w-]+\/confirm$/, match: (e) => /native API access/i.test(e.message), label: "card confirmation by API" },
  { rail: "issuing", path: /^\/issuing\/cards\/create$/, match: (e) => /issuance details|not allowed to set/i.test(e.message), label: "card issuing" },
];

export class RailsClient extends AirwallexClient {
  private readonly emu = new CardEmulator();
  readonly mode: Record<Rail, Mode>;
  /** Card authorizations only: live cards, emulated authorizations (see call()). */
  authorizations: Mode = process.env.RAILS === "emulated" ? "emulated" : "live";

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
    // Cards issued live, but Airwallex's authorization simulator refused: authorizations
    // (and the transactions they create) run on the emulator against the live card's current controls.
    const authPath = /^\/(simulation\/issuing\/|issuing\/transactions)/.test(path);
    if (authPath && this.authorizations === "emulated") return this.emulateAuthorization<T>(method, path, opts);
    try {
      return await super.call<T>(method, path, opts);
    } catch (err) {
      const rule = err instanceof AwxError ? REFUSED.find((r) => r.rail === rail && r.path.test(path) && r.match(err as AwxError)) : undefined;
      if (path === "/simulation/issuing/create" && err instanceof AwxError && err.code === "bad_request" && /failed to process transaction/i.test(err.message) && process.env.RAILS !== "live") {
        this.authorizations = "emulated";
        say.warn(`Airwallex's card authorization simulator refused this account ("failed to process transaction"). Cards stay live; authorizations are checked by the card emulator against each live card's controls and labelled EMULATED.`);
        audit({ kind: "rail_switch", rail: "card_authorizations", to: "emulated", cause: err.message });
        return this.emulateAuthorization<T>(method, path, opts);
      }
      if (rail && rule && process.env.RAILS !== "live") {
        const confirm = path.match(/^\/pa\/payment_intents\/([\w-]+)\/confirm$/);
        if (confirm) this.emu.adoptIntent(await super.call("GET", `/pa/payment_intents/${confirm[1]}`));
        this.mode[rail] = "emulated";
        say.warn(`Airwallex has not enabled ${rule.label} on this sandbox account (${(err as AwxError).code}). Switching ${rule.label} to the card emulator; results are labelled EMULATED.`);
        audit({ kind: "rail_switch", rail, to: "emulated", cause: (err as AwxError).message });
        return this.emulate<T>(method, path, opts);
      }
      throw err;
    }
  }

  private async emulateAuthorization<T>(method: "GET" | "POST", path: string, opts: CallOptions): Promise<T> {
    const body = (opts.body ?? {}) as any;
    if (method === "POST" && path === "/simulation/issuing/create") this.emu.adoptCard(await super.call<any>("GET", `/issuing/cards/${body.card_id}`));
    return this.emulate<T>(method, path, opts);
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
