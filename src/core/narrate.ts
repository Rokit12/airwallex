/**
 * Narration for demo runs: goal → plan → new information → revised decision → result.
 *
 * In a terminal it prints coloured text. Under the web console (UI_EVENTS=1)
 * it writes one structured event per line instead ("@@EV {json}"), which the
 * console server streams to the browser.
 */
import { audit } from "./audit.ts";
import { BUSINESS } from "./business.ts";

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  orange: (s: string) => `\x1b[38;5;208m${s}\x1b[0m`,
};

export const uiMode = () => process.env.UI_EVENTS === "1";

/** Emit a structured event for the web console. Returns true when in UI mode. */
export function emit(event: Record<string, unknown>): boolean {
  if (!uiMode()) return false;
  process.stdout.write("@@EV " + JSON.stringify({ ...event, t: Date.now() }) + "\n");
  return true;
}

function pause() {
  const pace = Number(process.env.DEMO_PACE ?? 0);
  if (pace > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pace); // slow the story down for recordings
}

export const say = {
  title(s: string) {
    if (emit({ type: "title", text: s, business: BUSINESS.name, country: BUSINESS.countryName, currency: BUSINESS.baseCurrency })) return;
    console.log("\n" + c.orange("━".repeat(72)) + "\n" + c.bold(s) + "\n" + c.dim(`${BUSINESS.name} · ${BUSINESS.countryName} · ${BUSINESS.baseCurrency}`) + "\n" + c.orange("━".repeat(72)));
  },
  beat(label: string, s: string) {
    pause();
    audit({ kind: "beat", label, text: s });
    if (emit({ type: "beat", label, text: s })) return;
    console.log(`\n${c.cyan(`▸ ${label.toUpperCase()}`)}  ${s}`);
  },
  step(s: string) {
    if (emit({ type: "step", text: s })) return;
    console.log(`  ${c.dim("·")} ${s}`);
  },
  ok(s: string) {
    if (emit({ type: "ok", text: s })) return;
    console.log(`  ${c.green("✔")} ${s}`);
  },
  warn(s: string) {
    if (emit({ type: "warn", text: s })) return;
    console.log(`  ${c.yellow("!")} ${s}`);
  },
  fail(s: string) {
    process.exitCode = 1; // a failed end-of-run check fails the run, so scripts and CI see it
    if (emit({ type: "fail", text: s })) return;
    console.log(`  ${c.red("✖")} ${s}`);
  },
  decision(subject: string, action: string, why: string) {
    audit({ kind: "decision", subject, action, why });
    if (emit({ type: "decision", subject, action, why })) return;
    console.log(`  ${c.bold("DECIDE")} ${subject}: ${c.orange(action)}\n         ${c.dim(why)}`);
  },
  table(rows: Record<string, unknown>[]) {
    if (emit({ type: "table", rows })) return;
    console.table(rows);
  },
  /** An incoming document the agent reads: an email, a quote, a notice. */
  document(text: string) {
    if (emit({ type: "document", text })) return;
    console.log(text.split("\n").map((l) => `    │ ${l}`).join("\n"));
  },
};

export const usd = (n: number, ccy = "USD") =>
  `${ccy} ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
