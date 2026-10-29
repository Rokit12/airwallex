/**
 * Clearing for kit 12, live or emulated, behind one interface.
 *
 * Live: Metal clearing on testnet through @metalntwx/metal-pay. Providers are
 * x402 sellers offering the `bajillion` (clearing) scheme, each job is its own
 * clearing wallet with its own deposit, and every payment signs the job's running
 * total off chain. Epochs are a few seconds; a withdrawal can be claimed only once
 * its epoch is final, after the contract's challenge window (policy(): 300 s).
 *
 * Emulated: src/metal/emulator.ts's Clearing, which follows the same rules on a
 * compressed clock, with local x402 sellers (src/metal/x402.ts).
 *
 * Both keep their own ledger of deposits and payments (Metal's advice: budget from
 * your own ledger; clearingSpendable is an estimate). Amounts here are micros
 * (millionths of *USDZ, the clearing unit) or cents of *USDZ.
 */
import express from "express";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Server } from "node:http";
import { createPublicClient, defineChain, http, type Hex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
import {
  METAL_NETWORKS, registerMetalScheme, ClearingServerScheme, createMetalPaymentClient, createClearingClient,
  registerClearingClient, depositToClearing, withdrawFromClearing, ClearingRefusal as LiveRefusal, clearingAbi,
} from "@metalntwx/metal-pay";
import { openClearingWallet } from "@metalntwx/metal-pay/node";
import { Clearing, MetalChain, newAddress, type Address } from "./emulator.ts";
import { startSeller, payFetch, clearingPayment, PaymentRefused, Facilitator, type Seller } from "./x402.ts";
import { METAL } from "./rail.ts";
import { audit } from "../core/audit.ts";

export interface ProviderRoute {
  id: string;
  name: string;
  description: string;
  priceMicros: () => number;
  latencyMs: () => number;
  handle: (job: string | null) => unknown;
}
export interface Bought<T> { body: T; priceMicros: number; providerMs: number }

export interface ClearingPort {
  mode: "live" | "emulated";
  epoch: number;
  /** The operator's float, from this run's ledger. */
  floatCents(): number;
  startProviders(routes: ProviderRoute[]): Promise<void>;
  openJob(key: string): Promise<void>;
  deposit(key: string, cents: number): Promise<void>;
  /** Wait for (live) or force (emulated) the next epoch. */
  nextEpoch(): Promise<void>;
  spendable(key: string): number;
  pendingDeposits(key: string): number;
  spent(key: string): number;
  /** Buy one unit from a provider; throws PaymentRefused("insufficient_deposit") when the deposit is used up. */
  buy<T>(key: string, providerId: string, job: string): Promise<Bought<T>>;
  /** Queue the key's unspent deposit for withdrawal. */
  withdraw(key: string): Promise<{ queuedMicros: number; epoch: number }>;
  /** Claim queued withdrawals that are final; returns cents added to the float. */
  claim(key: string): Promise<number>;
  /** True while a queued withdrawal is waiting for its epoch to be final. */
  awaitingFinality(key: string): boolean;
  /** Where a pending withdrawal is (live): waiting for the balance to be final, or for the queued withdrawal to be. */
  withdrawalStage(key: string): string;
  /** What each provider earned this run, in micros, and how it is paid out. */
  providerEarnings(): { earnings: Record<string, number>; note: string };
  explorer(tx: string): string;
  close(): Promise<void>;
}

interface Ledger { deposits: { micros: number; at: number }[]; spent: number; withdrawn: number; queued: { micros: number; at: number; claimed: boolean }[]; stage?: string }
const newLedger = (): Ledger => ({ deposits: [], spent: 0, withdrawn: 0, queued: [] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Emulated ─────────────────────────────────────────────────────────────────
export function emulatedClearing(floatCents: number): ClearingPort {
  const chain = new MetalChain();
  const clearing = new Clearing(chain, newAddress());
  const facilitator = new Facilitator(chain, clearing);
  const operator = newAddress();
  chain.faucet(operator, floatCents);
  const sellers: Seller[] = [];
  const urls: Record<string, string> = {};
  const payTo: Record<string, Address> = {};
  const port: ClearingPort = {
    mode: "emulated",
    get epoch() { return clearing.epoch; },
    floatCents: () => chain.balanceOf(operator),
    async startProviders(routes) {
      for (const r of routes) {
        payTo[r.name] = newAddress();
        const s = await startSeller(r.name, {
          "/unit": { scheme: "clearing", price: r.priceMicros, payTo: payTo[r.name]!, description: r.description, latencyMs: r.latencyMs, handle: (_req, url) => r.handle(url.searchParams.get("job")) },
        }, facilitator);
        sellers.push(s);
        urls[r.id] = `${s.url}/unit`;
      }
    },
    async openJob() {},
    async deposit(key, cents) { clearing.deposit(operator, key, cents); },
    async nextEpoch() { clearing.closeEpoch(); },
    spendable: (key) => clearing.spendable(key),
    pendingDeposits: (key) => clearing.pendingDeposits(key),
    spent: (key) => clearing.position(key).total,
    async buy(key, providerId, job) {
      const res = await payFetch<any>(`${urls[providerId]}?job=${job}`, clearingPayment(key, () => clearing.position(key).total));
      return { body: res.body, priceMicros: res.price, providerMs: res.ms };
    },
    async withdraw(key) { const w = clearing.withdraw(key); return { queuedMicros: w.queued, epoch: w.epoch }; },
    async claim(key) { return clearing.claim(key, operator); },
    awaitingFinality: () => false,
    withdrawalStage: () => "",
    providerEarnings() {
      const paid = clearing.settleProviders(payTo);
      return { earnings: Object.fromEntries(Object.entries(paid).map(([k, v]) => [k, v * 10_000])), note: "paid by the operator at settlement" };
    },
    explorer: (tx) => `${METAL.explorerUrl}/tx/${tx} (emulated)`,
    async close() { await Promise.all(sellers.map((s) => s.close())); },
  };
  return port;
}

// ── Live ─────────────────────────────────────────────────────────────────────
const UNIT = 10n ** 12n; // one clearing unit (a micro) in *USDZ base units (18 decimals)
const run = promisify(execFile);

/**
 * withdrawFromClearing, retried when an epoch finalized under the call ("make the same call again
 * after the next epoch": nothing was lost but gas). Getting money out takes two finalities: the
 * balance must be final before it can be queued, and the queued withdrawal must be final before it
 * can be claimed, each after the contract's challenge window (policy(): 300 s).
 */
export async function withdrawRetrying(opts: Parameters<typeof withdrawFromClearing>[0]) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await withdrawFromClearing(opts);
    } catch (e) {
      if (attempt >= 6 || !/again after the next epoch/.test((e as Error).message)) throw e;
      await sleep(5000);
    }
  }
}

