/**
 * Kit 13 · Cash Placement & Reconciliation: the decisions, as pure functions.
 *
 *  - matchDeposits(): applies each bank-statement deposit to open invoices:
 *    exact, one payment for several invoices, short within a fee tolerance,
 *    a duplicate of an invoice already paid, or unidentified.
 *  - tieOut(): every cent on the statement must be explained.
 *  - placementPlan(): where today's identified cash goes. Keep a USD buffer for
 *    USD obligations, then pre-fund foreign-currency bills earliest first, whole
 *    bills only. Duplicates (owed back) and unidentified money are never placed.
 *  - refundAllowed(): money goes back only to the payer's account on file.
 */

export interface Invoice { id: string; customer: string; amount: number; currency: "USD"; due: string }
export interface Deposit { id: string; payer: string; amount: number; currency: string; reference: string; at?: string }
export interface Customer { name: string; aliases: string[] }

export type MatchKind = "MATCHED" | "MATCHED_COMBINED" | "MATCHED_SHORT" | "DUPLICATE" | "UNAPPLIED" | "UNIDENTIFIED";
export interface Match { depositId: string; payer: string; amount: number; kind: MatchKind; customer?: string; invoiceIds: string[]; writeOff: number; reason: string }

export const POLICY = {
  /** A short payment is written off (bank fee) only up to the smaller of these. */
  shortTolerance: { max: 25, pct: 0.005 },
  /** USD kept back for USD obligations due within the horizon, plus this margin. */
  usdBufferMargin: 0.1,
  horizonDays: 14,
  /** FX the agent may book alone (USD sold per conversion); above this a person approves. */
  autonomousFxUsd: 2_500,
  /** Refunds always need a person. */
  refundNeedsApproval: true,
};

const r2 = (n: number) => Math.round(n * 100) / 100;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\b(co|inc|llc|ltd|as|gmbh|corp|company)\b/g, " ").replace(/\s+/g, " ").trim();

export function customerFor(payer: string, customers: Customer[]): string | undefined {
  const p = norm(payer);
  return customers.find((c) => [c.name, ...c.aliases].some((n) => norm(n) && (p === norm(n) || p.startsWith(norm(n) + " "))))?.name;
}

/** Invoice numbers a remittance reference points at: "INV-1001", "INV 1004", "1002/1003". */
export function referencedInvoices(reference: string, invoices: Invoice[]): string[] {
  const nums = new Set((reference.match(/\d{4}/g) ?? []));
  return invoices.filter((i) => nums.has(i.id.replace(/\D/g, "").slice(-4))).map((i) => i.id);
}

export const tolerance = (invoiceAmount: number) => Math.min(POLICY.shortTolerance.max, r2(invoiceAmount * POLICY.shortTolerance.pct));

/** Subsets of up to three invoices whose total equals the amount (to the cent). */
function subsetsSumming(cands: Invoice[], amount: number): Invoice[][] {
  const out: Invoice[][] = [];
  const n = cands.length;
  for (let a = 0; a < n; a++) {
    if (r2(cands[a]!.amount) === r2(amount)) out.push([cands[a]!]);
    for (let b = a + 1; b < n; b++) {
      if (r2(cands[a]!.amount + cands[b]!.amount) === r2(amount)) out.push([cands[a]!, cands[b]!]);
      for (let c = b + 1; c < n; c++) if (r2(cands[a]!.amount + cands[b]!.amount + cands[c]!.amount) === r2(amount)) out.push([cands[a]!, cands[b]!, cands[c]!]);
    }
  }
  return out;
}

/**
 * Applies deposits in statement order. An invoice is paid at most once; a
 * deposit whose reference names only invoices already paid, for the same
 * amount, is a duplicate (owed back, never income). Ambiguity is never
 * guessed: two possible invoice sets, or no customer, goes to a person.
 */
export function matchDeposits(invoices: Invoice[], deposits: Deposit[], customers: Customer[]) {
  const paid = new Map<string, string>(); // invoice id → deposit id
  const matches: Match[] = [];
  for (const d of deposits) {
    const base = { depositId: d.id, payer: d.payer, amount: d.amount, writeOff: 0 };
    const customer = customerFor(d.payer, customers);
    if (!customer || d.currency !== "USD") {
      matches.push({ ...base, kind: "UNIDENTIFIED", invoiceIds: [], reason: customer ? `paid in ${d.currency}; invoices are USD` : `"${d.payer}" is not a known customer and the reference "${d.reference}" names no open invoice` });
      continue;
    }
    const mine = invoices.filter((i) => i.customer === customer);
    const refs = referencedInvoices(d.reference, mine);
    const open = (ids: string[]) => mine.filter((i) => ids.includes(i.id) && !paid.has(i.id));
    const already = refs.filter((id) => paid.has(id));
    if (refs.length && already.length === refs.length && r2(mine.filter((i) => refs.includes(i.id)).reduce((s, i) => s + i.amount, 0)) === r2(d.amount)) {
      matches.push({ ...base, kind: "DUPLICATE", customer, invoiceIds: refs, reason: `${refs.join(" + ")} already paid by an earlier deposit for the same amount` });
      continue;
    }
    const named = open(refs);
    const pool = named.length ? named : mine.filter((i) => !paid.has(i.id));
    const sets = subsetsSumming(pool, d.amount);
    if (sets.length === 1) {
      const set = sets[0]!;
      for (const i of set) paid.set(i.id, d.id);
      matches.push({ ...base, kind: set.length > 1 ? "MATCHED_COMBINED" : "MATCHED", customer, invoiceIds: set.map((i) => i.id), reason: set.length > 1 ? `one payment for ${set.map((i) => i.id).join(" + ")}` : `exact amount${named.length ? " and reference" : ""}` });
      continue;
    }
    if (sets.length > 1) {
      matches.push({ ...base, kind: "UNAPPLIED", customer, invoiceIds: [], reason: `${sets.length} different invoice sets add up to this amount; a person picks` });
      continue;
    }
    const target = named.length === 1 ? named[0] : pool.length === 1 ? pool[0] : undefined;
    const short = target ? r2(target.amount - d.amount) : 0;
    if (target && short > 0 && short <= tolerance(target.amount)) {
      paid.set(target.id, d.id);
      matches.push({ ...base, kind: "MATCHED_SHORT", customer, invoiceIds: [target.id], writeOff: short, reason: `short by ${short.toFixed(2)}, within the ${tolerance(target.amount).toFixed(2)} fee tolerance` });
      continue;
    }
    matches.push({ ...base, kind: "UNAPPLIED", customer, invoiceIds: [], reason: target ? `short by ${short.toFixed(2)}, above the fee tolerance` : "amount matches no open invoice" });
  }
  const openInvoices = invoices.filter((i) => !paid.has(i.id));
  return { matches, openInvoices, paid };
}

