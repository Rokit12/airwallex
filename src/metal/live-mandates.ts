/**
 * Kit 11's spending limits on Metal testnet, through metal-agent's own commands
 * run in-process (no CLI start-up per payment).
 *
 * Funding follows Metal's advice: one key (the operator, .metal/operator.json) is
 * topped up from the faucet at most once per run, and every account the kit opens
 * is funded from it by a *USDZ transfer, never by its own faucet call.
 * Payments are mandate pulls the agent's mandate key signs; Metal's facilitator
 * submits them and pays their gas, so they can go out in parallel. A refusal the
 * kit wants on record is sent by the account owner's key instead.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createPublicClient, createWalletClient, custom, defineChain, encodeFunctionData, erc20Abi, http, parseAbiItem, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { METAL_NETWORKS, USDZ, accountFactoryFor } from "@metalntwx/metal-pay";
import { FEE_PER_GAS, readMandateState, reasonName, refusalOf, sendMandateCall } from "@metalntwx/metal-pay/mandates";
// metal-agent's command implementations (the CLI calls these same functions).
// @ts-expect-error untyped deep import
import { credentialCreate, mandateBind, mandateReplace, mandatePull, accountCreate, loadMandate } from "@metalntwx/metal-agent/dist/commands/mandate.js";
// @ts-expect-error untyped deep import
import { fund } from "@metalntwx/metal-agent/dist/commands/fund.js";
// @ts-expect-error untyped deep import
import { issuerKeyPath, publicKeyPath, mandateKeyPath } from "@metalntwx/metal-agent/dist/keystore.js";
import { MetalRefused, type Address, type ChainEvent, type Mandate, type MandateTerms, type Refusal } from "./emulator.ts";
import type { MandateChain, MandateStatus } from "./mandates.ts";
import { toBase } from "./units.ts";
import { METAL } from "./rail.ts";

const CENT = 10n ** 16n;
const floorCents = (base: bigint) => Number(base / CENT);
const dollars = (cents: number) => (cents / 100).toFixed(2);
const PAYMENT = parseAbiItem("event MandatePayment(bytes32 indexed ref, address indexed to, bytes20 l3aDigest, bytes agentKey, uint256 amount, uint256 spent, uint256 occurrences)");
const REFUSED = parseAbiItem("event MandateRefused(bytes32 indexed ref, address indexed to, bytes20 l3aDigest, bytes agentKey, uint256 amount, uint8 reason)");

interface Local extends Mandate { credential: string; ownerKey: string; predecessor?: string; /** The agent's mandate key, kept across replacements. */ keyFile: string }

/** Collects what a metal-agent command prints and reads its `field value` lines. */
function lines() {
  const out: string[] = [];
  const print = (l: string) => void out.push(String(l));
  const field = (k: string) => out.find((l) => l.startsWith(`${k} `))?.slice(k.length + 1).trim() ?? "";
  return { out, print, field };
}

export class LiveMandates implements MandateChain {
  readonly mode = "live" as const;
  readonly network = `metal-testnet (eip155:${METAL.chainId}) · live`;
  readonly concurrency = Number(process.env.METAL_CONCURRENCY ?? 10);
  private readonly target: any;
  private readonly client: any;
  private readonly factory: Address;
  private readonly dir: string;
  private readonly owners = new Map<Address, string>(); // account → owner key file
  private readonly mandates = new Map<string, Local>();
  /** tx hash → payment id, for the payments this run sent. */
  private readonly ids = new Map<string, string>();
  private funderQueue: Promise<unknown> = Promise.resolve();
  private toppedUp = false;
  /** Pulls sent again after a transient failure (same payment id, never a second payment). */
  retries = 0;

