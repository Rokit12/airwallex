/**
 * Kit 5 policy: the platform covers customers' card payments when their own
 * deposits arrive late, from far less bridge capital than they collectively need.
 * Decide who gets bridged, for how much, and who needs a person.
 */

export interface BridgeRequest {
  customer: string;
  /** Payment due today on the customer's card. */
  dueToday: number;
  /** Customer's own wallet balance now. */
  balance: number;
  /** The late deposit the bridge would be repaid from. */
  expectedDeposit: number;
  /** Evidence for that deposit: bank pre-notification, invoice match, customer's word only. */
  evidence: "BANK_PRENOTE" | "INVOICE_MATCH" | "CUSTOMER_SAYS";
  /** Share of the last 12 deposits that arrived on time. */
  onTimeRate: number;
  /** A previous bridge was repaid late. */
  priorLateRepayment: boolean;
}

export interface BridgePolicy {
  /** Platform capital earmarked for bridging (not the whole wallet). */
  capital: number;
  /** Capital the platform always keeps. */
  reserveFloor: number;
  /** Never bridge more than this share of the expected deposit. */
  maxShareOfDeposit: number;
  /** The agent bridges alone only at or above this repayment probability and at or below autoLimit. */
  autoMinProbability: number;
  autoLimit: number;
}

export const DEFAULT_BRIDGE_POLICY: BridgePolicy = { capital: 6000, reserveFloor: 2000, maxShareOfDeposit: 0.5, autoMinProbability: 0.85, autoLimit: 2000 };

export type BridgeAction = "NOT_NEEDED" | "BRIDGE" | "BRIDGE_WITH_APPROVAL" | "DECLINE";

export interface BridgeDecision {
  customer: string;
  shortfall: number;
  repayProbability: number;
  action: BridgeAction;
  amount: number;
  reason: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Probability the bridge is repaid on time, from deposit evidence and history. */
export function repayProbability(r: BridgeRequest): number {
  const evidence = { BANK_PRENOTE: 0.95, INVOICE_MATCH: 0.8, CUSTOMER_SAYS: 0.55 }[r.evidence];
  const history = 0.5 + 0.5 * r.onTimeRate;
  const p = evidence * history * (r.priorLateRepayment ? 0.8 : 1);
  return Math.round(Math.min(0.99, p) * 1000) / 1000;
}

/**
 * Ration bridge capital. A card payment needs the whole shortfall or it still
 * declines, so a partial bridge is never offered. Highest repayment probability
 * goes first; ties go to the smaller shortfall.
 */
export function rationBridges(reqs: BridgeRequest[], p: BridgePolicy = DEFAULT_BRIDGE_POLICY): { decisions: BridgeDecision[]; available: number; remaining: number } {
  const available = r2(p.capital - p.reserveFloor);
  let remaining = available;
  const scored = reqs.map((r) => ({ r, shortfall: r2(Math.max(0, r.dueToday - r.balance)), prob: repayProbability(r) }));
  const order = [...scored].sort((a, b) => b.prob - a.prob || a.shortfall - b.shortfall);
  const decisions: BridgeDecision[] = [];

  for (const { r, shortfall, prob } of order) {
    if (shortfall === 0) {
      decisions.push({ customer: r.customer, shortfall, repayProbability: prob, action: "NOT_NEEDED", amount: 0, reason: "Customer's own balance covers today's payment." });
      continue;
    }
    if (shortfall > r.expectedDeposit * p.maxShareOfDeposit) {
      decisions.push({ customer: r.customer, shortfall, repayProbability: prob, action: "DECLINE", amount: 0, reason: `Shortfall ${shortfall} is over ${p.maxShareOfDeposit * 100}% of the expected deposit ${r.expectedDeposit}.` });
      continue;
    }
    if (shortfall > remaining) {
      decisions.push({ customer: r.customer, shortfall, repayProbability: prob, action: "DECLINE", amount: 0, reason: `Needs ${shortfall} but only ${remaining} bridge capital is left above the ${p.reserveFloor} floor; a partial bridge would not stop the decline.` });
      continue;
    }
    remaining = r2(remaining - shortfall);
    const auto = prob >= p.autoMinProbability && shortfall <= p.autoLimit;
    decisions.push({
      customer: r.customer,
      shortfall,
      repayProbability: prob,
      action: auto ? "BRIDGE" : "BRIDGE_WITH_APPROVAL",
      amount: shortfall,
      reason: `Repayment probability ${prob} from ${r.evidence.toLowerCase().replace("_", " ")} evidence and ${Math.round(r.onTimeRate * 100)}% on-time history${auto ? "." : "; a person approves because it is below the autonomous threshold."}`,
    });
  }
  return { decisions: reqs.map((r) => decisions.find((d) => d.customer === r.customer)!), available, remaining };
}
