/**
 * Append-only audit trail for a run: every API call, decision and approval.
 * Card numbers, CVCs and tokens are redacted before anything is written.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const runId = process.env.RUN_ID ?? new Date().toISOString().replace(/[:.]/g, "-");
const dir = join(process.cwd(), "runs");
mkdirSync(dir, { recursive: true });
// Name the log after the kit folder of the script being run (imports are hoisted, so env set in run.ts is too late).
const kitFromScript = /kits\/(\d+)-/.exec(process.argv[1] ?? "")?.[1];
export const auditPath = join(dir, `${process.env.KIT ?? (kitFromScript ? `kit${kitFromScript}` : "run")}-${runId}.jsonl`);

const SENSITIVE = new Set(["number", "cvc", "cvv", "card_number", "token", "client_secret", "x-api-key"]);

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SENSITIVE.has(k) && typeof v === "string" ? `***${v.slice(-4)}` : redact(v)]),
    );
  }
  return value;
}

export function audit(entry: Record<string, unknown>) {
  appendFileSync(auditPath, JSON.stringify({ at: new Date().toISOString(), ...(redact(entry) as object) }) + "\n");
}
