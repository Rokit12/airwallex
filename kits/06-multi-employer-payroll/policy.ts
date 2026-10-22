/**
 * Kit 6 policy: weekly contractor payroll for several employers, each a separate
 * connected account. Price each batch including FX and SWIFT fees, pay what each
 * employer's own wallet covers, and never use one employer's money for another.
 */

export type Ccy = "USD" | "EUR" | "GBP";

export interface Contractor {
  name: string;
  country: string;
  currency: Ccy;
  amount: number;
  method: "LOCAL" | "SWIFT";
}

export interface PayrollPolicy {
  swiftFee: Partial<Record<Ccy, number>>;
  /** Platform fee per contractor paid, in USD. */
  feePerContractor: number;
  /** Advances from the platform's own capital always need a person. */
  maxAdvance: number;
}

export const DEFAULT_PAYROLL_POLICY: PayrollPolicy = { swiftFee: { EUR: 12.85, GBP: 12.85, USD: 15 }, feePerContractor: 25, maxAdvance: 1000 };

export interface PricedLine extends Contractor {
  fee: number;
  /** Amount needed in the payout currency, including the SWIFT fee. */
  needed: number;
  /** USD needed to fund it (conversion at the given rate). */
  usd: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function price(contractors: Contractor[], usdPer: Record<Ccy, number>, p: PayrollPolicy = DEFAULT_PAYROLL_POLICY): PricedLine[] {
  return contractors.map((c) => {
    const fee = c.method === "SWIFT" ? (p.swiftFee[c.currency] ?? 0) : 0;
    const needed = r2(c.amount + fee);
    return { ...c, fee, needed, usd: c.currency === "USD" ? needed : r2(needed * usdPer[c.currency]) };
  });
}

export interface EmployerPlan {
  employer: string;
  balance: number;
  totalUsd: number;
  pay: PricedLine[];
  hold: PricedLine[];
  /** USD short for the held lines plus fees, if any. */
  shortfall: number;
  action: "PAY_ALL" | "PAY_PARTIAL_AND_REQUEST_ADVANCE" | "PAY_PARTIAL_AND_HOLD";
  reason: string;
}

/**
 * Plan one employer against its own balance only. Contractors are paid in full
 * or held (never part-paid); the platform fee comes last.
 */
export function planEmployer(employer: string, balance: number, lines: PricedLine[], p: PayrollPolicy = DEFAULT_PAYROLL_POLICY): EmployerPlan {
  const fees = lines.length * p.feePerContractor;
  const totalUsd = r2(lines.reduce((s, l) => s + l.usd, 0) + fees);
  let left = balance;
  const pay: PricedLine[] = [];
  const hold: PricedLine[] = [];
  for (const l of lines) {
    if (l.usd <= left) {
      pay.push(l);
      left = r2(left - l.usd);
    } else hold.push(l);
  }
  const needForHeld = r2(hold.reduce((s, l) => s + l.usd, 0) + fees);
  const shortfall = r2(Math.max(0, needForHeld - left));
  if (!hold.length && left >= fees) {
    return { employer, balance, totalUsd, pay, hold, shortfall: 0, action: "PAY_ALL", reason: `Own balance ${balance} covers payroll and fees (${totalUsd}).` };
  }
  const canAdvance = shortfall <= p.maxAdvance;
  return {
    employer,
    balance,
    totalUsd,
    pay,
    hold,
    shortfall,
    action: canAdvance ? "PAY_PARTIAL_AND_REQUEST_ADVANCE" : "PAY_PARTIAL_AND_HOLD",
    reason:
      `Own balance ${balance} is ${r2(totalUsd - balance)} short of ${totalUsd}. Pay ${pay.map((x) => x.name).join(", ") || "nobody"} in full; hold ${hold.map((x) => x.name).join(", ")}. ` +
      (canAdvance ? `A platform advance of ${shortfall} (platform capital, not another employer's funds) needs approval.` : `Shortfall exceeds the ${p.maxAdvance} advance limit; ask the employer to top up.`),
  };
}

/** The bug this kit guards against: summing every tenant's balance says there is plenty. */
export function naivePooledCheck(balances: number[], totals: number[]) {
  const pooled = balances.reduce((a, b) => a + b, 0);
  const needed = totals.reduce((a, b) => a + b, 0);
  return { pooled: r2(pooled), needed: r2(needed), saysEnough: pooled >= needed };
}
