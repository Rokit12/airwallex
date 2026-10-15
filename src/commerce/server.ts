/**
 * HTTP front of the test storefront.
 *
 *  /                      search page          (kit 9's browser agent shops here)
 *  /search?q=             results
 *  /product/:sku          product page
 *  POST /cart             start a checkout
 *  /checkout/:id          review, delivery choice, total
 *  /pay/:id               hosted payment page: card fields live only here
 *  /orders/:ref           order / payment status (used to check before any retry)
 *  POST /mcp              merchant MCP endpoint (kit 10): search_products,
 *                         get_product, create_checkout, get_checkout
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Store, MERCHANT, DELIVERY, type DeliveryId, type Checkout } from "./store.ts";
import type { AirwallexClient } from "../core/client.ts";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const money = (n: number) => `$${n.toFixed(2)}`;
const page = (title: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} · ${MERCHANT.name}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;color:#1d2433}a{color:#c2410c}
.result,.line{padding:8px 0;border-bottom:1px solid #e5e7eb}button{background:#c2410c;color:#fff;border:0;border-radius:6px;padding:8px 14px;font:inherit;cursor:pointer}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px}dt{color:#6b7280}input{font:inherit;padding:6px}</style></head>
<body><header><a href="/"><b>${MERCHANT.name}</b></a></header><main>${body}</main></body></html>`;

async function form(req: IncomingMessage): Promise<Record<string, string>> {
  let s = "";
  for await (const c of req) s += c;
  if ((req.headers["content-type"] ?? "").includes("application/json")) return s ? JSON.parse(s) : {};
  return Object.fromEntries(new URLSearchParams(s));
}

function checkoutView(c: Checkout) {
  return {
    checkout_id: c.id,
    reference: c.ref,
    merchant: MERCHANT.name,
    items: c.items,
    delivery: c.delivery,
    total: c.total,
    currency: c.currency,
    status: c.status,
    order_number: c.orderNumber ?? null,
    payment_attempts: c.attempts.map((a) => ({ at: a.at, outcome: a.outcome, card_last4: a.last4 })),
    payment_url: c.status === "PAID" ? null : `/pay/${c.id}`,
  };
}

const TOOLS = [
  { name: "search_products", description: "Search the Trailhead Outfitters catalogue.", inputSchema: { type: "object", properties: { query: { type: "string" }, max_price: { type: "number" }, ships_within_days: { type: "number" }, returns_required: { type: "boolean" } }, required: ["query"] } },
  { name: "get_product", description: "Current price, stock, delivery and returns for one product.", inputSchema: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"] } },
  { name: "create_checkout", description: "Create (or return, for a repeated idempotency_key) a checkout. Returns the total and a hosted payment_url where the shopper enters their card; card details never pass through this tool.", inputSchema: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { sku: { type: "string" }, qty: { type: "number" } } } }, delivery: { type: "string", enum: DELIVERY.map((d) => d.id) }, idempotency_key: { type: "string" } }, required: ["items", "delivery", "idempotency_key"] } },
  { name: "get_checkout", description: "Read a checkout's status, payment attempts and order number. Call this before any retry.", inputSchema: { type: "object", properties: { checkout_id: { type: "string" } }, required: ["checkout_id"] } },
];

function callTool(store: Store, name: string, a: any) {
  switch (name) {
    case "search_products":
      return store.search(a.query, { maxPrice: a.max_price, shipsWithinDays: a.ships_within_days, returnsRequired: a.returns_required, inStockOnly: true }).slice(0, 8);
    case "get_product":
      return store.product(a.sku) ?? { error: "not found" };
    case "create_checkout":
      return checkoutView(store.createCheckout(a.items, a.delivery as DeliveryId, a.idempotency_key));
    case "get_checkout": {
      const c = store.getCheckout(a.checkout_id);
      return c ? checkoutView(c) : { error: "not found" };
    }
  }
  throw new Error(`Unknown tool ${name}`);
}

export async function startStore(awx: AirwallexClient, port = 0) {
  const store = new Store(awx);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://store");
    const send = (status: number, html: string, type = "text/html; charset=utf-8") => res.writeHead(status, { "content-type": type }).end(html);
    const redirect = (to: string) => res.writeHead(303, { location: to }).end();
    try {
      let m: RegExpMatchArray | null;
      if (req.method === "GET" && url.pathname === "/") {
        return send(200, page("Search", `<h1>Find gear</h1><form action="/search"><input id="q" name="q" placeholder="Search" required> <button>Search</button></form>`));
      }
      if (req.method === "GET" && url.pathname === "/search") {
        const q = url.searchParams.get("q") ?? "";
        const results = store.search(q);
        return send(200, page(`Search: ${q}`, `<h1>Results for “${esc(q)}”</h1><ul>${results.map((p) => `<li class="result"><a href="/product/${p.sku}">${esc(p.name)}</a> · <span class="price">${money(p.price)}</span></li>`).join("") || "<li>No matches</li>"}</ul>`));
      }
      if (req.method === "GET" && (m = url.pathname.match(/^\/product\/([\w-]+)$/))) {
        const p = store.product(m[1]!);
        if (!p) return send(404, page("Not found", "<p>Not found</p>"));
        return send(200, page(p.name, `<h1 id="name">${esc(p.name)}</h1><p>${esc(p.description)}</p>
<dl><dt>Price</dt><dd id="price" data-value="${p.price}">${money(p.price)}</dd><dt>Ships in</dt><dd id="ships" data-value="${p.shipsInDays}">${p.shipsInDays} business days</dd>
<dt>Returns</dt><dd id="returns" data-value="${p.returnsAccepted}">${p.returnsAccepted ? "30-day returns" : "Final sale"}</dd><dt>In stock</dt><dd id="stock" data-value="${p.stock}">${p.stock}</dd><dt>Rating</dt><dd id="rating" data-value="${p.rating}">${p.rating} / 5</dd></dl>
<form method="post" action="/cart"><input type="hidden" name="sku" value="${p.sku}"><input type="number" name="qty" value="1" min="1" id="qty"> <button id="add">Add to cart and check out</button></form>`));
      }
      if (req.method === "POST" && url.pathname === "/cart") {
        const f = await form(req);
        const c = store.createCheckout([{ sku: f.sku!, qty: Number(f.qty ?? 1) }], "STANDARD");
        return redirect(`/checkout/${c.id}`);
      }
      if ((m = url.pathname.match(/^\/checkout\/([\w-]+)$/))) {
        const c = store.getCheckout(m[1]!);
        if (!c) return send(404, page("Not found", "<p>No such checkout</p>"));
        if (req.method === "POST") {
          const f = await form(req);
          const d = DELIVERY.find((x) => x.id === f.delivery);
          if (d && c.status !== "PAID") {
            c.delivery = { ...d };
            c.total = Math.round((c.items.reduce((s, i) => s + i.unitPrice * i.qty, 0) + d.price) * 100) / 100;
            c.paymentIntentId = undefined;
          }
          return redirect(`/checkout/${c.id}`);
        }
        return send(200, page("Checkout", `<h1>Checkout <small id="ref">${c.ref}</small></h1>${c.items.map((i) => `<div class="line" data-sku="${i.sku}">${esc(i.name)} × ${i.qty} · <span class="unit" data-value="${i.unitPrice}">${money(i.unitPrice)}</span></div>`).join("")}
<form method="post"><fieldset><legend>Delivery</legend>${DELIVERY.map((d) => `<label><input type="radio" name="delivery" value="${d.id}" data-days="${d.days}" ${c.delivery.id === d.id ? "checked" : ""}> ${d.label} · ${money(d.price)}</label><br>`).join("")}</fieldset><button id="update">Update delivery</button></form>
<p>Total <strong id="total" data-value="${c.total}">${money(c.total)}</strong> · status <span id="status">${c.status}</span></p>${c.status === "PAID" ? `<p>Order <span id="order">${c.orderNumber}</span></p>` : `<a id="pay" href="/pay/${c.id}">Continue to payment</a>`}`));
      }
      if ((m = url.pathname.match(/^\/pay\/([\w-]+)$/))) {
        const c = store.getCheckout(m[1]!);
        if (!c) return send(404, page("Not found", "<p>No such checkout</p>"));
        if (req.method === "POST") {
          const f = await form(req);
          const delay = store.slowNextPaymentMs;
          store.slowNextPaymentMs = 0;
          const done = await store.pay(c.id, { number: (f.number ?? "").replace(/\s/g, ""), expiry_month: f.expiry_month!, expiry_year: f.expiry_year!, cvc: f.cvc!, name: f.name ?? "" });
          if (delay) await new Promise((r) => setTimeout(r, delay)); // the payment is done; only the response is slow
          return redirect(`/orders/${done.ref}`);
        }
        return send(200, page("Secure payment", `<h1>Secure payment</h1><p>${MERCHANT.name} · checkout <span id="ref">${c.ref}</span> · <strong id="total" data-value="${c.total}">${money(c.total)}</strong></p>
<p><small>Hosted payment page. Card details go to the payment processor and are not shared with any assistant.</small></p>
<form method="post" autocomplete="off"><label>Card number <input id="number" name="number" inputmode="numeric"></label><br><label>Expiry <input id="expiry_month" name="expiry_month" size="2"> / <input id="expiry_year" name="expiry_year" size="4"></label><br>
<label>CVC <input id="cvc" name="cvc" size="4"></label><br><label>Name <input id="cardname" name="name"></label><br><button id="paynow">Pay ${money(c.total)}</button></form>`));
      }
      if (req.method === "GET" && (m = url.pathname.match(/^\/orders\/([\w-]+)$/))) {
        const c = store.getCheckout(m[1]!);
        if (!c) return send(404, page("Not found", `<p id="status">NOT_FOUND</p>`));
        return send(200, page("Order status", `<h1>Checkout ${c.ref}</h1><p>Status <span id="status">${c.status}</span></p><p>Order <span id="order">${c.orderNumber ?? ""}</span></p><p>Charged <span id="charged" data-value="${c.status === "PAID" ? c.total : 0}">${c.status === "PAID" ? money(c.total) : "nothing"}</span></p><ol>${c.attempts.map((a) => `<li class="attempt">${esc(a.outcome)} · card •••• ${a.last4}</li>`).join("")}</ol>`));
      }
      if (req.method === "POST" && url.pathname === "/mcp") {
        const msg = await form(req) as any;
        const reply = (result: unknown) => send(200, JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }), "application/json");
        if (msg.method === "initialize") return reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "trailhead-store", version: "1.0.0" } });
        if (msg.method?.startsWith("notifications/")) return res.writeHead(202).end();
        if (msg.method === "tools/list") return reply({ tools: TOOLS });
        if (msg.method === "tools/call") {
          try {
            const out = callTool(store, msg.params.name, msg.params.arguments ?? {});
            return reply({ content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out });
          } catch (err) {
            return reply({ content: [{ type: "text", text: (err as Error).message }], isError: true });
          }
        }
        return send(200, JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } }), "application/json");
      }
      send(404, page("Not found", "<p>Not found</p>"));
    } catch (err) {
      send(500, page("Error", `<p id="error">${esc((err as Error).message)}</p>`));
    }
  });
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { store, url, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export function sendJson(res: ServerResponse, body: unknown) {
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
}
