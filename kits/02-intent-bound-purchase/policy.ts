/**
 * Kit 2 policy: choose SaaS billing terms from a cash forecast, then derive card
 * controls that make the choice enforceable. All amounts, limits and dates live
 * here, not in a prompt.
 */

export interface Quote {
  vendor: string;
  currency: string;
  monthlyPrice: number;
  annualPrice: number;
  /** Merchant category codes the vendor bills under. */
  mccs: string[];
  annualRefundable: boolean;
}

export interface Forecast {
  startingCash: number;
  reserveFloor: number;
  /** Net operating cash flow per week, excluding this purchase. Index 0 = this week. */
  weeklyNet: number[];
}

export type Plan = "MONTHLY" | "ANNUAL";

export interface PlanPath {
  plan: Plan;
  balances: number[];
  minBalance: number;
  firstBreachWeek: number | null;
  costOverHorizon: number;
}

export interface PurchaseDecision {
  plan: Plan | "ESCALATE";
  paths: Record<Plan, PlanPath>;
  annualSavingPct: number;
  /** Week from which switching to annual no longer breaches the floor; null if never inside the horizon. */
  reconsiderWeek: number | null;
  rationale: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Monthly bills land in weeks 0, 4, 8, 12...; annual is paid up front at `startWeek`. */
export function projectPath(q: Quote, f: Forecast, plan: Plan, startWeek = 0): PlanPath {
  const balances: number[] = [];
  let cash = f.startingCash;
  let cost = 0;
  for (let w = 0; w < f.weeklyNet.length; w++) {
    cash += f.weeklyNet[w]!;
    const monthlyDue = plan === "MONTHLY" || w < startWeek ? w % 4 === 0 : false;
    if (monthlyDue) {
      cash -= q.monthlyPrice;
      cost += q.monthlyPrice;
    }
    if (plan === "ANNUAL" && w === startWeek) {
      cash -= q.annualPrice;
      cost += q.annualPrice;
    }
    balances.push(r2(cash));
  }
  const breach = balances.findIndex((b) => b < f.reserveFloor);
  return { plan, balances, minBalance: Math.min(...balances), firstBreachWeek: breach === -1 ? null : breach, costOverHorizon: r2(cost) };
}

export function choosePlan(q: Quote, f: Forecast): PurchaseDecision {
  const monthly = projectPath(q, f, "MONTHLY");
  const annual = projectPath(q, f, "ANNUAL");
  const annualSavingPct = r2((1 - q.annualPrice / (q.monthlyPrice * 12)) * 100);
  const paths = { MONTHLY: monthly, ANNUAL: annual };

  let reconsiderWeek: number | null = null;
  for (let w = 1; w < f.weeklyNet.length; w++) {
    if (projectPath(q, f, "ANNUAL", w).firstBreachWeek === null) {
      reconsiderWeek = w;
      break;
    }
  }

  if (annual.firstBreachWeek === null) {
    return { plan: "ANNUAL", paths, annualSavingPct, reconsiderWeek: null, rationale: `Annual saves ${annualSavingPct}% and cash stays above the ${f.reserveFloor} floor (low point ${annual.minBalance}).` };
  }
  if (monthly.firstBreachWeek === null) {
    return {
      plan: "MONTHLY",
      paths,
      annualSavingPct,
      reconsiderWeek,
      rationale:
        `Annual saves ${annualSavingPct}% but drops cash to ${annual.balances[annual.firstBreachWeek]} in week ${annual.firstBreachWeek + 1}, below the ${f.reserveFloor} floor. ` +
        `Monthly keeps the low point at ${monthly.minBalance} and preserves the option to cancel` +
        (q.annualRefundable ? "." : "; annual is non-refundable."),
    };
  }
  return { plan: "ESCALATE", paths, annualSavingPct, reconsiderWeek, rationale: "Both plans breach the reserve floor; a person must decide whether to buy at all." };
}

// ── Card controls ────────────────────────────────────────────────────────────
export interface CardControls {
  allowed_transaction_count: "MULTIPLE";
  allowed_currencies: string[];
  allowed_merchant_categories: string[];
  transaction_limits: { currency: string; limits: { amount: number; interval: "PER_TRANSACTION" | "MONTHLY" | "ALL_TIME" }[] };
}

/** The card can pay exactly one monthly bill per month, in the quoted currency, at the vendor's MCCs. */
export function controlsFor(q: Quote, plan: Plan): CardControls {
  const bill = plan === "MONTHLY" ? q.monthlyPrice : q.annualPrice;
  return {
    allowed_transaction_count: "MULTIPLE",
    allowed_currencies: [q.currency],
    allowed_merchant_categories: q.mccs,
    transaction_limits: {
      currency: q.currency,
      limits: [
        { amount: bill, interval: "PER_TRANSACTION" }, // inclusive: exactly `bill` clears
        { amount: plan === "MONTHLY" ? bill : q.annualPrice, interval: plan === "MONTHLY" ? "MONTHLY" : "ALL_TIME" },
      ],
    },
  };
}

export type Outcome = "APPROVED" | "LIMIT_EXCEEDED" | "CURRENCY_NOT_ALLOWED" | "MERCHANT_CATEGORY_NOT_ALLOWED" | "CARD_INACTIVE";

/** What the controls should do with an authorization, so the demo can check Airwallex agrees. */
export function predict(c: CardControls, auth: { amount: number; currency: string; mcc: string }, spentThisPeriod: number, cardActive: boolean): Outcome {
  if (!cardActive) return "CARD_INACTIVE";
  if (!c.allowed_currencies.includes(auth.currency)) return "CURRENCY_NOT_ALLOWED";
  if (c.allowed_merchant_categories.length && !c.allowed_merchant_categories.includes(auth.mcc)) return "MERCHANT_CATEGORY_NOT_ALLOWED";
  for (const l of c.transaction_limits.limits) {
    const used = l.interval === "PER_TRANSACTION" ? 0 : spentThisPeriod;
    if (used + auth.amount > l.amount) return "LIMIT_EXCEEDED";
  }
  return "APPROVED";
}
