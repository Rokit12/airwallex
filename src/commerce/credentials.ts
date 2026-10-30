/**
 * Payment credentials for the shopping agent (kit 9).
 *
 * The real kit uses the Airi CLI (https://github.com/airwallex/airi-cli, `npm install -g
 * @airwallex/airi-cli@beta`): after the shopper approves the exact terms, the agent creates an
 * Airi mandate for that merchant, amount and item; the shopper confirms it with their passkey at
 * the URL Airi returns; the agent fetches a single-use credential (tokenized PAN, expiry, CVV)
 * into an owner-only file, fills the hosted form from it, deletes the file, and reports the
 * outcome to Airi. Turn it on with:
 *
 *   AIRI_PAYMENT_METHOD_ID   the agent-enabled card to use (`airi-cli payment-methods list`)
 *   AIRI_CLI                 optional path to airi-cli (default: airi-cli on PATH)
 *
 * and sign in once with `airi-cli auth login`. Without AIRI_PAYMENT_METHOD_ID the agent uses the
 * sandbox test card against the local test storefront. Either way, card data goes straight from
 * the provider into the hosted payment form and never into the model's context or the logs.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface Mandate {
  id: string;
  amount: number;
  currency: string;
  merchant: string;
  termsHash: string;
  provider: string;
  /** Where the shopper confirms the payment (Airi passkey), when the provider needs it. */
  approvalUrl?: string;
}
export interface MandateRequest {
  amount: number;
  currency: string;
  merchant: string;
  merchantUrl: string;
  merchantCountry: string;
  item: { name: string; unitPrice: number; quantity: number };
  description: string;
  termsHash: string;
}
export interface CardCredentials {
  number: string;
  expiry_month: string;
  expiry_year: string;
  cvc: string;
  name: string;
}
export interface CredentialsProvider {
  name: string;
  createMandate(m: MandateRequest): Promise<Mandate>;
  credentials(m: Mandate): Promise<CardCredentials>;
  report(m: Mandate, result: { status: string; order?: string }): Promise<void>;
}

const run = promisify(execFile);

/** Airi CLI: the shopper's own Airi wallet, through the commands its README and bundled skill document. */
class AiriCliProvider implements CredentialsProvider {
  name = "Airi CLI";
  private readonly bin = process.env.AIRI_CLI || "airi-cli";
  private async cli(args: string[], timeoutMs = 60_000) {
    const { stdout } = await run(this.bin, [...args, "-o", "json", "--no-telemetry"], { timeout: timeoutMs, maxBuffer: 1 << 20 });
    return stdout.trim() ? JSON.parse(stdout) : {};
  }
  async createMandate(m: MandateRequest): Promise<Mandate> {
    const who = await this.cli(["auth", "whoami"]);
    if (!who.authenticated) throw new Error("Airi CLI is not signed in: run `airi-cli auth login` and approve it in the browser, then run the kit again");
    const out = await this.cli([
      "mandate", "create",
      "--source", "Trailhead Agent Desk",
      "--payment-method-id", process.env.AIRI_PAYMENT_METHOD_ID!,
      "--merchant-name", m.merchant,
      "--merchant-url", m.merchantUrl,
      "--merchant-country", m.merchantCountry,
      "--total-amount", m.amount.toFixed(2),
      "--currency", m.currency,
      "--item", `name:${m.item.name.replace(/[,:]/g, " ")},unit_price:${m.item.unitPrice.toFixed(2)},quantity:${m.item.quantity}`,
      "--description", m.description,
    ]);
    const id = out.mandate_id ?? out.mandateId;
    if (!id) throw new Error(`Airi did not return a mandate id: ${JSON.stringify(out).slice(0, 200)}`);
    return { id, amount: m.amount, currency: m.currency, merchant: m.merchant, termsHash: m.termsHash, provider: this.name, approvalUrl: out.passkey_url ?? out.passkeyUrl };
  }
  async credentials(m: Mandate): Promise<CardCredentials> {
    // The CLI writes the single-use credential to an owner-only file; read it once, then delete it.
    const dir = mkdtempSync(join(tmpdir(), "airi-"));
    const file = join(dir, "cred.json");
    try {
      await this.cli(["mandate", "get-credential", "--mandate-id", m.id, "--file", file, "--timeout", "300"], 330_000);
      return parseCredential(JSON.parse(readFileSync(file, "utf8")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  async report(m: Mandate, r: { status: string; order?: string }) {
    const result = r.status === "PAID" ? "SUCCEEDED" : r.status === "PAYMENT_FAILED" ? "DECLINED" : "CANCELLED";
    await this.cli(["mandate", "result", "--mandate-id", m.id, "--result", result, ...(result === "SUCCEEDED" ? [] : ["--reason", `merchant reported ${r.status}`])]);
  }
}

/** Read the credential file whatever its field names (number/pan/token, expiry as MM/YY or parts, cvv/cvc). */
export function parseCredential(raw: any): CardCredentials {
  const c = raw.credential ?? raw.card ?? raw;
  const number = String(c.number ?? c.pan ?? c.tokenizedPan ?? c.tokenized_pan ?? c.token ?? c.cardNumber ?? "").replace(/\s/g, "");
  let month = c.expiry_month ?? c.expiryMonth ?? c.exp_month;
  let year = c.expiry_year ?? c.expiryYear ?? c.exp_year;
  const exp = c.expiry ?? c.expiration ?? c.tokenExpiration ?? c.exp;
  if ((!month || !year) && typeof exp === "string") {
    const slash = exp.match(/^(\d{1,2})\s*\/\s*(\d{2,4})$/); // "12/30" or "12/2030"
    const iso = exp.match(/^(\d{4})-(\d{2})/); // "2030-12" or "2030-12-31"
    if (slash) [month, year] = [slash[1], slash[2]];
    else if (iso) [month, year] = [iso[2], iso[1]];
  }
  const cvc = String(c.cvv ?? c.cvc ?? c.cvv2 ?? c.securityCode ?? "");
  if (!number || !month || !year || !cvc) throw new Error("Airi credential file is missing a card field (number, expiry or CVV)");
  const y = String(year);
  return { number, expiry_month: String(month).padStart(2, "0"), expiry_year: y.length === 2 ? `20${y}` : y, cvc, name: String(c.name ?? c.cardholderName ?? "Airi Shopper") };
}

class SandboxTestCardProvider implements CredentialsProvider {
  name = "Sandbox test card (Airi test mode pending)";
  readonly reports: { mandate: string; status: string; order?: string }[] = [];
  async createMandate(m: MandateRequest): Promise<Mandate> {
    return { id: `mandate_test_${randomUUID().slice(0, 8)}`, amount: m.amount, currency: m.currency, merchant: m.merchant, termsHash: m.termsHash, provider: this.name };
  }
  async credentials(): Promise<CardCredentials> {
    return { number: "4035501000000008", expiry_month: "12", expiry_year: "2030", cvc: "123", name: "Test Shopper" };
  }
  async report(m: Mandate, r: { status: string; order?: string }) {
    this.reports.push({ mandate: m.id, ...r });
  }
}

export function credentialsProvider(): CredentialsProvider {
  return process.env.AIRI_PAYMENT_METHOD_ID ? new AiriCliProvider() : new SandboxTestCardProvider();
}
