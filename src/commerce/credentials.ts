/**
 * Payment credentials for the shopping agent (kit 9).
 *
 * The real kit uses Airi CLI: after the shopper authorizes payment, the agent
 * asks Airi CLI for a payment mandate and one-time card credentials, then
 * reports the result back. Airi CLI is allowlisted; its commands come with the
 * beta access. Configure them here once access is granted:
 *
 *   AIRI_MANDATE_CMD      e.g. the CLI command that creates a mandate; {amount} {currency} {merchant} {terms_hash} are filled in
 *   AIRI_CREDENTIALS_CMD  prints one-time card JSON for {mandate_id}
 *   AIRI_REPORT_CMD       reports {mandate_id} {result} {order}
 *
 * Without them, the agent uses the sandbox test card against the local test
 * storefront. Either way, card data goes straight from the provider into the
 * hosted payment form and never into the model's context or the logs.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface Mandate {
  id: string;
  amount: number;
  currency: string;
  merchant: string;
  termsHash: string;
  provider: string;
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
  createMandate(m: Omit<Mandate, "id" | "provider">): Mandate;
  credentials(m: Mandate): CardCredentials;
  report(m: Mandate, result: { status: string; order?: string }): void;
}

const fill = (tpl: string, vars: Record<string, string | number>) => tpl.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
const run = (cmd: string) => {
  const [bin, ...args] = cmd.split(/\s+/);
  return execFileSync(bin!, args, { encoding: "utf8" }).trim();
};

class AiriCliProvider implements CredentialsProvider {
  name = "Airi CLI";
  createMandate(m: Omit<Mandate, "id" | "provider">): Mandate {
    const out = run(fill(process.env.AIRI_MANDATE_CMD!, { ...m, terms_hash: m.termsHash }));
    const id = (() => { try { return JSON.parse(out).id; } catch { return out; } })();
    return { ...m, id, provider: this.name };
  }
  credentials(m: Mandate): CardCredentials {
    return JSON.parse(run(fill(process.env.AIRI_CREDENTIALS_CMD!, { mandate_id: m.id })));
  }
  report(m: Mandate, r: { status: string; order?: string }) {
    run(fill(process.env.AIRI_REPORT_CMD!, { mandate_id: m.id, result: r.status, order: r.order ?? "" }));
  }
}

class SandboxTestCardProvider implements CredentialsProvider {
  name = "Sandbox test card (Airi CLI access pending)";
  readonly reports: { mandate: string; status: string; order?: string }[] = [];
  createMandate(m: Omit<Mandate, "id" | "provider">): Mandate {
    return { ...m, id: `mandate_test_${randomUUID().slice(0, 8)}`, provider: this.name };
  }
  credentials(): CardCredentials {
    return { number: "4035501000000008", expiry_month: "12", expiry_year: "2030", cvc: "123", name: "Test Shopper" };
  }
  report(m: Mandate, r: { status: string; order?: string }) {
    this.reports.push({ mandate: m.id, ...r });
  }
}

export function credentialsProvider(): CredentialsProvider {
  return process.env.AIRI_MANDATE_CMD && process.env.AIRI_CREDENTIALS_CMD && process.env.AIRI_REPORT_CMD ? new AiriCliProvider() : new SandboxTestCardProvider();
}