/** Statement total = identified cash + money owed back + money held. Must be zero difference. */
export function tieOut(deposits: Deposit[], matches: Match[]) {
  const statement = r2(deposits.reduce((s, d) => s + d.amount, 0));
  const sum = (k: MatchKind[]) => r2(matches.filter((m) => k.includes(m.kind)).reduce((s, m) => s + m.amount, 0));
  const identified = sum(["MATCHED", "MATCHED_COMBINED", "MATCHED_SHORT"]);
  const owedBack = sum(["DUPLICATE"]);
  const held = sum(["UNIDENTIFIED", "UNAPPLIED"]);
  return { statement, identified, owedBack, held, difference: r2(statement - identified - owedBack - held) };
}

export interface Obligation { id: string; payee: string; currency: string; amount: number; dueInDays: number }
export interface PlacementLine { obligation: string; currency: string; amount: number; dueInDays: number; action: "FUND" | "DEFER" | "KEEP_USD"; sellUsd: number; needsApproval: boolean; reason: string }

/**
 * Today's identified cash only. Keep USD for USD obligations within the horizon
 * (plus margin), then fund foreign-currency bills earliest first, whole bills
 * only; what doesn't fit is deferred, never part-funded.
 * `usdPer` gives USD per unit of each currency (from live rates).
 */
export function placementPlan(identifiedCash: number, obligations: Obligation[], usdPer: Record<string, number>) {
  const soon = obligations.filter((o) => o.dueInDays <= POLICY.horizonDays);
  const usdNeeds = soon.filter((o) => o.currency === "USD").reduce((s, o) => s + o.amount, 0);
  const buffer = r2(usdNeeds * (1 + POLICY.usdBufferMargin));
  let free = r2(identifiedCash - buffer);
  const lines: PlacementLine[] = soon
    .filter((o) => o.currency === "USD")
    .map((o) => ({ obligation: o.id, currency: o.currency, amount: o.amount, dueInDays: o.dueInDays, action: "KEEP_USD" as const, sellUsd: 0, needsApproval: false, reason: `USD bill due in ${o.dueInDays} days: kept in USD (buffer ${buffer.toFixed(2)})` }));
  for (const o of soon.filter((x) => x.currency !== "USD").sort((a, b) => a.dueInDays - b.dueInDays)) {
    const rate = usdPer[o.currency];
    if (!rate) {
      lines.push({ obligation: o.id, currency: o.currency, amount: o.amount, dueInDays: o.dueInDays, action: "DEFER", sellUsd: 0, needsApproval: false, reason: `no ${o.currency} rate` });
      continue;
    }
    const sellUsd = r2(o.amount * rate);
    if (sellUsd <= free) {
      free = r2(free - sellUsd);
      lines.push({ obligation: o.id, currency: o.currency, amount: o.amount, dueInDays: o.dueInDays, action: "FUND", sellUsd, needsApproval: sellUsd > POLICY.autonomousFxUsd, reason: `pre-fund now: about USD ${sellUsd.toFixed(2)}${sellUsd > POLICY.autonomousFxUsd ? `, above the USD ${POLICY.autonomousFxUsd} autonomous FX limit` : ""}` });
    } else {
      lines.push({ obligation: o.id, currency: o.currency, amount: o.amount, dueInDays: o.dueInDays, action: "DEFER", sellUsd, needsApproval: false, reason: `needs about USD ${sellUsd.toFixed(2)}, only USD ${Math.max(0, free).toFixed(2)} of identified cash is free after the USD buffer` });
    }
  }
  return { buffer, lines, unplaced: r2(Math.max(0, free)) };
}

/** Money goes back only to the account the customer master holds, never to one named in an email. */
export function refundAllowed(refund: { customer: string; amount: number; toAccount: string }, onFile: { customer: string; account: string } | undefined, owedBack: number): boolean {
  return !!onFile && onFile.customer === refund.customer && onFile.account === refund.toAccount && refund.amount > 0 && r2(refund.amount) <= r2(owedBack);
}
