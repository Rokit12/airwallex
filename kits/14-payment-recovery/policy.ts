/**
 * Kit 14 · Failed-Payment Recovery: the decisions, as pure functions.
 *
 * A subscription business's monthly card charges fail for different reasons.
 * Retrying the wrong ones wastes the customer's goodwill and breaks card-network
 * rules (networks fine merchants that retry "do not reattempt" codes or retry
 * too often). So the decision comes from the issuer's response code, in code:
 *
 *  - SOFT  (51 insufficient funds, 91 issuer unavailable…): retry on a schedule
 *          after likely paydays, a capped number of times.
 *  - GENERIC (05 do not honour): one retry, then ask for another card.
 *  - CARD  (54 expired, 14 invalid number, 41/43 lost or stolen…): never retry
 *          that card; ask the customer to update it.
 *  - RISK  (risk_declined): never retry; pause access until a person verifies.
 *
 * One payment intent per invoice: every retry confirms the same intent, so an
 * invoice can only ever be charged once.
 */

export type DeclineClass = "SOFT" | "GENERIC" | "CARD" | "RISK";
export type Action = "RETRY" | "ASK_NEW_CARD" | "PAUSE_AND_REVIEW" | "GIVE_UP";

export const POLICY = {
  /** Days after the failed charge to retry soft declines (after typical paydays). */
  softRetryDays: [3, 5, 7],
  genericRetries: 1,
  /** Mastercard and Visa cap reattempts; stay well under both. */
  maxAttemptsPer30Days: 4,
  /** Service continues this long after the first failure, then pauses. */
  graceDays: 7,
};

const SOFT = new Set(["51", "61", "65", "91", "96"]);
const CARD = new Set(["14", "41", "43", "54", "57", "62", "04", "07", "15"]);

export function classify(failure: { code: string; responseCode?: string }): DeclineClass {
  if (failure.code === "risk_declined" || failure.code === "fraud_rejected") return "RISK";
  const rc = failure.responseCode ?? "";
  if (SOFT.has(rc)) return "SOFT";
  if (CARD.has(rc)) return "CARD";
  return "GENERIC";
}

export interface History { declines: { day: number; class: DeclineClass; responseCode?: string }[]; cardUpdatedOnDay?: number }

/**
 * What to do next for one unpaid invoice, given its decline history so far.
 * A new card resets card-specific reasons but never risk.
 */
export function nextStep(h: History): { action: Action; onDay?: number; reason: string } {
  const last = h.declines[h.declines.length - 1];
  if (!last) return { action: "RETRY", onDay: 0, reason: "first charge" };
  if (h.declines.some((d) => d.class === "RISK")) return { action: "PAUSE_AND_REVIEW", reason: "a risk decline is never retried; a person verifies the customer first" };
  const attempts = h.declines.length;
  if (attempts >= POLICY.maxAttemptsPer30Days) return { action: "GIVE_UP", reason: `${attempts} attempts in 30 days: at the network-safe limit` };
  if (h.cardUpdatedOnDay !== undefined && h.cardUpdatedOnDay >= last.day) return { action: "RETRY", onDay: h.cardUpdatedOnDay, reason: "the customer updated the card: charge the same invoice once with it" };
  if (last.class === "CARD") return { action: "ASK_NEW_CARD", reason: `response ${last.responseCode}: this card can't be charged, retrying it breaks network rules` };
  if (last.class === "GENERIC") {
    const generic = h.declines.filter((d) => d.class === "GENERIC").length;
    return generic <= POLICY.genericRetries ? { action: "RETRY", onDay: last.day + 1, reason: `response ${last.responseCode} (do not honour): one retry the next day` } : { action: "ASK_NEW_CARD", reason: `response ${last.responseCode} again: stop retrying, ask for another card` };
  }
  const softs = h.declines.filter((d) => d.class === "SOFT").length;
  const day = POLICY.softRetryDays[softs - 1];
  return day !== undefined ? { action: "RETRY", onDay: day, reason: `response ${last.responseCode} (insufficient funds): retry on day ${day}, after payday` } : { action: "ASK_NEW_CARD", reason: "soft retries used up: ask for another card" };
}

/** Access stays on through the grace period; risk pauses at once. */
export function accessOn(h: History, today: number): boolean {
  if (h.declines.some((d) => d.class === "RISK")) return false;
  const first = h.declines[0];
  return !first || today - first.day <= POLICY.graceDays;
}
