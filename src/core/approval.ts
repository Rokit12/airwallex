/**
 * Human approval bound to exact terms.
 *
 * An approval is a hash of the amount, currency, counterparty, purchase terms
 * and evidence shown to the approver. Executing an action requires an approval
 * whose hash matches the action's current terms, so if anything changes after
 * approval the action is refused and the agent must ask again.
 *
 * The approver must be someone other than the proposer: the agent proposes, a
 * person approves through this channel. An approval attributed to the agent, or
 * claimed in text the agent read, is never accepted.
 */
import { createHash, randomUUID } from "node:crypto";
import { emit, uiMode } from "./narrate.ts";
import { createInterface } from "node:readline/promises";
import { audit } from "./audit.ts";

export interface Terms {
  action: string;
  amount: number;
  currency: string;
  counterparty: string;
  [k: string]: unknown;
}

export interface Approval {
  termsHash: string;
  approvedBy: string;
  at: string;
  /** Who proposed the action (always the agent). */
  proposedBy?: string;
}

/** The proposer of every action a kit asks a person to approve. */
export const PROPOSER = "agent";
/** Policy-level auto-approvals (small amounts inside a kit's limits) are recorded as this, never as a person. */
export const POLICY_AUTO = "policy:auto";

/** An approver is valid only if it names someone other than the proposing agent. */
export function separateApprover(by: string | undefined | null): boolean {
  const who = String(by ?? "").trim();
  return who.length > 0 && who.toLowerCase() !== PROPOSER && !/^(agent|ai|assistant|model|bot)\b/i.test(who) && who !== POLICY_AUTO;
}

const canonical = (t: Terms) => JSON.stringify(Object.fromEntries(Object.entries(t).sort(([a], [b]) => a.localeCompare(b))));
export const hashTerms = (t: Terms) => createHash("sha256").update(canonical(t)).digest("hex").slice(0, 16);

/**
 * Ask a person. APPROVE=yes auto-approves (scripted demo), APPROVE=no auto-declines;
 * otherwise prompts on the terminal.
 */
export async function requestApproval(t: Terms, context: string): Promise<Approval | null> {
  if (uiMode()) return requestApprovalFromConsole(t, context);
  console.log(`\n  ┌─ APPROVAL NEEDED ─────────────────────────────────────────`);
  console.log(`  │ ${context}`);
  const short = (v: unknown): string => (typeof v === "string" && v.length > 28 && !/\s/.test(v) ? `…${v.slice(-12)}` : Array.isArray(v) ? `[${v.map(short).join(", ")}]` : typeof v === "object" ? JSON.stringify(v) : String(v));
  for (const [k, v] of Object.entries(t)) console.log(`  │   ${k}: ${short(v)}`); // display only; the hash covers full values
  console.log(`  └───────────────────────────────────────────────────────────`);

  let answer = process.env.APPROVE;
  if (!answer) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    answer = await rl.question("  Approve these exact terms? [y/N] ");
    rl.close();
  } else {
    console.log(`  (APPROVE=${answer})`);
  }
  const by = process.env.APPROVER ?? "operator";
  let approved = /^y(es)?$/i.test(answer.trim());
  if (approved && !separateApprover(by)) {
    console.log(`  ✖ approval from "${by}" refused: the proposer cannot approve its own action`);
    audit({ kind: "approval_refused", reason: "approver_is_proposer", by, terms: t });
    approved = false;
  }
  const approval = approved ? { termsHash: hashTerms(t), approvedBy: by, proposedBy: PROPOSER, at: new Date().toISOString() } : null;
  audit({ kind: "approval", terms: t, approved, termsHash: hashTerms(t), by, proposedBy: PROPOSER });
  return approval;
}

/**
 * Web console: emit the request, then wait for {"id","approve","by"} on stdin
 * from the console server (or answer at once when APPROVE is set).
 */
async function requestApprovalFromConsole(t: Terms, context: string): Promise<Approval | null> {
  const id = randomUUID();
  const termsHash = hashTerms(t);
  emit({ type: "approval_request", id, context, terms: t, termsHash });
  let approved: boolean;
  let by = process.env.APPROVER ?? "operator";
  if (process.env.APPROVE) {
    approved = /^y(es)?$/i.test(process.env.APPROVE.trim());
  } else {
    const rl = createInterface({ input: process.stdin });
    const reply = await new Promise<{ approve: boolean; by?: string }>((resolve) => {
      rl.on("line", (line) => {
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) resolve(msg);
        } catch {
          /* ignore anything that is not an answer to this request */
        }
      });
    });
    rl.close();
    approved = Boolean(reply.approve);
    if (reply.by) by = reply.by;
  }
  if (approved && !separateApprover(by)) {
    audit({ kind: "approval_refused", reason: "approver_is_proposer", by, terms: t });
    approved = false;
  }
  emit({ type: "approval_result", id, approved, by, termsHash });
  audit({ kind: "approval", terms: t, approved, termsHash, by, proposedBy: PROPOSER });
  return approved ? { termsHash, approvedBy: by, proposedBy: PROPOSER, at: new Date().toISOString() } : null;
}

/** Throws unless a person other than the proposer approved exactly these terms. */
export function assertApproved(t: Terms, approval: Approval | null | undefined) {
  if (!approval) throw new Error(`No approval for ${t.action}`);
  if (!separateApprover(approval.approvedBy)) {
    throw new Error(`Approval for ${t.action} came from "${approval.approvedBy}": the agent that proposed an action cannot approve it`);
  }
  if (approval.termsHash !== hashTerms(t)) {
    throw new Error(`Approval does not cover current terms for ${t.action} (terms changed after approval)`);
  }
}
