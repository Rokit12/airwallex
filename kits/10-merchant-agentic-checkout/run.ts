/**
 * Kit 10 — Merchant-Enabled Agentic Checkout (merchant side)
 *
 * The merchant exposes its catalogue (120 synthetic products) and checkout to
 * Claude through an MCP server. The shopper asks Claude for a product; Claude
 * searches with the merchant's tools, confirms merchant, product, quantity,
 * delivery and total, creates a checkout with an idempotency key, and sends
 * the shopper to a hosted payment page. Card details go only to that page.
 *  - Exception path: the shopper's first card is declined. The agent reads the
 *    checkout, sees no order and no charge, and sends the shopper back to the
 *    same checkout instead of creating a new one.
 *  - Success: the merchant returns an order number and the payment outcome.
 *
 * Connect Claude to the same tools: `npm run store`, then
 *   claude mcp add-json trailhead-store '{"type":"http","url":"http://localhost:4320/mcp"}'
 *
 * Airwallex's own merchant MCP endpoint and catalogue upload are in the draft
 * Merchant Onboarding API and need merchant-side access; this storefront
 * implements the same flow until then.
 */
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { RailsClient } from "../../src/core/rails.ts";
import { startStore } from "../../src/commerce/server.ts";
import { MERCHANT } from "../../src/commerce/store.ts";
import { say, usd } from "../../src/core/narrate.ts";
import { extract } from "../../src/core/llm.ts";
import { requestApproval, assertApproved, type Terms } from "../../src/core/approval.ts";
import { auditPath } from "../../src/core/audit.ts";

const SHOPPER = `Can you find me a set of two insulated water bottles? Under $85 including shipping,
standard delivery is fine, and I want to be able to return them.`;

