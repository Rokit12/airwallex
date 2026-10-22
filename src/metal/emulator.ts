/**
 * Metal testnet emulator, built from Metal's agent guides (docs.metalntwx.com/agents)
 * and the @metalntwx/metal-pay / metal-agent READMEs. It is used only until the
 * workspace can reach Metal testnet with an RPC endpoint of its own; every run on
 * it is labelled "Metal emulator".
 *
 * What it reproduces:
 *  - Accounts holding *USDZ; keys funded by a faucet grant; gas paid in *USDZ.
 *  - Mandates (spending limits) an owner gives an agent: payees (or any address),
 *    the most per payment, a lifetime budget, an expiry. Metal enforces each
 *    mandate on its own, never the sum of several.
 *  - Refusals name the limit hit (Metal's REASONS: PayeeNotAllowed,
 *    OverPerPaymentCap, OverBudget, Expired, Revoked) and move nothing; a refusal
 *    can be recorded on chain. `replace` carries the old mandate's spend.
 *  - A chain log of payments and refusals per mandate, which `verify` reads back.
 *  - Clearing: one deposit per payer key, each payment signs the key's running
 *    total across all providers, deposits count from the next epoch, positions
 *    are one total per key, withdrawals wait for their epoch to finalize.
 */
import { createHash, randomBytes } from "node:crypto";

export type Address = `0x${string}`;
export type Refusal = "PayeeNotAllowed" | "OverPerPaymentCap" | "OverBudget" | "Expired" | "Revoked" | "InsufficientBalance";

export interface MandateTerms {
  /** Allowed payees; empty means any address. */
  payees: Address[];
  /** Most per payment, cents. */
  capCents: number;
  /** Lifetime budget, cents (never resets). */
  budgetCents: number;
  expiresAt: number;
  description: string;
}

export interface Mandate extends MandateTerms {
  id: string;
  principal: Address;
  agent: string;
  spentCents: number;
  payments: number;
  revoked: boolean;
  replacedBy?: string;
}

export interface ChainEvent {
  tx: string;
  block: number;
  at: string;
  mandate?: string;
  kind: "payment" | "refusal" | "transfer" | "bind" | "replace" | "faucet";
  from?: Address;
  to?: Address;
  cents?: number;
  reason?: Refusal;
  paymentId?: string;
}

export class MetalRefused extends Error {
  constructor(readonly reason: Refusal, readonly detail: string, readonly tx?: string) {
    super(`payment refused: ${reason} (${detail}) — nothing was paid`);
  }
}

const hash = (s: string) => ("0x" + createHash("sha256").update(s).digest("hex")) as `0x${string}`;
export const newAddress = () => ("0x" + randomBytes(20).toString("hex")) as Address;

export class MetalChain {
  readonly network = "metal-testnet (eip155:63825)";
  private balances = new Map<Address, number>();
  private mandates = new Map<string, Mandate>();
  private paid = new Map<string, ChainEvent>(); // paymentId → settled payment (pays at most once)
  readonly log: ChainEvent[] = [];
  private block = 1_000_000;

  balanceOf(a: Address) {
    return this.balances.get(a) ?? 0;
  }

  private record(e: Omit<ChainEvent, "tx" | "block" | "at">): ChainEvent {
    this.block += 1;
    const ev: ChainEvent = { ...e, block: this.block, at: new Date().toISOString(), tx: hash(`${this.block}:${JSON.stringify(e)}:${Math.random()}`) };
    this.log.push(ev);
    return ev;
  }

  /** Testnet faucet grant. */
  faucet(to: Address, cents: number) {
    this.balances.set(to, this.balanceOf(to) + cents);
    return this.record({ kind: "faucet", to, cents });
  }

  /** Owner-signed transfer (the owner key can move funds outside any mandate). */
  transfer(from: Address, to: Address, cents: number) {
    if (this.balanceOf(from) < cents) throw new MetalRefused("InsufficientBalance", `${from} holds ${this.balanceOf(from)}c`);
    this.balances.set(from, this.balanceOf(from) - cents);
    this.balances.set(to, this.balanceOf(to) + cents);
    return this.record({ kind: "transfer", from, to, cents });
  }

  bind(principal: Address, agent: string, terms: MandateTerms): Mandate {
    const id = hash(`${principal}:${agent}:${JSON.stringify(terms)}:${Date.now()}:${Math.random()}`).slice(0, 34);
    const m: Mandate = { ...terms, id, principal, agent, spentCents: 0, payments: 0, revoked: false };
    this.mandates.set(id, m);
    this.record({ kind: "bind", mandate: id, from: principal });
    return m;
  }

