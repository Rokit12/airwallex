/**
 * Kit 11's x402 market: sellers that take payments under mandates with the
 * agent's signed order, and the agents that pay them. Two implementations
 * behind one shape:
 *
 *  - Live (Metal testnet): the official @x402/express middleware with Metal's
 *    `exact` scheme (registerMetalScheme) and requireSignedOffer; payers use
 *    createMandatePaymentClient, which signs the order the route asks for.
 *    Metal's facilitator verifies and settles. Settlement happens only after the
 *    handler answers below 400, so a query the seller cannot serve is answered
 *    with an error status and the customer's payment is never settled.
 *    onAfterSettle hands over each signed order with its transaction hash.
 *  - Emulated: a local seller with the same order of operations (check the
 *    payment, run the handler, settle only on success) on the Metal emulator.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { Address } from "./emulator.ts";
import { MetalRefused } from "./emulator.ts";
import type { MandateChain } from "./mandates.ts";
import { toBase, fromBase } from "./units.ts";

export interface SaleContext {
  /** The account that pays (the customer's MetalAccount). */
  payer: Address;
  /** A key unique to this payment (the authorization nonce live, the payment id emulated). */
  paymentKey: string;
}

export interface MarketRoute {
  path: string;
  /** Current price in cents, read for every offer. */
  priceCents: () => number;
  payTo: Address;
  description: string;
  /** Require the paying agent's signed order (requireSignedOffer). */
  signedOrders?: boolean;
  handle: (req: IncomingMessage, ctx: SaleContext) => Promise<{ status: number; body: unknown }>;
}

/** A settled sale, as the seller records it: the signed order with its transaction hash and what was delivered. */
export interface SettledSale {
  path: string;
  paymentKey: string;
  payer: Address;
  cents: number;
  tx: string;
  signedOrder: string;
  delivered: unknown;
}

export interface MarketSeller {
  url: string;
  close(): Promise<void>;
}

export interface PayResult {
  status: number;
  body: any;
  cents: number;
  tx?: string;
  refusal?: { reason: string; detail: string };
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = <T>(s: string): T => JSON.parse(Buffer.from(s, "base64").toString("utf8"));

// ── Emulated ────────────────────────────────────────────────────────────────

type LocalPayment = { mandate: string; paymentId: string; amount: string; payTo: Address; payer: Address };

async function startLocalSeller(chain: MandateChain, routes: MarketRoute[], onSettled: (s: SettledSale) => void): Promise<MarketSeller> {
  let base = "";
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const route = routes.find((r) => r.path === url.pathname);
    if (!route) return res.writeHead(404).end();
    const cents = route.priceCents();
    const offer = { scheme: "exact", network: "eip155:63825", asset: "*USDZ", amount: toBase(cents).toString(), payTo: route.payTo, resource: `${base}${route.path}`, description: route.description, ...(route.signedOrders ? { extra: { signedOffer: "required" } } : {}) };
    const header = req.headers["payment-signature"];
    if (!header) {
      res.writeHead(402, { "content-type": "application/json", "payment-required": b64({ x402Version: 2, accepts: [offer] }) });
      return res.end(JSON.stringify({ x402Version: 2, error: "payment required", accepts: [offer] }));
    }
    const p = unb64<LocalPayment>(String(header));
    if (p.payTo !== route.payTo || p.amount !== offer.amount) {
      res.writeHead(402, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "payment does not match the offer" }));
    }
    // Verify first (what the facilitator's verify does): the mandate must allow this payment.
    const reason = (chain as any).chain?.check?.(p.mandate, p.payTo, cents) as string | null;
    if (reason) {
      res.writeHead(402, { "content-type": "application/json" });
      return res.end(JSON.stringify({ x402Version: 2, error: "payment refused", reason, detail: `refused by the mandate: ${reason}` }));
    }
    let out: { status: number; body: unknown };
    try {
      out = await route.handle(req, { payer: p.payer, paymentKey: p.paymentId });
    } catch (err) {
      out = { status: 500, body: { error: "handler failed", detail: (err as Error).message } };
    }
    if (out.status >= 400) {
      res.writeHead(out.status, { "content-type": "application/json" });
      return res.end(JSON.stringify(out.body)); // not settled: the payer is not charged
    }
    const ev = await chain.pull(p.mandate, p.payTo, cents, { paymentId: p.paymentId });
    onSettled({ path: route.path, paymentKey: p.paymentId, payer: p.payer, cents, tx: ev.tx, signedOrder: JSON.stringify(p), delivered: out.body });
    res.writeHead(200, { "content-type": "application/json", "payment-response": b64({ success: true, transaction: ev.tx }) });
    res.end(JSON.stringify(out.body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url: base, close: () => new Promise((r) => server.close(() => r())) };
}

