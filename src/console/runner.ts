/**
 * Runs one kit as a child process in UI mode and turns its output into events.
 * Each kit stays a plain script; the console only reads "@@EV" lines from stdout
 * and writes approval answers to stdin.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface KitInfo {
  id: string;
  name: string;
  track: string;
  script: string;
  summary: string;
}

export const KITS: KitInfo[] = [
  { id: "01", name: "Adaptive Treasury Controller", track: "Treasury & Ops", script: "kits/01-adaptive-treasury/run.ts", summary: "Fund, convert, defer or escalate five obligations when cash is short." },
  { id: "02", name: "Intent-Bound Purchase Agent", track: "Expense & Policy", script: "kits/02-intent-bound-purchase/run.ts", summary: "Choose SaaS terms from a cash forecast and enforce them with card controls." },
  { id: "03", name: "Payment Ops Incident Commander", track: "Treasury & Ops", script: "kits/03-payment-ops-incident/run.ts", summary: "Resolve a missing supplier payment without paying twice." },
  { id: "04", name: "Dispute Response Agent", track: "Revenue Protection", script: "kits/04-dispute-response/run.ts", summary: "Accept, challenge or escalate chargebacks on evidence and cost." },
  { id: "05", name: "Platform Spend Controller", track: "Multi-Tenant Platforms", script: "kits/05-platform-spend/run.ts", summary: "Issue customer cards and ration scarce bridge capital when deposits are late." },
  { id: "06", name: "Multi-Employer Payroll Executor", track: "Multi-Tenant Platforms", script: "kits/06-multi-employer-payroll/run.ts", summary: "Run payroll for three employers without using one employer's funds for another." },
  { id: "07", name: "Portfolio Lending Agent", track: "Dynamic Lending", script: "kits/07-portfolio-lending/run.ts", summary: "Collect revenue-based repayments and size an advance above the reserve floor." },
  { id: "08", name: "Marketplace Settlement Agent", track: "Multi-Tenant Platforms", script: "kits/08-marketplace-settlement/run.ts", summary: "Set seller reserves, pay net proceeds, and re-reserve when risk changes." },
  { id: "09", name: "Approval-Bound Shopping Agent", track: "Agentic Commerce", script: "kits/09-approval-bound-shopping/run.ts", summary: "Shop a merchant site in a browser and pay only for the exact approved terms." },
  { id: "10", name: "Merchant-Enabled Agentic Checkout", track: "Agentic Commerce", script: "kits/10-merchant-agentic-checkout/run.ts", summary: "Sell through Claude with merchant MCP tools and a hosted payment page." },
];

export type KitEvent = Record<string, unknown> & { type: string; t: number; seq?: number };

export interface Run {
  runId: string;
  kit: KitInfo;
  events: KitEvent[];
  child: ChildProcess;
  answer: (id: string, approve: boolean, by?: string) => void;
  done: Promise<number>;
}

export function startKit(kit: KitInfo, onEvent: (e: KitEvent) => void, extraEnv: Record<string, string> = {}): Run {
  const runId = `${kit.id}-${Date.now().toString(36)}`;
  const events: KitEvent[] = [];
  let seq = 0;
  const push = (e: Omit<KitEvent, "t"> & { t?: number }) => {
    const ev = { ...e, t: e.t ?? Date.now(), seq: seq++ } as KitEvent;
    events.push(ev);
    onEvent(ev);
  };

  const tsx = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsx, kit.script], {
    cwd: process.cwd(),
    env: { ...process.env, UI_EVENTS: "1", FORCE_COLOR: "0", ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  push({ type: "run_started", runId, kit: kit.id, name: kit.name });

  let buf = "";
  child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line.startsWith("@@EV ")) {
        try {
          push(JSON.parse(line.slice(5)));
        } catch {
          push({ type: "raw", text: line });
        }
      } else if (line.trim()) push({ type: "raw", text: line });
    }
  });
  let stderr = "";
  child.stderr!.setEncoding("utf8").on("data", (d: string) => (stderr += d));

  const done = new Promise<number>((resolve) => {
    child.on("exit", (code) => {
      const lines = stderr.split("\n").map((l) => l.trim());
      const error = code ? lines.find((l) => /^\w*Error: /.test(l)) ?? lines.filter(Boolean).pop() : undefined;
      push({ type: "run_finished", runId, code: code ?? 0, error });
      resolve(code ?? 0);
    });
  });

  return {
    runId,
    kit,
    events,
    child,
    done,
    answer: (id, approve, by) => child.stdin!.write(JSON.stringify({ id, approve, by }) + "\n"),
  };
}

/** Save a finished run so it can be replayed in the console without a backend. */
export function saveRecording(run: Run) {
  const dir = join(process.cwd(), "runs", "console");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `kit${run.kit.id}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({ kit: run.kit, runId: run.runId, events: run.events }, null, 1));
  return file;
}
