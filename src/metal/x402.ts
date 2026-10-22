/**
 * Minimal x402 over local HTTP for kits 11 and 12.
 *
 * A seller answers an unpaid request with HTTP 402 and an offer (scheme, network,
 * *USDZ amount in base units, payTo). The buyer reads the offer on EVERY request
 * (prices change; a cached price overspends), signs a payment, and repeats the
 * request with it. The seller hands the payment to a facilitator, which verifies
 * and settles it before the handler runs.
 *
 * Header names follow x402 v2: PAYMENT-REQUIRED (offer), PAYMENT-SIGNATURE
 * (payment), PAYMENT-RESPONSE (settlement). Bodies are JSON.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { toBase, fromBase, microsToBase, baseToMicros } from "./units.ts";
import { MetalChain, MetalRefused, Clearing, ClearingRefusal, type Address } from "./emulator.ts";

export const METAL_TESTNET = "eip155:63825";

export interface Offer {
  scheme: "exact" | "clearing";
  network: string;
  asset: "*USDZ";
  amount: string; // base units
  payTo: Address;
  resource: string;
  description?: string;
}

export type Payment =
  | { scheme: "exact"; mandate: string; paymentId: string; amount: string; payTo: Address }
  | { scheme: "clearing"; key: string; cumulative: string; amount: string; payTo: Address };

export interface Route {
  scheme: "exact" | "clearing";
  /** Current price, read on every request: cents for "exact", micros for "clearing". */
  price: () => number;
  payTo: Address;
  description: string;
  latencyMs?: () => number;
  handle: (req: IncomingMessage, url: URL) => unknown | Promise<unknown>;
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = <T>(s: string): T => JSON.parse(Buffer.from(s, "base64").toString("utf8"));

/** Metal's facilitator role: verify and settle a payment against the chain or the Clearing deployment. */
export class Facilitator {
  constructor(private readonly chain: MetalChain, private readonly clearing?: Clearing) {}
  settle(p: Payment, offer: Offer, provider: string): { tx: string; detail: string } {
    if (p.payTo !== offer.payTo || p.amount !== offer.amount) throw new Error("payment does not match the offer");
    if (p.scheme === "exact") {
      const ev = this.chain.pull(p.mandate, p.payTo, fromBase(BigInt(p.amount)), { paymentId: p.paymentId, recordRefusal: true });
      return { tx: ev.tx, detail: `settled on chain in block ${ev.block}` };
    }
    if (!this.clearing) throw new Error("this facilitator does not take clearing");
    const expected = this.clearing.position(p.key).total + baseToMicros(BigInt(p.amount));
    if (baseToMicros(BigInt(p.cumulative)) !== expected) throw new Error(`stale running total: signed ${baseToMicros(BigInt(p.cumulative))}, position says ${expected}`);
    const r = this.clearing.pay(p.key, provider, baseToMicros(BigInt(p.amount)));
    return { tx: `clearing:${p.key.slice(0, 10)}:${r.cumulative}`, detail: `preconfirmed in epoch ${r.epoch}, running total ${r.cumulative} micros` };
  }
}

export interface Seller {
  url: string;
  name: string;
  calls: number;
  server: Server;
  close(): Promise<void>;
}

export async function startSeller(name: string, routes: Record<string, Route>, facilitator: Facilitator): Promise<Seller> {
  const seller: Seller = { url: "", name, calls: 0, server: undefined as any, close: async () => {} };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = routes[url.pathname];
    if (!route) return res.writeHead(404).end();
    const offer: Offer = { scheme: route.scheme, network: METAL_TESTNET, asset: "*USDZ", amount: (route.scheme === "clearing" ? microsToBase(route.price()) : toBase(route.price())).toString(), payTo: route.payTo, resource: `${seller.url}${url.pathname}`, description: route.description };
    const header = req.headers["payment-signature"];
    if (!header) {
      res.writeHead(402, { "content-type": "application/json", "payment-required": b64({ x402Version: 2, accepts: [offer] }) });
      return res.end(JSON.stringify({ x402Version: 2, error: "payment required", accepts: [offer] }));
    }
    let settlement;
    try {
      settlement = facilitator.settle(unb64<Payment>(String(header)), offer, name);
    } catch (err) {
      const reason = err instanceof MetalRefused ? err.reason : err instanceof ClearingRefusal ? err.reason : (err as Error).message;
      res.writeHead(402, { "content-type": "application/json", "payment-required": b64({ x402Version: 2, accepts: [offer] }) });
      return res.end(JSON.stringify({ x402Version: 2, error: "payment refused", reason, detail: (err as Error).message, tx: (err as MetalRefused).tx, retry: (err as ClearingRefusal).retry, accepts: [offer] }));
    }
    if (route.latencyMs) await new Promise((r) => setTimeout(r, route.latencyMs!()));
    seller.calls += 1;
    const body = await route.handle(req, url);
    res.writeHead(200, { "content-type": "application/json", "payment-response": b64({ success: true, ...settlement }) });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  seller.url = `http://127.0.0.1:${port}`;
  seller.server = server;
  seller.close = () => new Promise((r) => server.close(() => r()));
  return seller;
}

export class PaymentRefused extends Error {
  constructor(readonly reason: string, readonly detail: string, readonly tx?: string, readonly retry?: { ms?: number; depositMicros?: number }) {
    super(detail);
  }
}

export interface Paid<T> {
  body: T;
  offer: Offer;
  /** Price paid: cents for "exact", micros for "clearing". */
  price: number;
  settlement: { tx: string; detail: string };
  ms: number;
}

/**
 * Pay an x402 URL. `sign` turns the offer into a payment (and may refuse it,
 * e.g. an offer above the agent's own limit). Reads the 402 offer each time.
 */
export async function payFetch<T = unknown>(url: string, sign: (offer: Offer) => Payment, guard?: (offer: Offer) => void): Promise<Paid<T>> {
  const t0 = Date.now();
  const first = await fetch(url);
  if (first.status !== 402) throw new Error(`expected a 402 offer from ${url}, got ${first.status}`);
  const offer = (unb64<{ accepts: Offer[] }>(first.headers.get("payment-required")!)).accepts[0]!;
  if (offer.asset !== "*USDZ" || offer.network !== METAL_TESTNET) throw new PaymentRefused("wrong_asset", `offer is not *USDZ on ${METAL_TESTNET}`);
  guard?.(offer);
  const paid = await fetch(url, { headers: { "payment-signature": b64(sign(offer)) } });
  const json = (await paid.json()) as any;
  if (paid.status === 402) throw new PaymentRefused(json.reason, json.detail, json.tx, json.retry);
  if (!paid.ok) throw new Error(`${url} answered ${paid.status}`);
  return { body: json as T, offer, price: offer.scheme === "clearing" ? baseToMicros(BigInt(offer.amount)) : fromBase(BigInt(offer.amount)), settlement: unb64(paid.headers.get("payment-response")!), ms: Date.now() - t0 };
}

export const exactPayment = (mandate: string) => (o: Offer): Payment => ({ scheme: "exact", mandate, paymentId: randomUUID(), amount: o.amount, payTo: o.payTo });

/** A clearing payer: signs the key's new running total (position + this price) for each request. */
export const clearingPayment = (key: string, position: () => number) => (o: Offer): Payment => ({
  scheme: "clearing",
  key,
  amount: o.amount,
  payTo: o.payTo,
  cumulative: (microsToBase(position()) + BigInt(o.amount)).toString(),
});