async function localPay(chain: MandateChain, mandateId: string, url: string, headers: Record<string, string>): Promise<PayResult> {
  const first = await fetch(url, { headers });
  if (first.status !== 402) return { status: first.status, body: await first.json().catch(() => null), cents: 0 };
  const offer = unb64<{ accepts: any[] }>(first.headers.get("payment-required")!).accepts[0];
  const m = chain.mandate(mandateId);
  const payment: LocalPayment = { mandate: mandateId, paymentId: randomUUID(), amount: offer.amount, payTo: offer.payTo, payer: m.principal };
  const res = await fetch(url, { headers: { ...headers, "payment-signature": b64(payment) } });
  const body = await res.json().catch(() => null);
  const cents = fromBase(BigInt(offer.amount));
  if (res.status === 402) return { status: 402, body, cents, refusal: { reason: body?.reason ?? "refused", detail: body?.detail ?? "" } };
  const tx = res.headers.get("payment-response") ? unb64<{ transaction?: string }>(res.headers.get("payment-response")!).transaction : undefined;
  return { status: res.status, body, cents, tx };
}

// ── Live: Metal testnet with the official x402 packages ─────────────────────

async function startLiveSeller(chain: MandateChain, routes: MarketRoute[], onSettled: (s: SettledSale) => void): Promise<MarketSeller> {
  const express = (await import("express")).default;
  const { HTTPFacilitatorClient, x402ResourceServer } = await import("@x402/core/server");
  const { decodePaymentSignatureHeader } = await import("@x402/core/http");
  const { paymentMiddleware } = await import("@x402/express");
  const { METAL_NETWORKS, registerMetalScheme } = await import("@metalntwx/metal-pay");
  const { requireSignedOffer, signedOfferOf, SIGNED_OFFER_REQUIRED } = await import("@metalntwx/metal-pay/mandates");
  const net = METAL_NETWORKS.testnet;
  const facilitator = new HTTPFacilitatorClient({ url: process.env.METAL_FACILITATOR_URL ?? net.facilitatorUrl });
  const server = requireSignedOffer(registerMetalScheme(new x402ResourceServer(facilitator)), { rpcUrl: process.env.METAL_RPC_URL! });
  const byPath = new Map(routes.map((r) => [r.path, r]));
  server.onAfterSettle(async (ctx: any) => {
    const auth = ctx.paymentPayload?.payload?.authorization ?? {};
    const req = ctx.transportContext?.request;
    const path: string = req?.path ?? req?.adapter?.getPath?.() ?? new URL(String(ctx.requirements?.resource ?? "/"), "http://x").pathname;
    const raw = ctx.transportContext?.responseBody;
    let delivered: unknown = null;
    try { delivered = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw ?? "null")); } catch { /* not JSON */ }
    onSettled({ path, paymentKey: String(auth.nonce ?? ""), payer: auth.from as Address, cents: fromBase(BigInt(ctx.requirements.amount)), tx: String(ctx.result?.transaction ?? ""), signedOrder: signedOfferOf(ctx.paymentPayload), delivered });
  });
  const app = express();
  app.use(
    paymentMiddleware(
      Object.fromEntries(
        routes.map((r) => [
          `GET ${r.path}`,
          { accepts: { scheme: "exact", network: net.network, payTo: r.payTo, price: () => (r.priceCents() / 100).toFixed(2), ...(r.signedOrders ? { extra: { ...SIGNED_OFFER_REQUIRED } } : {}) }, description: r.description },
        ]),
      ) as any,
      server,
    ),
  );
  for (const r of routes) {
    app.get(r.path, async (req: any, res: any) => {
      const header = String(req.headers["payment-signature"] ?? "");
      const auth = header ? ((decodePaymentSignatureHeader(header) as any).payload?.authorization ?? {}) : {};
      try {
        const out = await byPath.get(r.path)!.handle(req, { payer: auth.from as Address, paymentKey: String(auth.nonce ?? "") });
        res.status(out.status).json(out.body);
      } catch (err) {
        res.status(500).json({ error: "handler failed", detail: (err as Error).message });
      }
    });
  }
  const http: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  return { url: `http://127.0.0.1:${(http.address() as { port: number }).port}`, close: () => new Promise((r) => http.close(() => r())) };
}

