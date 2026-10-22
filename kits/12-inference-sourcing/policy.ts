/**
 * Kit 12 decisions. Metal clearing amounts are in micros (a millionth of *USDZ);
 * Airwallex card holds and captures are in cents (USD, major units / 100).
 * Prices always come from a provider's latest 402 offer, never from a cache.
 */
export type Kind = "model" | "search" | "data";
export type Tier = "premium" | "standard" | "budget";

export interface ProviderView {
  id: string;
  kind: Kind;
  tier: Tier;
  /** Price per chunk from the provider's latest 402 offer. */
  priceMicros: number;
  /** Observed latency (moving average of recent chunks). */
  latencyMs: number;
  up: boolean;
}

export interface Step {
  id: string;
  kind: Kind;
  chunks: number;
  /** The model judged this step's answer worth the premium provider (e.g. the customer-facing draft). */
  worthPremium: boolean;
  slaMs: number;
}

export const DEFAULT_POLICY = {
  /** Float kept back in the operator's wallet; never deposited. */
  floatFloorMicros: 300_000,
  /** A raised hold covers the new projection plus this margin. */
  holdMargin: 0.1,
};

export interface RouteChoice {
  provider: string | null;
  costMicros: number;
  reason: string;
}

const cost = (p: ProviderView, s: Step) => p.priceMicros * s.chunks;

/**
 * Cheapest way to finish the remaining steps at today's offers, using only
 * providers that meet each step's SLA (a slow provider is not an option).
 */
export function minCostToFinish(steps: Step[], providers: ProviderView[]) {
  return steps.reduce((sum, s) => {
    const ofKind = providers.filter((p) => p.up && p.kind === s.kind);
    const usable = ofKind.filter((p) => p.latencyMs <= s.slaMs);
    const c = (usable.length ? usable : ofKind).map((p) => cost(p, s));
    return sum + (c.length ? Math.min(...c) : 0);
  }, 0);
}

/**
 * Pick a provider for one step. Candidates must be up and meet the step's latency
 * SLA. A step worth premium goes to the premium tier if the job can afford it
 * while still finishing the rest at minimum cost; otherwise the cheapest candidate.
 */
export function route(step: Step, providers: ProviderView[], availableMicros: number): RouteChoice {
  const ofKind = providers.filter((p) => p.up && p.kind === step.kind);
  if (!ofKind.length) return { provider: null, costMicros: 0, reason: `no ${step.kind} provider is up` };
  const fast = ofKind.filter((p) => p.latencyMs <= step.slaMs);
  const slow = ofKind.filter((p) => p.latencyMs > step.slaMs).map((p) => p.id);
  const pool = fast.length ? fast : [...ofKind].sort((a, b) => a.latencyMs - b.latencyMs).slice(0, 1);
  const byPrice = [...pool].sort((a, b) => a.priceMicros - b.priceMicros);
  const affordable = byPrice.filter((p) => cost(p, step) <= availableMicros);
  const note = slow.length ? ` (skipping ${slow.join(", ")}: slower than the ${step.slaMs} ms SLA)` : "";
  if (step.worthPremium) {
    const premium = affordable.find((p) => p.tier === "premium");
    if (premium) return { provider: premium.id, costMicros: cost(premium, step), reason: `worth premium and affordable${note}` };
  }
  const pick = affordable[0] ?? null;
  if (!pick) return { provider: null, costMicros: cost(byPrice[0]!, step), reason: `even the cheapest (${byPrice[0]!.id}) exceeds what the job can spend${note}` };
  return { provider: pick.id, costMicros: cost(pick, step), reason: `${step.worthPremium ? "premium not affordable; " : ""}cheapest within SLA${note}` };
}

export interface JobMoney {
  holdCents: number;
  spentMicros: number;
  /** Cost of the remaining steps at the routes the agent would choose now. */
  projectedRestMicros: number;
  /** Deposit the job's key can still spend in clearing. */
  depositSpendableMicros: number;
}

export type OverrunAction = "CONTINUE" | "TOP_UP" | "RAISE_HOLD_THEN_TOP_UP";

/**
 * When a job's projection changes: if it no longer fits the card hold, raise the
 * hold first (the customer approves the new amount), then top up the deposit.
 * Never top up a deposit beyond what the hold covers.
 */
export function overrun(j: JobMoney, p = DEFAULT_POLICY) {
  const projected = j.spentMicros + j.projectedRestMicros;
  const holdMicros = j.holdCents * 10_000;
  const topUpMicros = Math.max(0, j.projectedRestMicros - j.depositSpendableMicros);
  if (projected <= holdMicros) {
    return { action: (topUpMicros > 0 ? "TOP_UP" : "CONTINUE") as OverrunAction, projectedMicros: projected, newHoldCents: j.holdCents, topUpMicros };
  }
  const newHoldCents = Math.ceil((projected * (1 + p.holdMargin)) / 10_000);
  return { action: "RAISE_HOLD_THEN_TOP_UP" as OverrunAction, projectedMicros: projected, newHoldCents, topUpMicros };
}

export interface FloatRequest {
  job: string;
  micros: number;
  /** Share of the job already done (0..1): finishing nearly-done work first. */
  progress: number;
}

/**
 * The float covers less than every job's budget. Grant top-ups only above the
 * floor, nearest-to-done first; what is not granted waits for withdrawals,
 * which only arrive after their epoch closes.
 */
export function rationFloat(floatMicros: number, requests: FloatRequest[], p = DEFAULT_POLICY) {
  let available = Math.max(0, floatMicros - p.floatFloorMicros);
  const grants: { job: string; micros: number; waiting: number }[] = [];
  for (const r of [...requests].sort((a, b) => b.progress - a.progress)) {
    const g = Math.min(r.micros, available);
    available -= g;
    grants.push({ job: r.job, micros: g, waiting: r.micros - g });
  }
  return { grants, leftAboveFloorMicros: available };
}

/** One capture per hold, from the job's clearing position, never above the hold. A failed job is not charged. */
export function settleHold(positionMicros: number, holdCents: number, jobFailed: boolean) {
  if (jobFailed) return { action: "CANCEL" as const, captureCents: 0, absorbedMicros: positionMicros };
  const spentCents = Math.ceil(positionMicros / 10_000);
  const captureCents = Math.min(spentCents, holdCents);
  return { action: "CAPTURE" as const, captureCents, absorbedMicros: Math.max(0, positionMicros - captureCents * 10_000) };
}
