/**
 * Spending limits (mandates) as kit 11 uses them, behind one async interface:
 * the Metal emulator, or Metal testnet through metal-agent (src/metal/live-mandates.ts).
 * The kit's decisions never know which one they run on.
 */
import { MetalChain, newAddress, type Address, type ChainEvent, type Mandate, type MandateTerms } from "./emulator.ts";

export interface MandateStatus {
  agent: string;
  spentCents: number;
  budgetCents: number;
  remainingCents: number;
  capCents: number;
  payments: number;
  revoked: boolean;
}

export interface MandateChain {
  readonly mode: "live" | "emulated";
  readonly network: string;
  /** A fresh Metal account holding `cents` *USDZ (live: deployed, funded from one faucet-funded key). */
  openAccount(label: string, cents: number): Promise<Address>;
  /** An address that only receives (a payee). */
  newPayee(): Address;
  balanceOf(a: Address): Promise<number>;
  bind(principal: Address, agent: string, terms: MandateTerms): Promise<Mandate>;
  replace(oldId: string, terms: MandateTerms): Promise<Mandate>;
  mandate(id: string): Mandate;
  status(id: string): Promise<MandateStatus>;
  /** Pay under a mandate; throws MetalRefused. A paymentId pays at most once. */
  pull(id: string, to: Address, cents: number, opts?: { paymentId?: string; recordRefusal?: boolean }): Promise<ChainEvent>;
  /** Payments and refusals under a mandate (and those it replaced), read back from the chain. */
  verify(id: string): Promise<ChainEvent[]>;
  explorer(tx: string): string;
  /** How many payments to send at once. */
  readonly concurrency: number;
}

/** The emulator behind the async interface. */
export class EmulatedMandates implements MandateChain {
  readonly mode = "emulated" as const;
  readonly concurrency = 1;
  constructor(readonly chain = new MetalChain()) {}
  get network() { return `${this.chain.network} · emulated`; }
  async openAccount(_label: string, cents: number) {
    const a = newAddress();
    this.chain.faucet(a, cents);
    return a;
  }
  newPayee() { return newAddress(); }
  async balanceOf(a: Address) { return this.chain.balanceOf(a); }
  async bind(p: Address, agent: string, t: MandateTerms) { return this.chain.bind(p, agent, t); }
  async replace(id: string, t: MandateTerms) { return this.chain.replace(id, t); }
  mandate(id: string) { return this.chain.mandate(id); }
  async status(id: string) { return this.chain.status(id); }
  async pull(id: string, to: Address, cents: number, opts: { paymentId?: string; recordRefusal?: boolean } = {}) { return this.chain.pull(id, to, cents, opts); }
  async verify(id: string) { return this.chain.verify(id); }
  explorer(tx: string) { return `${tx} (emulated)`; }
}

/** Run `fn` over `items`, at most `n` at a time, in order of start. */
export async function inBatches<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return out;
}
