/**
 * Kit 3 policy: a supplier says a payment never arrived. Decide whether to wait,
 * trace, replace, or escalate — without ever paying the same invoice twice.
 *
 * Airwallex state rules this encodes:
 *  - SCHEDULED / PROCESSING / SENT are in flight: the money can still arrive.
 *  - PAID is final success.
 *  - A failed transfer ends CANCELLED (not FAILED) and CANCELLED does not mean a
 *    person cancelled it; the failure type says why.
 */

export type TransferStatus = "SCHEDULED" | "PROCESSING" | "SENT" | "PAID" | "FAILED" | "CANCELLED" | "OVERDUE" | string;

export const IN_FLIGHT = new Set(["SCHEDULED", "PROCESSING", "SENT", "OVERDUE"]);
export const isFinal = (s: TransferStatus) => s === "PAID" || s === "FAILED" || s === "CANCELLED";

/** Failure types that mean the destination details are wrong: resending to the same account fails again. */
const BAD_DETAILS = new Set([
  "BENEFICIARY_BANK_RETURNED",
  "INCORRECT_ROUTING", "INVALID_ACCOUNT_NAME_OR_NUMBER", "INVALID_BANK_OR_BRANCH_CODE", "INVALID_SWIFT_BIC_CODE",
  "INVALID_BANK_INFORMATION", "BENEFICIARY_NAME_MISMATCH", "ACCOUNT_CLOSED", "ACCOUNT_CURRENCY_MISMATCH",
  "ACCOUNT_INACTIVE_OR_DORMANT", "INVALID_CORRESPONDENT_BANK_INFORMATION",
]);
/** Failures where the details are fine and a resend can work. */
const TRANSIENT = new Set(["CHANNEL_TIMEOUT", "INSUFFICIENT_FUNDS", "EXCEEDED_TRANSACTION_AMOUNT_OR_LIMIT", "CHANNEL_POLICY"]);

export interface IncidentFacts {
  invoice: string;
  amount: number;
  currency: string;
  original: { status: TransferStatus; failureType?: string; hoursSinceCreated: number };
  /** Other transfers already on this invoice (from Airwallex, matched by reference). */
  otherAttempts: { status: TransferStatus }[];
  /** Typical settlement time for this corridor and method. */
  expectedSettlementHours: number;
  supplierDeadlinePassed: boolean;
  /** The supplier asked to pay a different account than the one on file. */
  newBankDetailsRequested: boolean;
  /** A person has verified the new details out of band (call-back to a known number). */
  newDetailsVerified: boolean;
}

export type IncidentAction =
  | "CLOSE_PAID" // original arrived: send proof to the supplier
  | "WAIT" // in flight and within normal settlement time
  | "TRACE" // in flight but late: a person asks the bank for a trace; never resend
  | "REPLACE_SAME_DETAILS" // final failure, transient cause
  | "VERIFY_NEW_DETAILS" // final failure due to bad details; new details need a call-back
  | "REPLACE_NEW_DETAILS" // final failure, new details verified
  | "ASK_SUPPLIER" // final failure due to bad details and no new details given
  | "BLOCK_DUPLICATE"; // another attempt could still pay this invoice

export interface IncidentDecision {
  action: IncidentAction;
  needsApproval: boolean;
  warnings: string[];
  rationale: string;
}

export interface IncidentPolicy {
  /** Replacements at or below this amount may go out without a person. */
  autoReplaceLimit: number;
  /** In-flight transfers become "late" after this multiple of expected settlement time. */
  lateFactor: number;
}

export const DEFAULT_INCIDENT_POLICY: IncidentPolicy = { autoReplaceLimit: 1000, lateFactor: 1.5 };

export function decideIncident(f: IncidentFacts, p: IncidentPolicy = DEFAULT_INCIDENT_POLICY): IncidentDecision {
  const warnings: string[] = [];
  if (f.newBankDetailsRequested && !f.newDetailsVerified) {
    warnings.push("Supplier asked to change bank details by email: treat as possible invoice fraud until verified by call-back.");
  }

  // 1. Duplicate lock: anything else that could still pay this invoice blocks a new payment.
  const other = f.otherAttempts.find((a) => IN_FLIGHT.has(a.status) || a.status === "PAID");
  if (other) {
    return { action: "BLOCK_DUPLICATE", needsApproval: false, warnings, rationale: `Another transfer for ${f.invoice} is ${other.status}; a new payment could pay twice.` };
  }

  const s = f.original.status;
  if (s === "PAID") {
    return { action: "CLOSE_PAID", needsApproval: false, warnings, rationale: `Original transfer is PAID. Send the supplier the payment confirmation instead of paying again.` };
  }

  if (IN_FLIGHT.has(s)) {
    const late = f.original.hoursSinceCreated > f.expectedSettlementHours * p.lateFactor;
    return late
      ? {
          action: "TRACE",
          needsApproval: true,
          warnings,
          rationale: `Transfer is ${s} after ${Math.round(f.original.hoursSinceCreated)}h (expected ${f.expectedSettlementHours}h). It can still arrive, so a replacement now risks paying twice. A person should request a bank trace${f.supplierDeadlinePassed ? " and tell the supplier it is in flight" : ""}.`,
        }
      : { action: "WAIT", needsApproval: false, warnings, rationale: `Transfer is ${s} and within normal settlement time.` };
  }

  // Final failure: the money did not go and will not go.
  const ft = f.original.failureType ?? "UNKNOWN";
  const needsApproval = f.amount > p.autoReplaceLimit;
  if (TRANSIENT.has(ft)) {
    return { action: "REPLACE_SAME_DETAILS", needsApproval, warnings, rationale: `Original failed with ${ft}, a cause unrelated to the destination account; resend to the same account under a new request id.` };
  }
  if (BAD_DETAILS.has(ft) || ft === "UNKNOWN") {
    if (!f.newBankDetailsRequested) {
      return { action: "ASK_SUPPLIER", needsApproval: false, warnings, rationale: `Original failed with ${ft}: the account on file is wrong. Ask the supplier for corrected details before paying.` };
    }
    if (!f.newDetailsVerified) {
      return { action: "VERIFY_NEW_DETAILS", needsApproval: true, warnings, rationale: `Original failed with ${ft} and the supplier sent new details by email. Pay only after a person verifies them on a known phone number.` };
    }
    return { action: "REPLACE_NEW_DETAILS", needsApproval: true, warnings, rationale: `Original failed with ${ft}; new details verified out of band. Replace with a new request id under the invoice lock.` };
  }
  // Unrecognised failure type: never resend automatically. If new details were offered, a person verifies them first.
  if (f.newBankDetailsRequested) {
    return { action: f.newDetailsVerified ? "REPLACE_NEW_DETAILS" : "VERIFY_NEW_DETAILS", needsApproval: true, warnings, rationale: `Original failed with unrecognised type ${ft}. Pay the new account only after a person verifies it by call-back and approves.` };
  }
  return { action: "ASK_SUPPLIER", needsApproval: false, warnings, rationale: `Original failed with unrecognised type ${ft}; a person should review before any resend.` };
}
