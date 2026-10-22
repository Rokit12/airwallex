/**
 * Kit 11 decisions. Every amount is integer cents of *USDZ (1 USDZ = 1 USD).
 * Metal enforces each agent's mandate on its own, never their sum, so the sum
 * rule lives here.
 */
export type AgentId = "SOURCING" | "SUPPORT" | "TREASURY";

export interface AgentLimits {
  agent: AgentId;
  capCents: number; // most per payment
  budgetCents: number; // lifetime budget
  payees: "LISTED" | "ANY";
}

export interface AgentState extends AgentLimits {
  spentCents: number;
}

export const DEFAULT_POLICY = {
  /** Kept unallocated for gas and owner operations (a key without *USDZ cannot change limits). */
  gasReserveCents: 300,
  /** Headroom on a new per-payment cap over the observed price (10%, rounded up to a cent). */
  capHeadroom: 0.1,
  /** Refunds kept in reserve for the rest of the period. */
  refundReserveCents: 100,
};

/**
 * What the agents may still spend (budget minus spend so far) must fit inside the
 * balance with the gas reserve left over. Metal never checks this sum.
 */
export function checkAllocation(balanceCents: number, agents: (AgentLimits & { spentCents?: number })[], p = DEFAULT_POLICY) {
  const total = agents.reduce((s, a) => s + a.budgetCents - (a.spentCents ?? 0), 0);
  const room = balanceCents - p.gasReserveCents;
  return { ok: total <= room, totalCents: total, roomCents: room, unallocatedCents: room - total };
}

/** Selling below the upstream cost loses money on every call. */
export function unitMargin(apiPriceCents: number, upstreamPriceCents: number) {
  return apiPriceCents - upstreamPriceCents;
}

export interface ReallocationInput {
  agents: AgentState[];
  balanceCents: number;
  newUpstreamPriceCents: number;
  apiPriceCents: number;
  /** Upstream purchases still expected this period. */
  remainingCalls: number;
  /** What the treasury still needs this period (sweep plus invoice). */
  treasuryNeedCents: number;
}

export interface Reallocation {
  action: "REALLOCATE" | "RAISE_API_PRICE" | "RATION_CALLS";
  limits: (AgentLimits & { spentCents?: number })[];
  moves: { from: AgentId | "UNALLOCATED"; cents: number }[];
  sourcingNeedCents: number;
  shortfallCents: number;
  servableCalls: number;
  reason: string;
}

const remaining = (a: AgentState) => a.budgetCents - a.spentCents;

/**
 * The upstream seller raised its price above the sourcing cap. Propose new limits:
 * raise the sourcing cap to the new price plus headroom, and fund the calls still
 * expected by taking, in order, unallocated balance, support's budget above the
 * refund reserve, then treasury's budget above what it still needs. Spend already
 * made stays (Metal's replace carries it), so budgets are set as spent + new room.
 */
export function proposeReallocation(i: ReallocationInput, p = DEFAULT_POLICY): Reallocation {
  const by = (id: AgentId) => i.agents.find((a) => a.agent === id)!;
  const S = by("SOURCING"), U = by("SUPPORT"), T = by("TREASURY");
  const newCap = Math.ceil(i.newUpstreamPriceCents * (1 + p.capHeadroom));
  const margin = unitMargin(i.apiPriceCents, i.newUpstreamPriceCents);
  const need = i.newUpstreamPriceCents * i.remainingCalls;
  const shortfall = Math.max(0, need - remaining(S));
  const keep = (a: AgentState, newRoom: number) => ({ agent: a.agent, capCents: a.capCents, payees: a.payees, budgetCents: a.spentCents + newRoom, spentCents: a.spentCents });

  if (margin <= 0) {
    return { action: "RAISE_API_PRICE", limits: i.agents, moves: [], sourcingNeedCents: need, shortfallCents: shortfall, servableCalls: 0, reason: `Upstream now costs ${i.newUpstreamPriceCents}c and the API sells for ${i.apiPriceCents}c: every call would lose money. Reprice before buying more.` };
  }

  const alloc = checkAllocation(i.balanceCents, i.agents, p);
  const sources: { from: AgentId | "UNALLOCATED"; free: number }[] = [
    { from: "UNALLOCATED", free: Math.max(0, alloc.unallocatedCents) },
    { from: "SUPPORT", free: Math.max(0, remaining(U) - p.refundReserveCents) },
    { from: "TREASURY", free: Math.max(0, remaining(T) - i.treasuryNeedCents) },
  ];
  let left = shortfall;
  const moves: Reallocation["moves"] = [];
  for (const s of sources) {
    if (left <= 0) break;
    const take = Math.min(left, s.free);
    if (take > 0) moves.push({ from: s.from, cents: take }), (left -= take);
  }
  const took = (id: AgentId | "UNALLOCATED") => moves.find((m) => m.from === id)?.cents ?? 0;
  const covered = shortfall - left;
  const sourcingRoom = remaining(S) + covered;
  const limits: (AgentLimits & { spentCents: number })[] = [
    { ...keep(S, sourcingRoom), capCents: newCap },
    keep(U, remaining(U) - took("SUPPORT")),
    keep(T, remaining(T) - took("TREASURY")),
  ];
  const servable = Math.floor(sourcingRoom / i.newUpstreamPriceCents);
  if (left > 0) {
    return { action: "RATION_CALLS", limits, moves, sourcingNeedCents: need, shortfallCents: shortfall, servableCalls: servable, reason: `Only ${covered}c of the ${shortfall}c shortfall can move without touching the refund reserve or the treasury's needs: serve ${servable} of ${i.remainingCalls} expected calls and pause the rest.` };
  }
  return {
    action: "REALLOCATE",
    limits,
    moves,
    sourcingNeedCents: need,
    shortfallCents: shortfall,
    servableCalls: servable,
    reason: `Raise the sourcing cap to ${newCap}c (price ${i.newUpstreamPriceCents}c + ${Math.round(p.capHeadroom * 100)}%) and move ${shortfall}c of budget to sourcing (${moves.map((m) => `${m.cents}c from ${m.from.toLowerCase()}`).join(", ")}). Margin stays ${margin}c a call.`,
  };
}

/** Earnings to move to Airwallex: everything above what the agents may still spend plus the gas reserve. */
export function sweepAmount(balanceCents: number, agents: AgentState[], p = DEFAULT_POLICY) {
  const committed = agents.filter((a) => a.agent !== "TREASURY").reduce((s, a) => s + remaining(a), 0);
  return Math.max(0, balanceCents - committed - p.gasReserveCents);
}

/** After a payout timed out, the outcome is unconfirmed: read it before doing anything. */
export function afterTimeout(chainOutcome: "paid" | "refused" | "pending" | "not_found"): "DONE" | "WAIT" | "RESEND_SAME_ID" | "STOP" {
  if (chainOutcome === "paid") return "DONE";
  if (chainOutcome === "pending") return "WAIT";
  if (chainOutcome === "not_found") return "RESEND_SAME_ID"; // same payment id: Metal pays it at most once
  return "STOP";
}

/** Before crediting earnings to Airwallex, look for a deposit already referencing the Metal transaction. */
export function depositDecision(existingReferences: string[], tx: string): "SKIP_ALREADY_CREDITED" | "CREDIT" {
  return existingReferences.some((r) => r.toLowerCase() === tx.toLowerCase()) ? "SKIP_ALREADY_CREDITED" : "CREDIT";
}