const awx = new RailsClient();
const { store, url, close } = await startStore(awx);
let rpcId = 0;
async function mcp(method: string, params: unknown = {}) {
  const res = await fetch(`${url}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  const msg = (await res.json()) as any;
  if (msg.error) throw new Error(msg.error.message);
  return msg.result;
}
const tool = async (name: string, args: unknown) => {
  const r = await mcp("tools/call", { name, arguments: args });
  if (r.isError) throw new Error(r.content[0].text);
  return r.structuredContent;
};

/** The shopper's own browser on the hosted payment page. The agent never sees these card numbers. */
async function shopperPays(paymentUrl: string, card: { number: string; label: string }) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url + paymentUrl);
    await page.fill("#number", card.number);
    await page.fill("#expiry_month", "12");
    await page.fill("#expiry_year", "2030");
    await page.fill("#cvc", "123");
    await page.fill("#cardname", "Jordan Lee");
    await Promise.all([page.waitForURL(/\/orders\//), page.click("#paynow")]);
  } finally {
    await browser.close();
  }
}

try {
  say.title("Kit 10 · Merchant-Enabled Agentic Checkout — buying through Claude with the merchant's MCP tools");
  say.beat("goal", "Let a shopper buy through Claude: confirmed terms, card only on the hosted page, one order even if a payment fails.");

  say.beat("connect", "Claude connects to the merchant's MCP server.");
  const init = await mcp("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "claude", version: "agent" } });
  const { tools } = await mcp("tools/list");
  say.step(`MCP server ${init.serverInfo.name} · tools: ${tools.map((t: any) => t.name).join(", ")}`);
  say.step(`catalogue: ${store.catalog.length} synthetic products across ${new Set(store.catalog.map((p) => p.category)).size} categories`);

  say.document(SHOPPER);
  const { value: ask } = await extract(
    "Extract JSON: query (short product search string), max_total (number), returns_required (boolean), delivery (STANDARD or EXPRESS).",
    SHOPPER,
    (v: any): v is { query: string; max_total: number; returns_required: boolean; delivery: string } => v && typeof v.query === "string" && typeof v.max_total === "number",
    () => ({ query: "insulated water bottle set", max_total: 85, returns_required: true, delivery: "STANDARD" }),
  );

  say.beat("search", "Search the catalogue with the merchant's tool, then refine.");
  const broad = await tool("search_products", { query: ask.query });
  say.step(`"${ask.query}": ${broad.length} matches`);
  const shipping = ask.delivery === "EXPRESS" ? 14 : 6;
  const refined = await tool("search_products", { query: ask.query, max_price: ask.max_total - shipping, returns_required: ask.returns_required });
  say.table(refined.map((p: any) => ({ sku: p.sku, product: p.name, price: p.price, rating: p.rating, stock: p.stock, returns: p.returnsAccepted })));
  const choice = refined.filter((p: any) => /set/i.test(p.name)).sort((a: any, b: any) => b.rating - a.rating)[0];
  const product = await tool("get_product", { sku: choice.sku });
  const total = Math.round((product.price + shipping) * 100) / 100;
  say.decision("Claude's pick", `${product.name} · ${usd(total)}`, `Highest-rated set under ${usd(ask.max_total)} with ${ask.delivery.toLowerCase()} delivery and returns; current price ${usd(product.price)} read just now with get_product.`);

  say.beat("confirm", "Confirm merchant, product, quantity, delivery and total before any payment.");
  const terms: Terms = { action: "CHECKOUT", amount: total, currency: "USD", counterparty: MERCHANT.name, product: `${product.sku} ${product.name}`, quantity: 1, delivery: ask.delivery };
  const approval = await requestApproval(terms, `Buy 1 × ${product.name} from ${MERCHANT.name}, ${ask.delivery.toLowerCase()} delivery, ${usd(total)}?`);
  if (!approval) throw new Error("Shopper did not confirm");
  assertApproved(terms, approval);

  const key = createHash("sha256").update(approval.termsHash + "checkout").digest("hex").slice(0, 24);
  const co = await tool("create_checkout", { items: [{ sku: product.sku, qty: 1 }], delivery: ask.delivery, idempotency_key: key });
  if (co.total !== total) throw new Error(`Checkout total ${co.total} differs from the confirmed ${total}: ask again`);
  say.ok(`checkout ${co.reference} · ${usd(co.total)} · payment page ${co.payment_url}`);
  const again = await tool("create_checkout", { items: [{ sku: product.sku, qty: 1 }], delivery: ask.delivery, idempotency_key: key });
  say.step(`agent retried create_checkout with the same idempotency key → ${again.checkout_id === co.checkout_id ? "same checkout returned, no duplicate" : "NEW checkout (bug)"}`);

  say.beat("pay", "The shopper enters a card on the hosted payment page.");
  await shopperPays(co.payment_url, { number: "2223000010181375", label: "Mastercard" });
  say.step("shopper submitted a Mastercard ending 1375");
  let state = await tool("get_checkout", { checkout_id: co.checkout_id });
  say.step(`get_checkout → ${state.status} · attempts: ${state.payment_attempts.map((a: any) => `${a.outcome} (•••• ${a.card_last4})`).join("; ")}`);

  if (state.status !== "PAID") {
    say.beat("exception", "The payment was declined.");
    const charged = state.order_number ? "an order exists" : "no order and no charge";
    say.decision("retry", "SAME CHECKOUT, NEW CARD", `The checkout shows ${charged}. Creating a new checkout could double-order if the first payment later settled, so the shopper is sent back to the same payment page.`);
    await shopperPays(state.payment_url, { number: "4035501000000008", label: "Visa" });
    say.step("shopper paid again with a Visa ending 0008");
    state = await tool("get_checkout", { checkout_id: co.checkout_id });
  }

  say.beat("result", awx.mode.payments === "emulated" ? "Merchant confirmation (card acceptance EMULATED on this account)." : "Merchant confirmation.");
  say.table([{ checkout: state.reference, order: state.order_number ?? "", status: state.status, total: state.total, attempts: state.payment_attempts.length, successful: state.payment_attempts.filter((a: any) => a.outcome === "SUCCEEDED").length }]);
  const ok = state.status === "PAID" && state.payment_attempts.filter((a: any) => a.outcome === "SUCCEEDED").length === 1;
  say[ok ? "ok" : "fail"](`order ${state.order_number} · paid ${usd(state.total)} once · ${state.payment_attempts.length - 1} declined attempt(s) on the same checkout`);
  say.step(`audit log: ${auditPath}`);
} finally {
  await close();
}