async function livePay(chain: MandateChain, mandateId: string, url: string, headers: Record<string, string>): Promise<PayResult> {
  const { decodePaymentResponseHeader, decodePaymentRequiredHeader } = await import("@x402/core/http");
  const payer = await (chain as any).payerFor(mandateId);
  const res: Response = await payer.fetchWithPayment(url, { headers });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  const cents = payer.lastCents?.() ?? 0;
  if (res.status === 402) {
    const pr = res.headers.get("payment-required");
    const decoded: any = pr ? decodePaymentRequiredHeader(pr) : {};
    // A settlement the facilitator refused comes back in PAYMENT-RESPONSE (errorReason, e.g. rate_limited).
    const settleHeader = res.headers.get("payment-response");
    const settled: any = settleHeader ? decodePaymentResponseHeader(settleHeader) : {};
    const reason = String(settled.errorReason ?? decoded.error ?? body?.error ?? body?.reason ?? "refused");
    if (process.env.X402_DEBUG) (await import("node:fs")).appendFileSync(process.env.X402_DEBUG, JSON.stringify({ url, decoded, body, headers: Object.fromEntries(res.headers) }) + "\n");
    return { status: 402, body, cents, refusal: { reason, detail: reason } };
  }
  const pr = res.headers.get("payment-response");
  const tx = pr ? String((decodePaymentResponseHeader(pr) as any).transaction ?? "") : undefined;
  return { status: res.status, body, cents, tx };
}

// ── One shape for the kit ───────────────────────────────────────────────────

export function startMarketSeller(chain: MandateChain, routes: MarketRoute[], onSettled: (s: SettledSale) => void) {
  return chain.mode === "live" ? startLiveSeller(chain, routes, onSettled) : startLocalSeller(chain, routes, onSettled);
}

/** An agent pays an x402 URL under its own mandate (signing the order when the route asks for one). */
export function marketPay(chain: MandateChain, mandateId: string, url: string, headers: Record<string, string> = {}) {
  return chain.mode === "live" ? livePay(chain, mandateId, url, headers) : localPay(chain, mandateId, url, headers);
}

/**
 * Check a settled sale against the chain: live, verifyMandatePayment checks the signed order against the
 * payment in that transaction under the customer's credential; emulated, the payment must be in the chain log.
 */
export async function verifySignedOrder(chain: MandateChain, mandateId: string, sale: SettledSale): Promise<{ ok: boolean; detail: string }> {
  if (chain.mode === "live") return (chain as any).verifyOrder(mandateId, sale.tx, sale.signedOrder);
  const found = (await chain.verify(mandateId)).find((e) => e.tx === sale.tx && e.kind === "payment");
  return { ok: Boolean(found), detail: found ? `payment in block ${found.block} under the customer's mandate` : "no such payment under the customer's mandate" };
}

void MetalRefused;
