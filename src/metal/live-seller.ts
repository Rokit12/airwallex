/**
 * A real x402 seller on Metal testnet: the official @x402/express middleware with
 * Metal's `exact` scheme registered (@metalntwx/metal-pay), verified and settled
 * by Metal's testnet facilitator. Prices are read on every request, so a price
 * change appears in the very next 402 offer.
 */
import express from "express";
import type { Server } from "node:http";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
import { METAL_NETWORKS, registerMetalScheme } from "@metalntwx/metal-pay";

export interface LiveRoute {
  path: string;
  /** Current price in cents. */
  priceCents: () => number;
  payTo: string;
  description: string;
  handle: (req: express.Request) => unknown | Promise<unknown>;
}

export interface LiveSeller {
  url: string;
  close(): Promise<void>;
}

export async function startLiveSeller(routes: LiveRoute[]): Promise<LiveSeller> {
  const net = METAL_NETWORKS.testnet;
  const facilitator = new HTTPFacilitatorClient({ url: process.env.METAL_FACILITATOR_URL ?? net.facilitatorUrl });
  const server = registerMetalScheme(new x402ResourceServer(facilitator));
  const app = express();
  app.use(
    paymentMiddleware(
      Object.fromEntries(
        routes.map((r) => [
          `GET ${r.path}`,
          { accepts: { scheme: "exact", network: net.network, payTo: r.payTo, price: () => (r.priceCents() / 100).toFixed(2) }, description: r.description },
        ]),
      ) as any,
      server,
    ),
  );
  for (const r of routes) app.get(r.path, async (req, res) => res.json(await r.handle(req)));
  const http: Server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = (http.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => http.close(() => r())) };
}
