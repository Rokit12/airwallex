/**
 * Kit 1 policy: five obligations in three currencies fall due within 72 hours
 * and free cash covers only part of them. Decide what to fund, convert, defer
 * or escalate, and how much FX the agent may book without a person.
 *
 * Everything here is deterministic. Rates come in as data (from Airwallex);
 * the model never chooses an amount.
 */

export type Ccy = "USD" | "EUR" | "GBP";
export type Priority = "CRITICAL" | "TIME_SENSITIVE" | "STANDARD";

export interface Obligation {
  id: string;
  payee: string;
  amount: number;
  currency: Ccy;
  method: "LOCAL" | "SWIFT";
  dueInHours: number;
  priority: Priority;
  /** What it costs to pay late (fees, penalties), in USD. */
  lateCostUsd: number;
  /** Why it matters, shown to the approver. */
  note: string;
  /** Policy flags that require a person regardless of cash. */
  newVendor?: boolean;
}

export interface TreasuryPolicy {
  baseCurrency: "USD";
  reserveFloor: number;
  /** Flat fee per SWIFT payout, in the payout currency. LOCAL is free. */
  swiftFee: Partial<Record<Ccy, number>>;
  /** Payments to new vendors above this need a person. */
  newVendorLimit: number;
  /** Autonomous FX limit (USD sold per conversion) by forecast confidence. */
  fxLimitByConfidence: Record<Confidence, number>;
}

export type Confidence = "HIGH" | "LOW";

export const DEFAULT_TREASURY_POLICY: TreasuryPolicy = {
  baseCurrency: "USD",
  reserveFloor: 10_000,
  swiftFee: { EUR: 12.85, GBP: 12.85, USD: 15 },
  newVendorLimit: 10_000,
  fxLimitByConfidence: { HIGH: 8_000, LOW: 4_000 },
};

export interface Position {
  /** Operating cash per currency (the treasury envelope on the wallet). */
  cash: Record<Ccy, number>;
  /** USD per 1 unit of currency, from Airwallex. */
  usdPer: Record<Ccy, number>;
}

export type Action = "FUND" | "CONVERT_AND_FUND" | "DEFER" | "ESCALATE";

export interface Line {
  obligation: string;
  action: Action;
  /** Amount needed in the obligation currency including payout fee. */
  needed: number;
  /** Bought by FX: the shortfall only, never the whole obligation. */
  convertBuy: number;
  /** USD sold for the conversion (indicative). */
  convertSellUsd: number;
  /** FX above the autonomous limit needs a person. */
  needsApproval: boolean;
  usdCost: number;
  reason: string;
}

export interface Plan {
  lines: Line[];
  freeUsdBefore: number;
  freeUsdAfter: number;
  confidence: Confidence;
  fxLimit: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

const rank = (o: Obligation) => (o.priority === "CRITICAL" ? 0 : o.priority === "TIME_SENSITIVE" ? 1 : 2) * 1000 + o.dueInHours;

/**
 * Greedy plan: escalate policy exceptions first, then fund in priority order
 * while free cash above the floor allows; whatever does not fit is deferred.
 * Foreign-currency balances are used before buying; FX buys only the shortfall.
 */
export function plan(obligations: Obligation[], pos: Position, confidence: Confidence, p: TreasuryPolicy = DEFAULT_TREASURY_POLICY): Plan {
  const cash = { ...pos.cash };
  let freeUsd = r2(cash.USD - p.reserveFloor);
  const freeUsdBefore = freeUsd;
  const fxLimit = p.fxLimitByConfidence[confidence];
  const lines: Line[] = [];

  for (const o of [...obligations].sort((a, b) => rank(a) - rank(b))) {
    const fee = o.method === "SWIFT" ? (p.swiftFee[o.currency] ?? 0) : 0;
    const needed = r2(o.amount + fee);

    if (o.newVendor && o.amount * pos.usdPer[o.currency] > p.newVendorLimit) {
      lines.push({ obligation: o.id, action: "ESCALATE", needed, convertBuy: 0, convertSellUsd: 0, needsApproval: true, usdCost: 0, reason: `New vendor over ${p.newVendorLimit.toLocaleString()} USD: policy requires a person.` });
      continue;
    }

    const held = o.currency === "USD" ? 0 : Math.max(0, cash[o.currency]);
    const convertBuy = o.currency === "USD" ? 0 : r2(Math.max(0, needed - held));
    const usdCost = o.currency === "USD" ? needed : r2(convertBuy * pos.usdPer[o.currency]);

    if (usdCost <= freeUsd) {
      freeUsd = r2(freeUsd - usdCost);
      cash.USD = r2(cash.USD - usdCost);
      if (o.currency !== "USD") cash[o.currency] = r2(cash[o.currency] + convertBuy - needed);
      lines.push({
        obligation: o.id,
        action: convertBuy > 0 ? "CONVERT_AND_FUND" : "FUND",
        needed,
        convertBuy,
        convertSellUsd: usdCost * (o.currency === "USD" ? 0 : 1),
        needsApproval: convertBuy > 0 && usdCost > fxLimit,
        usdCost,
        reason:
          (o.priority === "CRITICAL" ? "Operations stop without it. " : o.priority === "TIME_SENSITIVE" ? "Time-sensitive. " : "") +
          (convertBuy > 0 ? `Buy only the ${o.currency} shortfall (${convertBuy} incl. ${fee ? `${fee} SWIFT fee` : "no fee"}, ${held} already held).` : "Paid from USD."),
      });
    } else {
      lines.push({
        obligation: o.id,
        action: "DEFER",
        needed,
        convertBuy: 0,
        convertSellUsd: 0,
        needsApproval: false,
        usdCost,
        reason: `Needs ${usdCost} USD; only ${freeUsd} free above the ${p.reserveFloor} floor. Deferring costs ${o.lateCostUsd} USD.`,
      });
    }
  }
  return { lines, freeUsdBefore, freeUsdAfter: freeUsd, confidence, fxLimit };
}

/** After new information, report only the lines whose decision changed. */
export function changedLines(before: Plan, after: Plan) {
  return after.lines.filter((l) => {
    const b = before.lines.find((x) => x.obligation === l.obligation);
    return !b || b.action !== l.action || b.needsApproval !== l.needsApproval;
  });
}

/**
 * Confidence in an expected receipt: HIGH when bank data and the invoice agree
 * and nothing contradicts them; any contradiction (e.g. a customer email moving
 * the date) makes it LOW.
 */
export function receiptConfidence(s: { invoiceMatchesBankData: boolean; contradiction: boolean }): Confidence {
  return s.invoiceMatchesBankData && !s.contradiction ? "HIGH" : "LOW";
}
