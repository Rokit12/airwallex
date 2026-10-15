/**
 * Dispute decision policy. Pure code: the same facts always give the same decision.
 * The model only extracts facts from case notes and explains the outcome.
 */

export type ReasonCategory = "FRAUD" | "NOT_RECEIVED" | "CREDIT_NOT_PROCESSED";
export type Stage = "RFI" | "PRE_CHARGEBACK" | "CHARGEBACK" | "PRE_ARBITRATION";

/** Visa reason codes the sandbox accepts for these flows. */
export const VISA_REASON: Record<string, ReasonCategory> = {
  "10.4": "FRAUD",
  "13.1": "NOT_RECEIVED",
  "13.6": "CREDIT_NOT_PROCESSED",
};

export interface Evidence {
  /** Prior undisputed orders from the same device fingerprint. */
  priorOrdersSameDevice: number;
  ipMatchesPriorOrders: boolean;
  deliveryScanned: boolean;
  deliverySigned: boolean;
  /** Customer contacts to support that never got a reply. */
  unansweredSupportContacts: number;
  refundAlreadyIssued: boolean;
}

export interface DisputeFacts {
  disputeId: string;
  amount: number;
  currency: string;
  stage: Stage;
  category: ReasonCategory;
  hoursToDeadline: number;
  evidence: Evidence;
  /** Times the issuer has rejected our evidence on this dispute. */
  issuerRejections: number;
}

export interface PolicyConfig {
  /** Chargeback fee the merchant pays once a dispute reaches chargeback, even if it wins. The sandbox does not deduct it. */
  chargebackFee: number;
  /** Internal cost of preparing one evidence response. */
  responseCost: number;
  /** Challenge only if it is expected to save at least this much versus accepting. */
  minSaving: number;
  /** Below this many hours, an incomplete case goes to a person instead of the agent. */
  minHoursToRespond: number;
  /** Largest amount the agent may accept on its own. */
  autoAcceptLimit: number;
  /** Largest amount the agent may challenge without a person approving the exact submission. */
  autoChallengeLimit: number;
}

export const DEFAULT_POLICY: PolicyConfig = {
  chargebackFee: 25,
  responseCost: 15,
  minSaving: 5,
  minHoursToRespond: 12,
  autoAcceptLimit: 100,
  autoChallengeLimit: 500,
};

export type AcceptReason = "LOW_VALUE_TRANSACTION" | "VALID_CUSTOMER_DISPUTE";
export type ChallengeReason = "PURCHASE_HISTORY" | "PRODUCT_RECEIVED" | "CUSTOMER_REFUNDED" | "OTHER_REASONS";

export type Decision =
  | { action: "ACCEPT"; reason: AcceptReason; needsApproval: boolean; winProbability: number; costAccept: number; costChallenge: number; rationale: string }
  | { action: "CHALLENGE"; reason: ChallengeReason; needsApproval: boolean; winProbability: number; costAccept: number; costChallenge: number; rationale: string }
  | { action: "ESCALATE"; needsApproval: true; winProbability: number; costAccept: number; costChallenge: number; rationale: string };

const atChargeback = (s: Stage) => s === "CHARGEBACK" || s === "PRE_ARBITRATION";

/** Probability the merchant wins, from evidence strength. Each issuer rejection discounts it. */
export function winProbability(f: DisputeFacts): number {
  const e = f.evidence;
  let p: number;
  switch (f.category) {
    case "FRAUD":
      p = 0.15 + (e.priorOrdersSameDevice >= 3 ? 0.25 : e.priorOrdersSameDevice * 0.05) + (e.ipMatchesPriorOrders ? 0.15 : 0) + (e.deliverySigned ? 0.3 : 0);
      break;
    case "NOT_RECEIVED":
      p = 0.1 + (e.deliverySigned ? 0.6 : e.deliveryScanned ? 0.25 : 0);
      break;
    case "CREDIT_NOT_PROCESSED":
      p = e.refundAlreadyIssued ? 0.85 : 0.1;
      break;
  }
  p *= 0.7 ** f.issuerRejections;
  return Math.round(Math.min(0.9, Math.max(0, p)) * 1000) / 1000;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function decide(f: DisputeFacts, cfg: PolicyConfig = DEFAULT_POLICY): Decision {
  const p = winProbability(f);
  const feeNow = atChargeback(f.stage);
  // Accepting at RFI refunds the payment and avoids the chargeback fee.
  const costAccept = r2(f.amount + (feeNow ? cfg.chargebackFee : 0));
  // A lost challenge at RFI escalates to chargeback, so the fee becomes likely.
  const costChallenge = r2((1 - p) * f.amount + cfg.responseCost + (feeNow ? cfg.chargebackFee : (1 - p) * cfg.chargebackFee));
  const base = { winProbability: p, costAccept, costChallenge };

  // 1. The merchant is at fault: a person decides how to make it right.
  if (f.category === "CREDIT_NOT_PROCESSED" && f.evidence.unansweredSupportContacts > 0 && !f.evidence.refundAlreadyIssued) {
    return {
      action: "ESCALATE",
      needsApproval: true,
      ...base,
      rationale: `Customer contacted support ${f.evidence.unansweredSupportContacts}x with no reply and no refund was issued; the failure is ours, so a person should decide the remedy.`,
    };
  }

  // 2. Too close to the deadline with weak evidence: don't let the agent improvise.
  if (f.hoursToDeadline < cfg.minHoursToRespond && p < 0.5) {
    return { action: "ESCALATE", needsApproval: true, ...base, rationale: `${f.hoursToDeadline.toFixed(0)}h to deadline with weak evidence (p=${p}).` };
  }

  // 3. Economics.
  if (costAccept - costChallenge >= cfg.minSaving) {
    const reason: ChallengeReason =
      f.category === "FRAUD" && f.evidence.priorOrdersSameDevice >= 3 ? "PURCHASE_HISTORY"
      : f.evidence.deliverySigned || f.evidence.deliveryScanned ? "PRODUCT_RECEIVED"
      : f.evidence.refundAlreadyIssued ? "CUSTOMER_REFUNDED"
      : "OTHER_REASONS";
    return {
      action: "CHALLENGE",
      reason,
      needsApproval: f.amount > cfg.autoChallengeLimit,
      ...base,
      rationale: `Expected cost to challenge ${costChallenge} vs accept ${costAccept} (win p=${p}).`,
    };
  }

  const reason: AcceptReason = f.amount < cfg.chargebackFee + cfg.responseCost ? "LOW_VALUE_TRANSACTION" : "VALID_CUSTOMER_DISPUTE";
  return {
    action: "ACCEPT",
    reason,
    needsApproval: f.amount > cfg.autoAcceptLimit,
    ...base,
    rationale: `Defending costs more than it saves: challenge ${costChallenge} vs accept ${costAccept} (win p=${p}).`,
  };
}
