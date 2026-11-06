/**
 * Kit 10, live on Airwallex Agentic Commerce (ACP).
 *
 * The merchant (Trailhead Outfitters) is onboarded with Airwallex: its 120
 * products are in Airwallex's catalogue, and its Create Checkout endpoint,
 * OAuth server and payment webhook run on AWS (src/aws/merchant.ts). This run
 * is the shopper's assistant on Airwallex's merchant MCP endpoint:
 *
 *   sign in (merchant OAuth, guest) → explore_products → create_checkout_session
 *   (Airwallex calls the merchant to price it) → confirm exact terms → choose
 *   delivery → pay with a delegate token scoped to this session and the
 *   approved total → a declined card is retried on the same session → order.
 *
 * The card number never reaches the agent: the shopper's checkout UI
 * tokenizes it with Airwallex (create_delegate_payment_token) and the agent
 * only handles the token, which cannot be spent above the approved amount.
 */
import { createHash } from "node:crypto";
import { RailsClient } from "../../src/core/rails.ts";
import { say, usd } from "../../src/core/narrate.ts";
import { extract } from "../../src/core/llm.ts";
import { requestApproval, assertApproved, type Terms } from "../../src/core/approval.ts";
import { auditPath } from "../../src/core/audit.ts";
import { AcpShopper, type AcpConfig } from "../../src/merchant/acp-client.ts";

const MERCHANT = "Trailhead Outfitters";
const SHOPPER = `Can you find me a set of two insulated water bottles? Under $85 including shipping,
standard delivery is fine, and I want to be able to return them.`;
const BUYER = { email: "jordan.lee@example.com", first_name: "Jordan", last_name: "Lee" };
const ADDRESS = { name: "Jordan Lee", line_one: "2400 Pearl Street", city: "Boulder", state: "CO", postal_code: "80302", country: "US" };

/** Name on the test card (Airwallex sandbox test cards accept any name, a future expiry and any 3-digit CVC). */
const CARDHOLDER = "Robinson Muiru";

const major = (minor: number) => Math.round(minor) / 100;
const totalOf = (s: any) => Number((s.totals ?? []).find((t: any) => t.type === "total")?.amount ?? NaN);

/**
 * The shopper's checkout UI (Airwallex's native checkout widget in the
 * shopper's AI assistant) tokenizes the card. Card numbers live only here, never in the
 * agent's context, prompts or logs; the agent receives the token.
 */
async function shopperTokenizes(acp: AcpShopper, sessionId: string, maxAmountMinor: number, card: "declined" | "good", idempotencyKey: string): Promise<{ token: string; last4: string }> {
  const number = card === "declined" ? "4646464646464644" : "4035501000000008"; // Airwallex sandbox test cards
  const tok = await acp.tool("create_delegate_payment_token", {
    request: {
      payment_method: { type: "card", card_number_type: "fpan", number, exp_month: "12", exp_year: "2030", cvc: "737", display_card_funding_type: card === "declined" ? "credit" : "debit", name: CARDHOLDER },
      allowance: { reason: "one_time", checkout_session_id: sessionId, currency: "USD", max_amount: maxAmountMinor, expires_at: new Date(Date.now() + 30 * 60_000).toISOString() },
      billing_address: ADDRESS,
      risk_signals: [{ type: "card_testing", action: "authorized", score: 1 }],
      idempotency_key: idempotencyKey,
    },
  });
  return { token: tok.id, last4: number.slice(-4) };
}