  constructor(rpcUrl: string) {
    const network = METAL_NETWORKS.testnet as any;
    this.target = {
      network,
      rpcUrl,
      facilitatorUrl: process.env.METAL_FACILITATOR_URL ?? network.facilitatorUrl,
      faucetUrl: process.env.METAL_FAUCET_URL ?? METAL.faucetUrl,
      explorerUrl: METAL.explorerUrl,
      demoPayeeUrl: "https://x402-demo-testnet.metalntwx.com/quote",
      nusd: USDZ.address,
    };
    const chain = defineChain({ id: network.chainId, name: "Metal testnet", nativeCurrency: { name: "Gas", symbol: "GAS", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
    this.client = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 4, timeout: 60_000 }) });
    this.factory = accountFactoryFor(network, undefined, "set METAL_ACCOUNT_FACTORY") as Address;
    this.dir = join(".metal", "kit11", `run-${Date.now().toString(36)}`);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // metal-agent keeps each pull's state under ~/.metal-agent; give it a writable home.
    try { mkdirSync(join(process.env.HOME || "/tmp", ".metal-agent"), { recursive: true }); } catch { process.env.HOME = "/tmp"; }
  }

  explorer(tx: string) { return `${METAL.explorerUrl}/tx/${tx}`; }

  newPayee(): Address {
    return privateKeyToAccount(generatePrivateKey()).address as Address;
  }

  async balanceOf(a: Address) {
    return floorCents((await this.client.readContract({ address: USDZ.address, abi: erc20Abi, functionName: "balanceOf", args: [a] })) as bigint);
  }

  private funderAccount() {
    const file = ".metal/operator.json";
    if (!existsSync(file)) {
      mkdirSync(".metal", { recursive: true, mode: 0o700 });
      const pk = generatePrivateKey();
      writeFileSync(file, JSON.stringify({ address: privateKeyToAccount(pk).address, privateKey: pk }), { mode: 0o600 });
    }
    return privateKeyToAccount(JSON.parse(readFileSync(file, "utf8")).privateKey);
  }

  /** A *USDZ transfer from the funder; transfers from it go one at a time (one nonce sequence). */
  private send(to: Address, base: bigint) {
    const run = async () => {
      const acct = this.funderAccount();
      const wallet = createWalletClient({ account: acct, chain: this.client.chain, transport: custom(this.client) });
      const call = { to: USDZ.address as Address, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, base] }), gas: 120_000n, maxFeePerGas: FEE_PER_GAS, maxPriorityFeePerGas: FEE_PER_GAS };
      const hash = (await sendMandateCall(this.client, wallet as any, call)) as Hex;
      const r = await this.client.waitForTransactionReceipt({ hash, pollingInterval: 250 });
      if (r.status !== "success") throw new Error(`transfer ${hash} reverted`);
      return hash;
    };
    const p = this.funderQueue.then(run, run);
    this.funderQueue = p.catch(() => {});
    return p;
  }

  /** Make sure the funder can cover `cents`: one faucet top-up at most per run. */
  async ensureFunds(cents: number) {
    const funder = this.funderAccount().address as Address;
    const have = await this.balanceOf(funder);
    if (have >= cents || this.toppedUp) {
      if (have < cents) throw new Error(`the funding key ${funder} holds USDZ ${dollars(have)}; this run needs ${dollars(cents)} and the faucet was already asked once`);
      return { funder, cents: have, faucet: false };
    }
    this.toppedUp = true;
    const l = lines();
    await fund(this.target, funder, undefined, l.print, fetch, false);
    const now = await this.balanceOf(funder);
    if (now < cents) throw new Error(`the funding key ${funder} holds USDZ ${dollars(now)} after the faucet; this run needs ${dollars(cents)}`);
    return { funder, cents: now, faucet: true, tx: l.field("transaction") };
  }

  async openAccount(label: string, cents: number): Promise<Address> {
    const ownerKey = join(this.dir, `${label}-owner.json`);
    const pk = generatePrivateKey();
    const owner = privateKeyToAccount(pk).address as Address;
    writeFileSync(ownerKey, JSON.stringify({ address: owner, privateKey: pk }), { mode: 0o600 });
    // Gas for the owner key (deploys the account, binds and replaces limits). Gas costs 1 base unit; a cent covers it many times.
    await this.send(owner, CENT);
    const l = lines();
    await accountCreate(this.target, { accountFactory: this.factory, keyPath: ownerKey }, l.print);
    const account = l.field("account") as Address;
    if (!account) throw new Error(`account create printed no account:\n${l.out.join("\n")}`);
    if (cents > 0) await this.send(account, toBase(cents));
    this.owners.set(account, ownerKey);
    return account;
  }

  private async credential(principal: Address, agent: string, t: MandateTerms, mandateKeyFile?: string) {
    const ownerKey = this.owners.get(principal);
    if (!ownerKey) throw new Error(`no owner key for ${principal}`);
    const out = join(this.dir, `${agent.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-${randomUUID().slice(0, 8)}.json`);
    const l = lines();
    await credentialCreate(this.target, {
      principal,
      payees: t.payees.map((address) => ({ address })),
      cap: dollars(t.capCents),
      budget: dollars(t.budgetCents),
      expiresIn: Math.max(3600, Math.floor((t.expiresAt - Date.now()) / 1000)),
      startsIn: undefined,
      maxOccurrences: undefined,
      description: t.description,
      out,
      mandateKeyFile,
      issuerKeyPath: issuerKeyPath(ownerKey),
    }, l.print);
    return { out, ownerKey, ref: l.field("mandate") };
  }

  async bind(principal: Address, agent: string, t: MandateTerms): Promise<Mandate> {
    const c = await this.credential(principal, agent, t);
    const l = lines();
    await mandateBind(this.target, { accountFactory: this.factory, signerPaths: [], credentialPath: c.out, issuerPaths: [publicKeyPath(issuerKeyPath(c.ownerKey))], keyPath: c.ownerKey }, l.print);
    const m: Local = { ...t, id: c.ref, principal, agent, spentCents: 0, payments: 0, revoked: false, credential: c.out, ownerKey: c.ownerKey, keyFile: mandateKeyPath(c.out) };
    this.mandates.set(m.id, m);
    return m;
  }

  async replace(oldId: string, t: MandateTerms): Promise<Mandate> {
    const old = this.mandate(oldId) as Local;
    // The guide: create the replacement with --mandate-key-file naming the agent's key, so the agent keeps its key.
    const c = await this.credential(old.principal, old.agent, t, old.keyFile);
    const l = lines();
    await mandateReplace(this.target, { credentialPath: c.out, replacesPath: old.credential, issuerPaths: [publicKeyPath(issuerKeyPath(c.ownerKey))], accountFactory: this.factory, signerPaths: [], keyPath: c.ownerKey }, l.print);
    const s = await this.status(oldId);
    old.revoked = true;
    old.replacedBy = c.ref;
    const m: Local = { ...t, id: c.ref, principal: old.principal, agent: old.agent, spentCents: s.spentCents, payments: s.payments, revoked: false, credential: c.out, ownerKey: c.ownerKey, predecessor: oldId, keyFile: old.keyFile };
    this.mandates.set(m.id, m);
    return m;
  }

  mandate(id: string): Mandate {
    const m = this.mandates.get(id);
    if (!m) throw new Error(`no mandate ${id}`);
    return m;
  }

  async status(id: string): Promise<MandateStatus> {
    const m = this.mandate(id);
    const s = await readMandateState(this.client, m.principal, id as Hex);
    const spent = floorCents(s.spent as bigint);
    return { agent: m.agent, spentCents: spent, budgetCents: m.budgetCents, remainingCents: m.budgetCents - spent, capCents: m.capCents, payments: Number(s.occurrences), revoked: Boolean(s.revoked) };
  }

  async pull(id: string, to: Address, cents: number, opts: { paymentId?: string; recordRefusal?: boolean } = {}): Promise<ChainEvent> {
    const m = this.mandate(id) as Local;
    const paymentId = opts.paymentId ?? randomUUID();
    for (let attempt = 1; ; attempt++) {
      const l = lines();
      let outcome: string;
      try {
        outcome = await mandatePull(this.target, { credentialPath: m.credential, mandateKeyFile: m.keyFile, to, amount: toBase(cents), paymentId, keyPath: opts.recordRefusal ? m.ownerKey : undefined, recordRefusal: Boolean(opts.recordRefusal) }, l.print);
      } catch (err) {
        // A pull that was not sent, or whose answer was lost, is sent again under the same payment id: Metal pays it at most once.
        if (attempt < 12 && /could not be reached|fetch failed|timed? ?out|ECONNRESET|429|503|sending it failed|the same pull sends it|send it again/i.test(String((err as Error).message))) {
          this.retries += 1;
          await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** Math.min(attempt, 4), 12_000) + Math.random() * 1500));
          continue;
        }
        throw err;
      }
      const tx = l.field("transaction");
      if (outcome === "pending") { await new Promise((r) => setTimeout(r, 1000)); continue; }
      if (outcome === "refused") {
        const words = l.field("reason").split(" ")[0] ?? "";
        const reason = (refusalOf(words) ?? words) as Refusal;
        throw new MetalRefused(reason, `${m.agent}: ${l.field("reason")}`, tx || undefined);
      }
      if (outcome !== "paid") throw new Error(`pull ${paymentId} ended ${outcome}:\n${l.out.join("\n")}`);
      if (tx) this.ids.set(tx.toLowerCase(), paymentId);
      return { tx, block: 0, at: new Date().toISOString(), mandate: id, kind: "payment", from: m.principal, to, cents, paymentId };
    }
  }

  /** Payments and refusals read from the account's MandatePayment / MandateRefused logs. */
  async verify(id: string): Promise<ChainEvent[]> {
    const chain: Local[] = [];
    for (let m: Local | undefined = this.mandate(id) as Local; m; m = m.predecessor ? (this.mandates.get(m.predecessor) as Local) : undefined) chain.unshift(m);
    const out: ChainEvent[] = [];
    for (const m of chain) {
      const s = await readMandateState(this.client, m.principal, m.id as Hex);
      const from = BigInt(s.boundBlock ?? 0n);
      const head = (await this.client.getBlockNumber()) as bigint;
      const step = 50_000n;
      for (let a = from; a <= head; a += step) {
        const b = a + step - 1n > head ? head : a + step - 1n;
        const [paid, refused] = await Promise.all([
          this.client.getLogs({ address: m.principal, event: PAYMENT, args: { ref: m.id as Hex }, fromBlock: a, toBlock: b }),
          this.client.getLogs({ address: m.principal, event: REFUSED, args: { ref: m.id as Hex }, fromBlock: a, toBlock: b }),
        ]);
        for (const e of paid as any[]) out.push({ tx: e.transactionHash, block: Number(e.blockNumber), at: "", mandate: m.id, kind: "payment", from: m.principal, to: e.args.to, cents: floorCents(e.args.amount), paymentId: this.ids.get(String(e.transactionHash).toLowerCase()) });
        for (const e of refused as any[]) out.push({ tx: e.transactionHash, block: Number(e.blockNumber), at: "", mandate: m.id, kind: "refusal", from: m.principal, to: e.args.to, cents: floorCents(e.args.amount), reason: reasonName(e.args.reason) as Refusal });
      }
    }
    return out.sort((x, y) => x.block - y.block);
  }
}

void loadMandate;