  /** Revoke `old` and bind `next`, carrying the old spend (metal-agent mandate replace). */
  replace(oldId: string, terms: MandateTerms): Mandate {
    const old = this.mandate(oldId);
    const m = this.bind(old.principal, old.agent, terms);
    m.spentCents = old.spentCents;
    m.payments = old.payments;
    old.revoked = true;
    old.replacedBy = m.id;
    this.record({ kind: "replace", mandate: m.id, from: old.principal });
    return m;
  }

  mandate(id: string): Mandate {
    const m = this.mandates.get(id);
    if (!m) throw new Error(`no mandate ${id}`);
    return m;
  }

  /** The check Metal runs before a pull; names the limit behind a refusal (readCheck). */
  check(id: string, to: Address, cents: number): Refusal | null {
    const m = this.mandate(id);
    if (m.revoked) return "Revoked";
    if (Date.now() > m.expiresAt) return "Expired";
    if (m.payees.length && !m.payees.includes(to)) return "PayeeNotAllowed";
    if (cents > m.capCents) return "OverPerPaymentCap";
    if (m.spentCents + cents > m.budgetCents) return "OverBudget";
    if (this.balanceOf(m.principal) < cents) return "InsufficientBalance";
    return null;
  }

  /**
   * Pay under a mandate. A refusal moves nothing; with recordRefusal it is still
   * written to the chain (a transaction that succeeds and moves nothing).
   * A paymentId pays at most once.
   */
  pull(id: string, to: Address, cents: number, opts: { paymentId?: string; recordRefusal?: boolean } = {}): ChainEvent {
    if (opts.paymentId && this.paid.has(opts.paymentId)) return this.paid.get(opts.paymentId)!;
    const reason = this.check(id, to, cents);
    const m = this.mandate(id);
    if (reason) {
      const ev = opts.recordRefusal ? this.record({ kind: "refusal", mandate: id, from: m.principal, to, cents, reason, paymentId: opts.paymentId }) : undefined;
      throw new MetalRefused(reason, `${m.agent}: ${describe(reason, m, cents)}`, ev?.tx);
    }
    this.balances.set(m.principal, this.balanceOf(m.principal) - cents);
    this.balances.set(to, this.balanceOf(to) + cents);
    m.spentCents += cents;
    m.payments += 1;
    const ev = this.record({ kind: "payment", mandate: id, from: m.principal, to, cents, paymentId: opts.paymentId });
    if (opts.paymentId) this.paid.set(opts.paymentId, ev);
    return ev;
  }

  status(id: string) {
    const m = this.mandate(id);
    return { agent: m.agent, spentCents: m.spentCents, budgetCents: m.budgetCents, remainingCents: m.budgetCents - m.spentCents, capCents: m.capCents, payments: m.payments, revoked: m.revoked };
  }

  /** Every payment and refusal under a mandate (and the ones it replaced), read from the chain log. */
  verify(id: string): ChainEvent[] {
    const ids = new Set<string>([id]);
    for (const m of this.mandates.values()) if (m.replacedBy && ids.has(m.replacedBy)) ids.add(m.id);
    for (const m of this.mandates.values()) if (m.replacedBy && ids.has(m.replacedBy)) ids.add(m.id);
    return this.log.filter((e) => e.mandate && ids.has(e.mandate) && (e.kind === "payment" || e.kind === "refusal"));
  }

  settlementByTx(tx: string) {
    return this.log.find((e) => e.tx === tx);
  }
}

function describe(r: Refusal, m: Mandate, cents: number) {
  switch (r) {
    case "OverPerPaymentCap": return `payment ${cents}c is over the per-payment cap of ${m.capCents}c`;
    case "OverBudget": return `budget ${m.budgetCents}c has ${m.budgetCents - m.spentCents}c left, payment is ${cents}c`;
    case "PayeeNotAllowed": return "payee is not on the mandate's list";
    case "Expired": return "mandate expired";
    case "Revoked": return "mandate was revoked or replaced";
    case "InsufficientBalance": return "the owner's account cannot cover it";
  }
}

// ── Clearing (amounts in micros: a millionth of *USDZ) ──────────────────────

export type ClearingRefusalReason = "insufficient_deposit" | "between_epochs";
export class ClearingRefusal extends Error {
  constructor(readonly reason: ClearingRefusalReason, readonly retry: { ms?: number; depositMicros?: number }) {
    super(`clearing refused: ${reason}`);
  }
}