async function merchantOrder(cfg: AcpConfig, orderId: string, waitMs = 30_000) {
  const until = Date.now() + waitMs;
  let last: any = null;
  while (Date.now() < until) {
    const r = await fetch(`${cfg.merchantUrl}/shop/orders/${orderId}?format=json`);
    if (r.ok && (r.headers.get("content-type") ?? "").includes("json")) {
      last = await r.json();
      if (last.status === "PAID") return last;
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  return last;
}

export async function runLive(cfg: AcpConfig) {
  const awx = new RailsClient();
  say.title("Kit 10 · Merchant-Enabled Agentic Checkout — live on Airwallex Agentic Commerce");
  say.beat("goal", "Let a shopper buy through their AI assistant: confirmed terms, card tokenized by Airwallex, one order even if a payment fails.");

  say.beat("connect", "The assistant connects to Airwallex's merchant MCP endpoint and the shopper signs in with the merchant.");
  const acp = new AcpShopper(cfg.mcpUrl);
  const authServer = await acp.signIn("Agent Desk shopping assistant");
  say.step(`sign-in: the MCP endpoint names the merchant's OAuth server ${new URL(authServer).host} (on AWS) · guest checkout · PKCE · RS256 token`);
  const { server, tools } = await acp.connect();
  say.step(`MCP server ${server} at ${new URL(cfg.mcpUrl).host} · tools: ${tools.join(", ")}`);

  say.document(SHOPPER);
  const { value: ask } = await extract(
    "Extract JSON: query (short product search string), max_total (number), returns_required (boolean), delivery (STANDARD or EXPRESS).",
    SHOPPER,
    (v: any): v is { query: string; max_total: number; returns_required: boolean; delivery: string } => v && typeof v.query === "string" && typeof v.max_total === "number",
    () => ({ query: "insulated water bottle set", max_total: 85, returns_required: true, delivery: "STANDARD" }),
  );

  say.beat("search", "Search Airwallex's copy of the merchant catalogue.");
  const found = await acp.tool("explore_products", { query: ask.query });
  const products = (found.products ?? []).map((p: any) => ({ id: p.variants?.[0]?.id ?? p.id, title: p.title, price: major(p.variants?.[0]?.price?.amount ?? 0), returns: /30-day returns/i.test(p.description_plain ?? "") }));
  say.table(products.map((p: any) => ({ id: p.id, product: p.title, price: p.price, returns: p.returns })));
  const shippingGuess = ask.delivery === "EXPRESS" ? 14 : 6;
  // Relevance first: keep only the titles that match the most of the shopper's words (search ORs them).
  const words = ask.query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const score = (t: string) => words.filter((w) => t.toLowerCase().includes(w)).length;
  const best = Math.max(0, ...products.map((p: any) => score(p.title)));
  const fits = products.filter((p: any) => score(p.title) === best && best >= Math.min(2, words.length) && (!ask.returns_required || p.returns) && p.price + shippingGuess <= ask.max_total);
  if (!fits.length) {
    say.decision("purchase", "ESCALATE", `No set with returns fits ${usd(ask.max_total)} including delivery; asking the shopper instead of buying something else.`);
    return;
  }
  const choice = fits.sort((a: any, b: any) => a.price - b.price)[0];
  say.decision("pick", `${choice.title} · ${usd(choice.price)}`, `Best match for "${ask.query}", with 30-day returns, at the lowest price that leaves room for ${ask.delivery.toLowerCase()} delivery under ${usd(ask.max_total)}.`);

  say.beat("price", "Open a checkout session. Airwallex asks the merchant to price it (Create Checkout, HMAC-signed, on AWS).");
  const session = await acp.tool("create_checkout_session", {
    currency: "USD",
    line_items: [{ id: "li_1", quantity: 1, item: { id: choice.id } }],
    buyer: BUYER,
    fulfillment_details: { name: ADDRESS.name, email: BUYER.email, address: ADDRESS },
  });
  say.step(`session ${session.id.slice(0, 8)}… · ${session.status} · merchant priced it: ${(session.totals ?? []).map((t: any) => `${t.type} ${usd(major(t.amount))}`).join(", ")}`);
  say.table((session.fulfillment_options ?? []).map((o: any) => ({ option: o.title, type: o.type, carrier: o.carrier ?? "", cost: usd(major((o.totals ?? []).reduce((sum: number, t: any) => sum + Number(t.amount ?? 0), 0))) })));
  const want = (session.fulfillment_options ?? []).find((o: any) => new RegExp(ask.delivery, "i").test(o.title));
  if (!want) throw new Error(`the merchant offers no ${ask.delivery} delivery`);
  const ready = await acp.tool("update_checkout_session", { checkout_session_id: session.id, selected_fulfillment_options: [{ option_id: want.id }] });
  const totalMinor = totalOf(ready);
  say.step(`${want.title} selected → ${ready.status} · total ${usd(major(totalMinor))} (Airwallex added the delivery line)`);
  if (major(totalMinor) > ask.max_total) {
    say.decision("purchase", "ESCALATE", `The merchant's total ${usd(major(totalMinor))} is above the shopper's ${usd(ask.max_total)}; not buying.`);
    return;
  }

  say.beat("confirm", "Confirm merchant, product, quantity, delivery and total before any payment.");
  const terms: Terms = { action: "CHECKOUT", amount: major(totalMinor), currency: "USD", counterparty: MERCHANT, product: `${choice.id} ${choice.title}`, quantity: 1, delivery: want.title, checkout_session: session.id };
  const approval = await requestApproval(terms, `Buy 1 × ${choice.title} from ${MERCHANT}, ${want.title}, ${usd(major(totalMinor))}?`);
  if (!approval) throw new Error("Shopper did not confirm");
  assertApproved(terms, approval);
  const recheck = totalOf(await acp.tool("get_checkout_session", { checkout_session_id: session.id }));
  assertApproved({ ...terms, amount: major(recheck) }, approval); // the merchant's total must still be the approved one
  const key = (n: number) => createHash("sha256").update(`${approval.termsHash}:${n}`).digest("hex").slice(0, 32);

  say.beat("pay", "The shopper's checkout UI tokenizes the card with Airwallex. The agent gets a token limited to this session and the approved total.");
  const attempt = async (n: number, card: "declined" | "good") => {
    const { token, last4 } = await shopperTokenizes(acp, session.id, totalMinor, card, key(n));
    say.step(`delegate token for card •••• ${last4}: this session only, at most ${usd(major(totalMinor))}`);
    try {
      const done = await acp.tool("complete_checkout_session", { checkout_session_id: session.id, buyer: BUYER, payment_data: { handler_id: "card", instrument: { type: "card", credential: { type: "spt", token } }, billing_address: ADDRESS } });
      return { ok: true as const, done };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  };
  let result = await attempt(1, "declined");
  if (!result.ok) {
    say.beat("exception", "The payment was declined.");
    say.step(`Airwallex: ${result.error}`);
    // Retry only when the first attempt is verifiably not paid. If the session cannot be read, or shows an order, stop.
    const state = await acp.tool("get_checkout_session", { checkout_session_id: session.id }).catch(() => null);
    // ready_for_payment is the only state that proves nothing was paid; anything else (completed, in progress, unreadable) stops.
    if (!state || state.status !== "ready_for_payment") {
      say.decision("retry", "STOP", state ? `The session is ${state.status}, not ready_for_payment: the first attempt may have been paid, so no second payment is sent.` : "The checkout session could not be read, so the first attempt cannot be verified. No second payment is sent.");
      throw new Error("first payment attempt not verifiable; stopped without retrying");
    }
    say.decision("retry", "SAME CHECKOUT, NEW CARD", `The session is ${state.status} with no completed order, so nothing was charged. A new checkout could double-order if the first payment settled later; the shopper pays again on the same session.`);
    result = await attempt(2, "good");
  }
  if (!result.ok) throw new Error(`payment failed again: ${result.error}`);

  say.beat("result", "Order confirmation from Airwallex and from the merchant.");
  const order = result.done.order ?? {};
  const orderId: string = order.id;
  say.ok(`Airwallex: checkout ${result.done.status} · merchant order ${orderId}`);
  const intents: any = await awx.get("/pa/payment_intents", { query: { merchant_order_id: orderId, page_size: 10 } }).catch(() => ({ items: [] }));
  const forOrder = (intents.items ?? []).filter((p: any) => p.merchant_order_id === orderId);
  const succeeded = forOrder.filter((p: any) => p.status === "SUCCEEDED");
  const merchant = await merchantOrder(cfg, orderId);
  say.table([{ order: orderId, airwallex_payment: succeeded[0]?.id ?? "", paid: succeeded[0] ? `${succeeded[0].currency} ${succeeded[0].amount}` : "", successful_payments: succeeded.length, merchant_status: merchant?.status ?? "unknown", ...(merchant?.selected_option_id ? { delivery_option: merchant.selected_option_id } : {}) }]);
  if (merchant?.status !== "PAID") say.warn("merchant webhook has not confirmed the payment yet (payment_intent.succeeded → /webhooks/airwallex)");
  say[succeeded.length === 1 ? "ok" : "fail"](`order ${orderId} · paid ${usd(major(totalMinor))} once · 1 declined attempt on the same session · order page ${order.permalink_url ?? ""}`);
  say.step(`audit log: ${auditPath}`);
}
