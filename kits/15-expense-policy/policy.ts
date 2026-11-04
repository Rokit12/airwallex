/**
 * Kit 15 · Expense Policy Agent: the decisions, as pure functions.
 *
 * An employee travels on a company virtual card. The agent matches each card
 * transaction to a receipt, checks it against the travel policy, finds
 * personal charges, and settles the trip: approved out-of-pocket costs minus
 * personal charges made on the company card. Card controls block what the
 * policy forbids outright; this code handles what only a receipt can show.
 */

export const POLICY = {
  receiptRequiredFrom: 25,
  lodgingPerNight: 220,
  mealPerPerson: 75,
  cabin: ["ECONOMY", "PREMIUM_ECONOMY"],
  personalKeywords: ["minibar", "spa", "in-room movie", "pay-per-view", "laundry"],
  /** Blocked card attempts before the card is frozen. */
  blockedAttemptsBeforeFreeze: 3,
  receiptDeadlineDays: 5,
};

export interface CardTx { id: string; merchant: string; mcc: string; amount: number; status: "APPROVED" | "DECLINED"; declineReason?: string }
export interface ReceiptLine { description: string; amount: number }
export interface Receipt { id: string; merchant: string; total: number; category: "AIRFARE" | "LODGING" | "MEAL" | "TRANSPORT" | "PARKING" | "BAGGAGE" | "BAR"; nights?: number; attendees?: number; cabin?: string; lines?: ReceiptLine[]; paidWith: "COMPANY_CARD" | "PERSONAL" }

const r2 = (n: number) => Math.round(n * 100) / 100;
const tokens = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((t) => t.length > 2);

/** Same amount (to the cent) and at least one shared merchant word. */
export function matchReceipt(tx: CardTx, receipts: Receipt[]): Receipt | undefined {
  const t = new Set(tokens(tx.merchant));
  return receipts.find((r) => r.paidWith === "COMPANY_CARD" && r2(r.total) === r2(tx.amount) && tokens(r.merchant).some((w) => t.has(w)));
}

export type Finding = { kind: "OK" | "PERSONAL" | "OVER_POLICY" | "NOT_REIMBURSABLE" | "MISSING_RECEIPT" | "NO_RECEIPT_NEEDED" | "BLOCKED_BY_CARD"; amount: number; note: string };

/** Policy check of one receipt. Personal lines are owed back by the employee. */
export function checkReceipt(r: Receipt): Finding[] {
  const out: Finding[] = [];
  const personal = (r.lines ?? []).filter((l) => POLICY.personalKeywords.some((k) => l.description.toLowerCase().includes(k)));
  for (const l of personal) out.push({ kind: "PERSONAL", amount: l.amount, note: `${l.description}: personal, owed back` });
  if (r.category === "LODGING" && r.nights) {
    const room = r2((r.lines ?? []).filter((l) => /room/i.test(l.description)).reduce((s, l) => s + l.amount, 0));
    const perNight = r2(room / r.nights);
    if (perNight > POLICY.lodgingPerNight) out.push({ kind: "OVER_POLICY", amount: r2((perNight - POLICY.lodgingPerNight) * r.nights), note: `room ${perNight.toFixed(2)}/night is above the ${POLICY.lodgingPerNight} cap` });
  }
  if (r.category === "MEAL" && r.attendees) {
    const pp = r2(r.total / r.attendees);
    if (pp > POLICY.mealPerPerson) out.push({ kind: "OVER_POLICY", amount: r2(r.total - POLICY.mealPerPerson * r.attendees), note: `${pp.toFixed(2)} per person is above the ${POLICY.mealPerPerson} cap` });
  }
  if (r.category === "AIRFARE" && r.cabin && !POLICY.cabin.includes(r.cabin.toUpperCase())) out.push({ kind: "OVER_POLICY", amount: 0, note: `${r.cabin} cabin needs pre-approval` });
  if (r.category === "BAR") out.push({ kind: "NOT_REIMBURSABLE", amount: r.total, note: "a bar tab without a meal is not reimbursable" });
  if (!out.length) out.push({ kind: "OK", amount: 0, note: "within policy" });
  return out;
}

/** Every card transaction: matched and checked, under the receipt threshold, missing a receipt, or blocked by the card. */
export function reviewCard(txs: CardTx[], receipts: Receipt[]) {
  return txs.map((tx) => {
    if (tx.status === "DECLINED") return { tx, receipt: undefined, findings: [{ kind: "BLOCKED_BY_CARD" as const, amount: 0, note: `card controls declined it (${tx.declineReason})` }] };
    const receipt = matchReceipt(tx, receipts);
    if (receipt) return { tx, receipt, findings: checkReceipt(receipt) };
    if (tx.amount < POLICY.receiptRequiredFrom) return { tx, receipt, findings: [{ kind: "NO_RECEIPT_NEEDED" as const, amount: 0, note: `under ${POLICY.receiptRequiredFrom}` }] };
    return { tx, receipt, findings: [{ kind: "MISSING_RECEIPT" as const, amount: tx.amount, note: `receipt due within ${POLICY.receiptDeadlineDays} days` }] };
  });
}

/**
 * Settles the trip. Out-of-pocket receipts that pass policy are reimbursed;
 * personal charges on the company card are deducted. Missing receipts hold the
 * settlement (nothing is paid until the trip is complete).
 */
export function settle(review: ReturnType<typeof reviewCard>, outOfPocket: Receipt[]) {
  const owed = r2(review.flatMap((r) => r.findings).filter((f) => f.kind === "PERSONAL" || f.kind === "OVER_POLICY").reduce((s, f) => s + f.amount, 0));
  const claims = outOfPocket.map((r) => ({ r, findings: checkReceipt(r) }));
  const approved = r2(claims.filter((c) => c.findings.every((f) => f.kind === "OK")).reduce((s, c) => s + c.r.total, 0));
  const rejected = claims.filter((c) => c.findings.some((f) => f.kind !== "OK"));
  const missing = review.filter((r) => r.findings.some((f) => f.kind === "MISSING_RECEIPT"));
  const blocked = review.filter((r) => r.findings.some((f) => f.kind === "BLOCKED_BY_CARD")).length;
  const net = r2(approved - owed);
  return {
    approvedOutOfPocket: approved,
    personalOrOverPolicy: owed,
    net,
    action: missing.length ? ("HOLD" as const) : net > 0 ? ("REIMBURSE" as const) : net < 0 ? ("DEDUCT" as const) : ("NOTHING_DUE" as const),
    missing: missing.map((m) => m.tx.id),
    rejected: rejected.map((c) => ({ receipt: c.r.id, why: c.findings.map((f) => f.note).join("; ") })),
    freezeCard: blocked >= POLICY.blockedAttemptsBeforeFreeze,
    blockedAttempts: blocked,
  };
}