interface ClearingKey {
  deposits: { micros: number; fromEpoch: number }[];
  total: number;
  receipts: { provider: string; micros: number; cumulative: number; epoch: number }[];
  withdrawals: { micros: number; epoch: number; claimed: boolean }[];
}

/**
 * One Clearing deployment. Epochs advance with closeEpoch() (the operator nets
 * payments and settles each epoch on chain). A deposit counts from the epoch
 * after it lands; a withdrawal is claimable once its epoch has closed.
 */
export class Clearing {
  epoch = 1;
  private keys = new Map<string, ClearingKey>();
  private settled = new Map<string, number>();
  constructor(private readonly chain: MetalChain, readonly vault: Address) {}

  private key(k: string) {
    let v = this.keys.get(k);
    if (!v) this.keys.set(k, (v = { deposits: [], total: 0, receipts: [], withdrawals: [] }));
    return v;
  }

  /** depositToClearing: moves whole cents on chain into the deployment for one payer key. */
  deposit(from: Address, keyId: string, cents: number) {
    const ev = this.chain.transfer(from, this.vault, cents);
    this.key(keyId).deposits.push({ micros: cents * 10_000, fromEpoch: this.epoch + 1 });
    return ev;
  }

  private landed(keyId: string, countingOnly: boolean) {
    return this.key(keyId).deposits.filter((d) => !countingOnly || d.fromEpoch <= this.epoch).reduce((s, d) => s + d.micros, 0);
  }

  /** clearingSpendable: what a key can still spend; a deposit counts from the epoch after it lands. */
  spendable(keyId: string) {
    const k = this.key(keyId);
    return this.landed(keyId, true) - k.total - k.withdrawals.reduce((s, w) => s + w.micros, 0);
  }

  pendingDeposits(keyId: string) {
    return this.landed(keyId, false) - this.landed(keyId, true);
  }

  /** The facilitator's POST /clearing/position: one running total per key. */
  position(keyId: string) {
    const k = this.key(keyId);
    return { total: k.total, receipts: [...k.receipts] };
  }

  /** A payer signs its new running total; the provider takes `price` of it. */
  pay(keyId: string, provider: string, price: number) {
    const k = this.key(keyId);
    if (this.spendable(keyId) < price) {
      if (this.spendable(keyId) + this.pendingDeposits(keyId) >= price) throw new ClearingRefusal("between_epochs", { ms: 0 });
      throw new ClearingRefusal("insufficient_deposit", { depositMicros: price - this.spendable(keyId) });
    }
    k.total += price;
    const receipt = { provider, micros: price, cumulative: k.total, epoch: this.epoch };
    k.receipts.push(receipt);
    return receipt;
  }

  closeEpoch() {
    this.epoch += 1;
  }

  /** withdrawFromClearing, step 1: queue everything unspent (claimable after this epoch closes). */
  withdraw(keyId: string) {
    const micros = this.spendable(keyId) + this.pendingDeposits(keyId);
    if (micros <= 0) return { queued: 0, epoch: this.epoch };
    this.key(keyId).withdrawals.push({ micros, epoch: this.epoch, claimed: false });
    return { queued: micros, epoch: this.epoch };
  }

  /** withdrawFromClearing, step 2: claim finalized withdrawals (whole cents; dust stays). */
  claim(keyId: string, to: Address) {
    let cents = 0;
    for (const w of this.key(keyId).withdrawals) {
      if (!w.claimed && w.epoch < this.epoch) {
        const c = Math.floor(w.micros / 10_000);
        if (c > 0) this.chain.transfer(this.vault, to, c);
        w.claimed = true;
        cents += c;
      }
    }
    return cents;
  }

  /** The operator nets each provider's receipts and pays them out (whole cents). */
  settleProviders(payTo: Record<string, Address>) {
    const owed = new Map<string, number>();
    for (const k of this.keys.values()) for (const r of k.receipts) owed.set(r.provider, (owed.get(r.provider) ?? 0) + r.micros);
    const out: Record<string, number> = {};
    for (const [p, micros] of owed) {
      const cents = Math.floor(micros / 10_000) - (this.settled.get(p) ?? 0);
      if (cents > 0 && payTo[p]) {
        this.chain.transfer(this.vault, payTo[p]!, cents);
        this.settled.set(p, (this.settled.get(p) ?? 0) + cents);
        out[p] = cents;
      }
    }
    return out;
  }
}
