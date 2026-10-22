/**
 * Kit 7 policy: revenue-based advances. Collect each borrower's weekly
 * repayment as a share of that week's revenue (only what their wallet can pay),
 * then size the next disbursement so the portfolio never breaches its reserve floor.
 */

export interface Borrower {
  key: string;
  outstanding: number;
  /** Share of weekly revenue repaid. */
  repayRate: number;
}

export interface Collection {
  borrower: string;
  due: number;
  collect: number;
  receivable: number;
  reason: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Never charge more than the wallet holds: a charge that fails is worse than a recorded receivable. */
export function collection(b: Borrower, revenue: number, walletBalance: number): Collection {
  const due = r2(Math.min(b.outstanding, b.repayRate * revenue));
  const collect = r2(Math.min(due, Math.max(0, walletBalance)));
  const receivable = r2(due - collect);
  return {
    borrower: b.key,
    due,
    collect,
    receivable,
    reason: receivable > 0 ? `Due ${due} (${b.repayRate * 100}% of ${revenue} revenue) but the wallet holds ${walletBalance}: collect ${collect}, record ${receivable} as a receivable.` : `Collect ${due} (${b.repayRate * 100}% of ${revenue} revenue).`,
  };
}

export interface LendingPolicy {
  reserveFloor: number;
  /** Disburse a partial tranche only if it is at least this share of the approved amount. */
  minTrancheShare: number;
  /** Tranches are rounded down to this unit. */
  roundTo: number;
  /** Disbursements above this need a person. */
  autoLimit: number;
}

export const DEFAULT_LENDING_POLICY: LendingPolicy = { reserveFloor: 20_000, minTrancheShare: 0.6, roundTo: 100, autoLimit: 10_000 };

export interface Disbursement {
  action: "FULL" | "PARTIAL" | "DELAY";
  now: number;
  later: number;
  headroom: number;
  needsApproval: boolean;
  reason: string;
}

export function decideDisbursement(capital: number, approved: number, p: LendingPolicy = DEFAULT_LENDING_POLICY): Disbursement {
  const headroom = r2(capital - p.reserveFloor);
  if (approved <= headroom) {
    return { action: "FULL", now: approved, later: 0, headroom, needsApproval: approved > p.autoLimit, reason: `Full ${approved} fits within ${headroom} above the ${p.reserveFloor} floor.` };
  }
  const tranche = Math.floor(Math.max(0, headroom) / p.roundTo) * p.roundTo;
  if (tranche >= approved * p.minTrancheShare) {
    return {
      action: "PARTIAL",
      now: tranche,
      later: r2(approved - tranche),
      headroom,
      needsApproval: tranche > p.autoLimit,
      reason: `Full ${approved} would breach the ${p.reserveFloor} floor. Disburse ${tranche} now (${Math.round((tranche / approved) * 100)}% of approved) and ${r2(approved - tranche)} once repayments rebuild headroom.`,
    };
  }
  return { action: "DELAY", now: 0, later: approved, headroom, needsApproval: false, reason: `Only ${headroom} above the floor; a tranche under ${p.minTrancheShare * 100}% of ${approved} is not worth the borrower's setup. Delay.` };
}
