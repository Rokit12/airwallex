/**
 * Kit 8 policy: marketplace settlement. The platform pays sellers what they
 * earned but stays liable for refunds after payout, so it holds a reserve per
 * seller. Airwallex has no escrow object for this, so reserves live in this ledger.
 */

export interface Seller {
  key: string;
  owed: number;
  /** Trailing 90-day refund rate. */
  refundRate: number;
  monthsActive: number;
}

export interface ReservePolicy {
  /** Reserve = owed × refund rate × this multiplier. */
  riskMultiplier: number;
  /** New sellers (fewer months than newSellerMonths) hold at least this share. */
  newSellerMinShare: number;
  newSellerMonths: number;
  /** Share of undelivered orders expected to turn into refunds. */
  undeliveredRefundShare: number;
}

export const DEFAULT_RESERVE_POLICY: ReservePolicy = { riskMultiplier: 2, newSellerMinShare: 0.15, newSellerMonths: 3, undeliveredRefundShare: 0.9 };

const r2 = (n: number) => Math.round(n * 100) / 100;

export function reserveFor(s: Seller, p: ReservePolicy = DEFAULT_RESERVE_POLICY): { reserve: number; reason: string } {
  const model = r2(s.owed * s.refundRate * p.riskMultiplier);
  const floor = s.monthsActive < p.newSellerMonths ? r2(s.owed * p.newSellerMinShare) : 0;
  return floor > model
    ? { reserve: floor, reason: `New seller (${s.monthsActive} months): minimum ${p.newSellerMinShare * 100}% of ${s.owed}.` }
    : { reserve: model, reason: `${(s.refundRate * 100).toFixed(1)}% trailing refund rate × ${p.riskMultiplier} on ${s.owed}.` };
}

/** New evidence for one seller: raise the reserve to cover the expected refunds if they exceed the model. */
export function reserveWithEvidence(s: Seller, undelivered: { orders: number; avgValue: number }, p: ReservePolicy = DEFAULT_RESERVE_POLICY) {
  const base = reserveFor(s, p);
  const exposure = r2(undelivered.orders * undelivered.avgValue * p.undeliveredRefundShare);
  return exposure > base.reserve
    ? { reserve: exposure, exposure, reason: `${undelivered.orders} undelivered orders × ${undelivered.avgValue} × ${p.undeliveredRefundShare * 100}% expected refunds = ${exposure}, above the model reserve ${base.reserve}.` }
    : { reserve: base.reserve, exposure, reason: base.reason };
}

export interface SellerLedger {
  owed: number;
  paidOut: number;
  refunds: number;
  recovered: number;
  reserveHeld: number;
}

/** Every dollar owed is paid out, spent on refunds net of recoveries, or still held as reserve. */
export function reconcile(l: SellerLedger): { ok: boolean; difference: number } {
  const accounted = r2(l.paidOut + l.refunds - l.recovered + l.reserveHeld);
  return { ok: Math.abs(accounted - l.owed) < 0.005, difference: r2(l.owed - accounted) };
}
