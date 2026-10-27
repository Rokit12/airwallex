/**
 * Typed Airwallex sandbox client shared by every kit.
 *
 * - Logs in with x-client-id / x-api-key, caches the 30-minute bearer token and
 *   re-logs in before it expires (or once on a 401).
 * - Serialises calls with a small gap so a demo never trips the sandbox rate
 *   limit (10 req/s per endpoint), and backs off on 429.
 * - Retries a POST only when it carries a request_id, so a retry can never
 *   create a second payment.
 * - Writes every call to an audit log with card data redacted.
 */
import "./env.ts";
import { randomUUID } from "node:crypto";
import { audit } from "./audit.ts";

export const SANDBOX_API = "https://api.sandbox.airwallex.com";
export const SANDBOX_FILES = "https://files.sandbox.airwallex.com";

export class AwxError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: unknown,
    readonly path: string,
  ) {
    super(`${status} ${code}: ${message} (${path})`);
  }
}

export interface CallOptions {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Connected-account id for platform kits (x-on-behalf-of). */
  onBehalfOf?: string;
  apiVersion?: string;
}

export const newRequestId = (): string => randomUUID();

/** Major units, rounded to 2dp. 100 means one hundred dollars. */
export const money = (n: number): number => Math.round(n * 100) / 100;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class AirwallexClient {
  private token?: string;
  private tokenExpiresAt = 0;
  private lastCallAt = 0;

  constructor(
    private readonly clientId = process.env.AWX_CLIENT_ID ?? "",
    private readonly apiKey = process.env.AWX_API_KEY ?? "",
    private readonly base = process.env.AWX_BASE ?? SANDBOX_API,
    private readonly filesBase = process.env.AWX_FILES_BASE ?? SANDBOX_FILES,
  ) {
    if (!clientId || !apiKey) {
      throw new Error("Set AWX_CLIENT_ID and AWX_API_KEY (sandbox credentials).");
    }
    if (!this.base.includes("sandbox")) {
      throw new Error(`Refusing to run against a non-sandbox host: ${this.base}`);
    }
  }

  async login(force = false): Promise<string> {
    if (!force && this.token && Date.now() < this.tokenExpiresAt) return this.token;
    const res = await fetch(`${this.base}/api/v1/authentication/login`, {
      method: "POST",
      headers: { "x-client-id": this.clientId, "x-api-key": this.apiKey },
    });
    const text = await res.text();
    if (!res.ok) {
      const parsed = safeJson(text);
      throw new AwxError(res.status, parsed?.code ?? "login_failed", parsed?.message ?? text.slice(0, 200), parsed?.details, "/authentication/login");
    }
    const { token } = JSON.parse(text) as { token: string };
    this.token = token;
    this.tokenExpiresAt = Date.now() + 25 * 60_000; // token lives 30 min; refresh early
    audit({ kind: "login", ok: true });
    return token;
  }

  get<T = any>(path: string, opts: CallOptions = {}) {
    return this.call<T>("GET", path, opts);
  }

  post<T = any>(path: string, body: unknown = {}, opts: Omit<CallOptions, "body"> = {}) {
    return this.call<T>("POST", path, { ...opts, body });
  }

  async call<T = any>(method: "GET" | "POST", path: string, opts: CallOptions = {}): Promise<T> {
    const url = new URL(`${this.base}/api/v1${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const hasRequestId = typeof (opts.body as any)?.request_id === "string";
    const retryable = method === "GET" || hasRequestId;

    // Set when an attempt's outcome is unknown (network error or 5xx). If the retry is then
    // told the request_id was already used, the first attempt went through: read it back.
    let uncertain = false;
    for (let attempt = 1; ; attempt++) {
      await this.throttle();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${await this.login()}`,
        "Content-Type": "application/json",
      };
      if (opts.onBehalfOf) headers["x-on-behalf-of"] = opts.onBehalfOf;
      if (opts.apiVersion) headers["x-api-version"] = opts.apiVersion;

      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers,
          body: method === "POST" ? JSON.stringify(opts.body ?? {}) : undefined,
        });
      } catch (err) {
        // Network failure: outcome unknown. Only safe to retry with a stable request_id.
        if (retryable && attempt < 3) {
          uncertain = true;
          await sleep(500 * attempt);
          continue;
        }
        throw err;
      }

      const text = await res.text();
      const data = safeJson(text);
      audit({ kind: "call", method, path, onBehalfOf: opts.onBehalfOf, status: res.status, req: opts.body, res: data ?? text.slice(0, 300) });

      if (res.ok) return data as T;
      if (res.status === 401 && attempt === 1) {
        await this.login(true);
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && retryable && attempt < 4) {
        if (res.status >= 500) uncertain = true;
        await sleep(400 * 2 ** attempt + Math.random() * 200);
        continue;
      }
      if (uncertain && res.status === 400 && /duplicate_request/.test(data?.code ?? "")) {
        const pi = path.match(/^\/pa\/payment_intents\/([^/]+)\/(confirm|capture|cancel|increment_authorization)$/);
        if (pi) {
          audit({ kind: "recover", path, note: "earlier attempt was processed; reading the payment intent back" });
          return (await this.call<T>("GET", `/pa/payment_intents/${pi[1]}`, { onBehalfOf: opts.onBehalfOf }));
        }
        throw new AwxError(409, "outcome_unknown", `An earlier attempt of ${method} ${path} returned an error but was processed by Airwallex. Check the resource before acting again.`, data, path);
      }
      throw new AwxError(res.status, data?.code ?? "http_error", data?.message ?? text.slice(0, 200), data?.details ?? data, path);
    }
  }

  /** Evidence uploads go to the files host. Airwallex accepts JPG or PDF here (not PNG). */
  async uploadFile(filename: string, bytes: Uint8Array, mime: "application/pdf" | "image/jpeg", notes?: string): Promise<{ file_id: string }> {
    await this.throttle();
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: mime }), filename);
    if (notes) form.append("notes", notes.slice(0, 50));
    const res = await fetch(`${this.filesBase}/api/v1/files/upload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await this.login()}` },
      body: form,
    });
    const text = await res.text();
    const data = safeJson(text);
    audit({ kind: "upload", filename, status: res.status, res: data });
    if (!res.ok) throw new AwxError(res.status, data?.code ?? "upload_failed", data?.message ?? text.slice(0, 200), data, "/files/upload");
    return data;
  }

  private async throttle() {
    const gap = 150; // ~6 req/s, under the 10/s per-endpoint sandbox limit
    const wait = this.lastCallAt + gap - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastCallAt = Date.now();
  }
}

function safeJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