export async function liveClearingAvailable(): Promise<{ ok: boolean; why?: string; extra?: { settlement: Hex; asset: Hex; serviceUrl: string } }> {
  if (!process.env.METAL_RPC_URL) return { ok: false, why: "no METAL_RPC_URL set" };
  try {
    const sup = (await (await fetch(`${METAL_NETWORKS.testnet.facilitatorUrl}/supported`, { signal: AbortSignal.timeout(8000) })).json()) as any;
    const kind = sup.kinds?.find((k: any) => k.scheme === "bajillion");
    if (!kind) return { ok: false, why: "Metal's facilitator lists no clearing service" };
    const svc = await fetch(kind.extra.serviceUrl, { signal: AbortSignal.timeout(8000) }).catch((e) => e as Error);
    if (svc instanceof Error) return { ok: false, why: `the clearing service ${kind.extra.serviceUrl} is not reachable from this machine (allow *.metalntwx.com)` };
    return { ok: true, extra: kind.extra };
  } catch (e) {
    return { ok: false, why: `Metal's facilitator is not reachable (${(e as Error).message})` };
  }
}

export async function liveClearing(floatCents: number, extra: { settlement: Hex; asset: Hex; serviceUrl: string }): Promise<ClearingPort> {
  const net = METAL_NETWORKS.testnet;
  const rpcUrl = process.env.METAL_RPC_URL!;
  const chainId = METAL.chainId;
  const { settlement, asset, serviceUrl } = extra;
  const runDir = `.metal/clearing/run-${Date.now().toString(36)}`;
  mkdirSync(runDir, { recursive: true, mode: 0o700 });

  // The operator: a funded key that deposits for each job and pays gas. Topped up from the faucet.
  const opFile = ".metal/operator.json";
  if (!existsSync(opFile)) {
    const pk = generatePrivateKey();
    (await import("node:fs")).writeFileSync(opFile, JSON.stringify({ address: privateKeyToAccount(pk).address, privateKey: pk }), { mode: 0o600 });
  }
  const operator = privateKeyToAccount(JSON.parse(readFileSync(opFile, "utf8")).privateKey);
  try { await run("node_modules/.bin/metal-agent", ["fund", operator.address, "--network", "testnet"], { env: process.env, timeout: 120_000 }); } catch { /* faucet daily limit: use the existing balance */ }

  const chain = defineChain({ id: chainId, name: "metal-testnet", nativeCurrency: { name: "USDZ", symbol: "USDZ", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
  const reader = createPublicClient({ chain, transport: http(rpcUrl) });
  const admitted = async () => (await reader.readContract({ address: settlement, abi: clearingAbi as any, functionName: "admittedCount" })) as bigint;

  let float = floatCents;
  let epoch = 1;
  const ledgers: Record<string, Ledger> = {};
  const jobs: Record<string, { wallet: Awaited<ReturnType<typeof openClearingWallet>>; fetchWithPayment: (u: string) => Promise<Response> }> = {};
  const sellers: Record<string, { wallet: Awaited<ReturnType<typeof openClearingWallet>>; earned: number }> = {};
  const routesById: Record<string, ProviderRoute> = {};
  let httpServer: Server | undefined;
  let base = "";

  const port: ClearingPort = {
    mode: "live",
    get epoch() { return epoch; },
    floatCents: () => float,
    async startProviders(routes) {
      const facilitator = new HTTPFacilitatorClient({ url: process.env.METAL_FACILITATOR_URL ?? net.facilitatorUrl });
      const server = registerMetalScheme(new x402ResourceServer(facilitator));
      server.register(net.network as any, new ClearingServerScheme(net.network as any));
      const app = express();
      const table: Record<string, unknown> = {};
      for (const r of routes) {
        routesById[r.id] = r;
        const wallet = await openClearingWallet(`.metal/clearing/sellers/${r.id}`);
        sellers[r.id] = { wallet, earned: 0 };
        table[`GET /p/${r.id}`] = { accepts: [{ scheme: "bajillion", network: net.network, payTo: wallet.signer.publicKey, price: () => (r.priceMicros() / 1e6).toFixed(6) }], description: r.description };
      }
      app.use(paymentMiddleware(table as any, server));
      for (const r of routes) {
        app.get(`/p/${r.id}`, async (req, res) => {
          const t = Date.now();
          await sleep(r.latencyMs());
          res.setHeader("x-provider-ms", String(Date.now() - t));
          res.json(r.handle(String(req.query.job ?? "") || null));
        });
      }
      httpServer = await new Promise<Server>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
      base = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
    },
    async openJob(key) {
      const wallet = await openClearingWallet(`${runDir}/${key}`);
      const clearing = createClearingClient({ serviceUrl, rpcUrl, network: net.network as any, settlement, asset, signer: wallet.signer, store: wallet.store, maxAmount: 100_000n * UNIT });
      const mc = createMetalPaymentClient({ account: operator, network: "testnet" });
      registerClearingClient(mc.client, net.network as any, clearing);
      jobs[key] = { wallet, fetchWithPayment: mc.fetchWithPayment as any };
      ledgers[key] = newLedger();
      audit({ kind: "metal_clearing_job", key, clearingKey: wallet.signer.publicKey });
    },
    async deposit(key, cents) {
      const d = await depositToClearing({ rpcUrl, chainId, from: operator, settlement, asset, account: jobs[key]!.wallet.signer.publicKey, amount: BigInt(cents) * 10_000n * UNIT });
      ledgers[key]!.deposits.push({ micros: cents * 10_000, at: Date.now() });
      float -= cents;
      audit({ kind: "metal_clearing_deposit", key, cents, tx: d.depositTx });
    },
    async nextEpoch() {
      const start = await admitted();
      for (let i = 0; i < 30 && (await admitted()) === start; i++) await sleep(1000);
      epoch += 1;
    },
    spendable: (key) => { const l = ledgers[key]!; return l.deposits.reduce((s, d) => s + d.micros, 0) - l.spent - l.withdrawn; },
    pendingDeposits: () => 0, // a deposit lands between epochs; until it counts, payments are refused between_epochs and retried
    spent: (key) => ledgers[key]!.spent,
    async buy<T>(key: string, providerId: string, job: string) {
      const r = routesById[providerId]!;
      const price = r.priceMicros();
      if (port.spendable(key) < price) throw new PaymentRefused("insufficient_deposit", "the job's deposit cannot cover this unit");
      const url = `${base}/p/${providerId}?job=${encodeURIComponent(job)}`;
      for (let attempt = 0; attempt < 40; attempt++) {
        try {
          const res = await jobs[key]!.fetchWithPayment(url);
          if (!res.ok) throw new Error(`${r.name} answered ${res.status}`);
          ledgers[key]!.spent += price;
          sellers[providerId]!.earned += price;
          return { body: (await res.json()) as T, priceMicros: price, providerMs: Number(res.headers.get("x-provider-ms") ?? 0) };
        } catch (e) {
          const c = (e as { cause?: unknown }).cause;
          if (!(c instanceof LiveRefusal)) throw e;
          if (c.reason === "insufficient_deposit") throw new PaymentRefused("insufficient_deposit", c.message);
          // between_epochs: nothing paid, retry after the delay. answer_lost / payment_held: resend the same
          // request at the same price, which sends the same payment, so it is never paid twice.
          await sleep(Math.max(500, (c.retry as { ms?: number }).ms ?? 2000));
        }
      }
      throw new Error(`clearing payment to ${r.name} did not go through after 40 attempts`);
    },
    async withdraw(key) {
      const l = ledgers[key]!;
      const unspent = port.spendable(key);
      const w = await withdrawRetrying({ rpcUrl, chainId, from: operator, settlement, signer: jobs[key]!.wallet.signer, serviceUrl, destination: operator.address });
      if (unspent > 0) { l.queued.push({ micros: unspent, at: Date.now(), claimed: false }); l.withdrawn += unspent; }
      l.stage = w.status === "sent" && w.queued ? "queued; waiting for that epoch to be final" : "waiting for the balance to be final before it can be queued";
      audit({ kind: "metal_clearing_withdraw", key, status: w.status, micros: unspent });
      return { queuedMicros: unspent, epoch };
    },
    async claim(key) {
      const l = ledgers[key]!;
      if (!l.queued.some((q) => !q.claimed)) return 0;
      const w = await withdrawRetrying({ rpcUrl, chainId, from: operator, settlement, signer: jobs[key]!.wallet.signer, serviceUrl, destination: operator.address });
      if (w.status === "sent" && w.queued && !w.claimed.length) { l.stage = "queued; waiting for that epoch to be final"; audit({ kind: "metal_clearing_queued", key, tx: w.queued.tx }); }
      if (w.status !== "sent" || !w.claimed.length) return 0;
      const micros = w.claimed.reduce((s, c) => s + Number(c.amount / UNIT), 0);
      for (const q of l.queued) q.claimed = true;
      const cents = Math.floor(micros / 10_000);
      float += cents;
      audit({ kind: "metal_clearing_claim", key, micros, txs: w.claimed.map((c) => c.tx) });
      return cents;
    },
    awaitingFinality: (key) => Boolean(ledgers[key]?.queued.some((q) => !q.claimed)),
    withdrawalStage: (key) => ledgers[key]?.stage ?? "",
    providerEarnings: () => ({
      earnings: Object.fromEntries(Object.entries(sellers).map(([id, s]) => [routesById[id]!.name, s.earned])),
      note: "held in each provider's clearing account; withdrawable once their epochs are final",
    }),
    explorer: (tx) => `${METAL.explorerUrl}/tx/${tx}`,
    async close() {
      httpServer?.close();
      await Promise.all([...Object.values(jobs).map((j) => j.wallet.close()), ...Object.values(sellers).map((s) => s.wallet.close())]);
    },
  };
  return port;
}
