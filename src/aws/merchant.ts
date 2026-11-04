/**
 * Kit 10 on AWS: the merchant-hosted endpoints Airwallex Agentic Commerce calls.
 * One Lambda behind a public API Gateway HTTP API:
 *
 *   POST /checkout                Create Checkout (Airwallex → merchant, HMAC-signed)
 *   POST /webhooks/airwallex      payment_intent.succeeded (signed with the webhook's own secret)
 *   GET  /oauth/.well-known/openid-configuration   OAuth server for the shopper's assistant
 *   POST /oauth/register          dynamic client registration
 *   GET|POST /oauth/authorize     shopper signs in (guest checkout)
 *   POST /oauth/token             authorization code + PKCE → RS256 access token
 *   GET  /oauth/jwks              public signing key
 *   GET  /shop/product/{sku}      product page (the catalogue's `link`)
 *   GET  /shop/orders/{id}        order page (the checkout's `permalink_url`)
 *
 * Every money rule (prices, stock, totals) comes from src/merchant/acp.ts.
 * Secrets (checkout secret, webhook secret, signing key) come from Secrets
 * Manager and are never logged. State (OAuth clients and codes, orders, seen
 * webhook events) lives in one DynamoDB table with expiry.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { buildCatalog } from "../commerce/catalog.ts";
import { checkoutResponse, findOrderId, fulfillmentProblems, validCheckoutRequest, verifySignature } from "../merchant/acp.ts";
import { accessTokenClaims, allowedRedirect, discovery, pkceMatches, publicJwks, randomToken, signJwt } from "../merchant/oauth.ts";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.MERCHANT_TABLE!;
const SITE = (process.env.SITE_URL ?? "").replace(/\/$/, "");
const catalog = buildCatalog();

interface MerchantSecrets { checkout_secret: string; webhook_secret?: string; signing_key_pem: string; kid: string }
let secrets: MerchantSecrets | null = null;
let secretsAt = 0;
async function getSecrets(): Promise<MerchantSecrets> {
  if (secrets && Date.now() - secretsAt < 5 * 60_000) return secrets;
  const out = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: process.env.MERCHANT_SECRET_ARN! }));
  const value: MerchantSecrets = JSON.parse(out.SecretString ?? "{}");
  // Cache only a complete secret, so keys or a webhook secret added later are picked up at once.
  if (value.signing_key_pem && value.checkout_secret && value.webhook_secret) {
    secrets = value;
    secretsAt = Date.now();
  }
  return value;
}

const ttl = (seconds: number) => Math.floor(Date.now() / 1000) + seconds;
const put = (item: Record<string, unknown>, onlyNew = false) =>
  db.send(new PutCommand({ TableName: TABLE, Item: item, ...(onlyNew ? { ConditionExpression: "attribute_not_exists(pk)" } : {}) }));
const get = async (pk: string) => (await db.send(new GetCommand({ TableName: TABLE, Key: { pk } }))).Item;

const json = (statusCode: number, body: unknown, headers: Record<string, string> = {}): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  body: JSON.stringify(body),
});
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const page = (title: string, inner: string): APIGatewayProxyResultV2 => ({
  statusCode: 200,
  headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; img-src https:; style-src 'unsafe-inline'; frame-ancestors 'none'" },
  body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Trailhead Outfitters</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#f6f4ef;color:#1c1b19}main{max-width:640px;margin:0 auto;padding:32px 16px}header{background:#1f3a2e;color:#fff;padding:14px 16px;font-weight:600}
.card{background:#fff;border:1px solid #e3ded3;border-radius:12px;padding:20px;margin:16px 0}button{font:inherit;background:#1f3a2e;color:#fff;border:0;border-radius:8px;padding:10px 18px;cursor:pointer}
.muted{color:#6b665c;font-size:14px}table{width:100%;border-collapse:collapse}td{padding:6px 0;border-bottom:1px solid #eee}img{max-width:100%;border-radius:8px}.pill{display:inline-block;padding:2px 10px;border-radius:99px;background:#e7f1ea;color:#1f3a2e;font-size:13px}</style></head>
<body><header>Trailhead Outfitters</header><main>${inner}<p class="muted">Sandbox demo store for the Airwallex Agentic Banking Hackathon. No real goods or money.</p></main></body></html>`,
});

function rawBody(e: APIGatewayProxyEventV2): string {
  if (!e.body) return "";
  return e.isBase64Encoded ? Buffer.from(e.body, "base64").toString("utf8") : e.body;
}
const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a.trim()), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const header = (e: APIGatewayProxyEventV2, name: string) => e.headers?.[name] ?? e.headers?.[name.toLowerCase()];
const money = (minor: number) => `USD ${(minor / 100).toFixed(2)}`;
const newOrderId = () => `TRL-ORD-${createHash("sha256").update(randomToken(16)).digest("hex").slice(0, 8).toUpperCase()}`;

// ── Create Checkout ─────────────────────────────────────────────────────────
async function createCheckout(e: APIGatewayProxyEventV2, base: string) {
  const body = rawBody(e);
  const { checkout_secret } = await getSecrets();
  if (!verifySignature(checkout_secret, header(e, "x-timestamp"), body, header(e, "x-signature"))) {
    console.log(JSON.stringify({ route: "checkout", result: "bad_signature" }));
    return json(401, { error: "invalid_signature" });
  }
  let req: unknown;
  try {
    req = JSON.parse(body);
  } catch {
    return json(400, { error: "invalid_json" });
  }
  if (!validCheckoutRequest(req)) return json(400, { error: "invalid_request" });
  const orderId = newOrderId();
  const priced = checkoutResponse(req, catalog, orderId, `${base}/shop/orders/${orderId}`);
  const problems = fulfillmentProblems(priced.response);
  if (problems.length) {
    console.error(JSON.stringify({ route: "checkout", problems }));
    return json(500, { error: "fulfillment_rules", problems });
  }
  await put({ pk: `order#${orderId}`, status: "OPEN", lines: priced.lines, subtotal_minor: priced.subtotalMinor, currency: req.currency, created_at: new Date().toISOString(), expires_at: ttl(30 * 86400) });
  console.log(JSON.stringify({ route: "checkout", orderId, lines: priced.lines.length, subtotal: priced.subtotalMinor }));
  return json(200, priced.response);
}

// ── Payment webhook ─────────────────────────────────────────────────────────
async function paymentWebhook(e: APIGatewayProxyEventV2) {
  const body = rawBody(e);
  const { webhook_secret } = await getSecrets();
  // Airwallex signs webhooks with HMAC-SHA256 of x-timestamp + raw body; newer webhook versions
  // also carry the webhook secret in a request header. Accept either, compared in constant time.
  const signed = !!webhook_secret && verifySignature(webhook_secret, header(e, "x-timestamp"), body, header(e, "x-signature"));
  const secretHeader = !!webhook_secret && Object.values(e.headers ?? {}).some((v) => typeof v === "string" && sameSecret(v, webhook_secret));
  if (!signed && !secretHeader) {
    // Header names only, never values, to diagnose a format change.
    console.log(JSON.stringify({ route: "webhook", result: webhook_secret ? "bad_signature" : "no_secret_configured", headers: Object.keys(e.headers ?? {}) }));
    return json(401, { error: "invalid_signature" });
  }
  const evt = JSON.parse(body);
  const eventId = String(evt.id ?? "");
  // At-least-once delivery: record the event id first; a repeat is acknowledged and ignored.
  try {
    await put({ pk: `event#${eventId}`, name: evt.name, expires_at: ttl(7 * 86400) }, true);
  } catch (err: any) {
    if (err?.name === "ConditionalCheckFailedException") return json(200, { received: true, duplicate: true });
    throw err;
  }
  if (evt.name !== "payment_intent.succeeded") return json(200, { received: true, ignored: evt.name });
  const intent = evt.data?.object ?? {};
  const f = intent.agentic_payment_data?.fulfillment ?? {};
  const orderId = findOrderId(intent);
  const record = {
    status: "PAID",
    payment_intent_id: intent.id,
    amount: intent.amount,
    currency: intent.currency,
    fulfillment_type: f.type,
    selected_destination_id: f.selected_destination_id,
    selected_option_id: f.selected_option_id,
    paid_at: new Date().toISOString(),
  };
  if (orderId) {
    await db.send(new UpdateCommand({
      TableName: TABLE,
      Key: { pk: `order#${orderId}` },
      UpdateExpression: "SET #s = :s, payment_intent_id = :pi, amount = :a, paid_currency = :c, fulfillment_type = :ft, selected_destination_id = :d, selected_option_id = :o, paid_at = :at",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":s": "PAID", ":pi": record.payment_intent_id ?? null, ":a": record.amount ?? null, ":c": record.currency ?? null, ":ft": record.fulfillment_type ?? null, ":d": record.selected_destination_id ?? null, ":o": record.selected_option_id ?? null, ":at": record.paid_at },
    }));
  } else {
    await put({ pk: `payment#${intent.id}`, ...record, note: "no order id found in the payment intent", expires_at: ttl(30 * 86400) });
  }
  console.log(JSON.stringify({ route: "webhook", eventId, orderId, paymentIntent: intent.id, option: f.selected_option_id }));
  return json(200, { received: true });
}

// ── OAuth ───────────────────────────────────────────────────────────────────
async function register(e: APIGatewayProxyEventV2) {
  let req: any;
  try {
    req = JSON.parse(rawBody(e) || "{}");
  } catch {
    return json(400, { error: "invalid_client_metadata" });
  }
  const uris: unknown[] = Array.isArray(req.redirect_uris) ? req.redirect_uris : [];
  if (!uris.length || uris.length > 5 || !uris.every(allowedRedirect)) return json(400, { error: "invalid_redirect_uri", error_description: "HTTPS or loopback redirect URIs only" });
  const client = {
    client_id: `acp_${randomToken(12)}`,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: typeof req.client_name === "string" ? req.client_name.slice(0, 80) : "Shopping assistant",
    redirect_uris: uris as string[],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
  await put({ pk: `client#${client.client_id}`, ...client, expires_at: ttl(90 * 86400) });
  return json(201, client);
}

async function authorizeCheck(q: Record<string, string | undefined>) {
  const client = q.client_id ? await get(`client#${q.client_id}`) : undefined;
  if (!client) return "Unknown client.";
  if (!q.redirect_uri || !(client.redirect_uris as string[]).includes(q.redirect_uri)) return "This redirect address is not registered for the client.";
  if (q.response_type !== "code") return "Only the authorization code flow is supported.";
  if (!q.code_challenge || q.code_challenge_method !== "S256") return "PKCE with S256 is required.";
  return { client };
}

async function authorizePage(e: APIGatewayProxyEventV2) {
  const q = e.queryStringParameters ?? {};
  const ok = await authorizeCheck(q);
  if (typeof ok === "string") return page("Sign-in error", `<div class="card"><h2>Can't sign in</h2><p>${esc(ok)}</p></div>`);
  const hidden = ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state", "scope"].map((k) => `<input type="hidden" name="${k}" value="${esc(q[k] ?? "")}">`).join("");
  return page(
    "Sign in",
    `<div class="card"><h2>Shop Trailhead Outfitters with your assistant</h2>
<p><b>${esc(ok.client.client_name)}</b> wants to browse our catalogue and start checkouts for you. It can't pay on its own: you confirm and pay each order on Airwallex's secure payment page.</p>
<form method="post" action="authorize">${hidden}<button type="submit">Continue as guest</button></form>
<p class="muted">Guest checkout: no account needed. Delivery details are collected at checkout.</p></div>`,
  );
}

async function authorizeSubmit(e: APIGatewayProxyEventV2) {
  const q = Object.fromEntries(new URLSearchParams(rawBody(e)));
  const ok = await authorizeCheck(q);
  if (typeof ok === "string") return page("Sign-in error", `<div class="card"><h2>Can't sign in</h2><p>${esc(ok)}</p></div>`);
  const code = randomToken();
  await put({ pk: `code#${code}`, client_id: q.client_id, redirect_uri: q.redirect_uri, code_challenge: q.code_challenge, scope: q.scope || "openid", sub: `guest:${randomToken(9)}`, expires_at: ttl(300) });
  const to = new URL(q.redirect_uri!);
  to.searchParams.set("code", code);
  if (q.state) to.searchParams.set("state", q.state);
  return { statusCode: 302, headers: { location: to.toString(), "cache-control": "no-store" }, body: "" };
}

async function token(e: APIGatewayProxyEventV2, issuer: string) {
  const ct = header(e, "content-type") ?? "";
  const body = rawBody(e);
  const p: Record<string, string> = ct.includes("json") ? JSON.parse(body || "{}") : Object.fromEntries(new URLSearchParams(body));
  const { signing_key_pem, kid } = await getSecrets();
  const issue = async (clientId: string, sub: string, scope: string) => {
    const access = signJwt(accessTokenClaims(issuer, clientId, sub, scope), signing_key_pem, kid);
    const refresh = randomToken();
    await put({ pk: `refresh#${refresh}`, client_id: clientId, sub, scope, expires_at: ttl(30 * 86400) });
    return json(200, { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope });
  };
  if (p.grant_type === "authorization_code") {
    const rec = p.code ? await get(`code#${p.code}`) : undefined;
    if (rec) await db.send(new DeleteCommand({ TableName: TABLE, Key: { pk: `code#${p.code}` } })); // single use
    if (!rec || rec.expires_at < Math.floor(Date.now() / 1000)) return json(400, { error: "invalid_grant" });
    if (rec.client_id !== p.client_id || rec.redirect_uri !== p.redirect_uri) return json(400, { error: "invalid_grant", error_description: "client or redirect mismatch" });
    if (!pkceMatches(p.code_verifier, rec.code_challenge)) return json(400, { error: "invalid_grant", error_description: "PKCE verification failed" });
    return issue(rec.client_id, rec.sub, rec.scope);
  }
  if (p.grant_type === "refresh_token") {
    const rec = p.refresh_token ? await get(`refresh#${p.refresh_token}`) : undefined;
    if (!rec || rec.client_id !== p.client_id) return json(400, { error: "invalid_grant" });
    await db.send(new DeleteCommand({ TableName: TABLE, Key: { pk: `refresh#${p.refresh_token}` } })); // rotate
    return issue(rec.client_id, rec.sub, rec.scope);
  }
  return json(400, { error: "unsupported_grant_type" });
}

// ── Pages ───────────────────────────────────────────────────────────────────
const IMG: Record<string, string> = { Tents: "tents", Sleeping: "sleeping", Hydration: "hydration", Kitchen: "kitchen", Packs: "packs", Lighting: "lighting" };
function productPage(sku: string) {
  const p = catalog.find((x) => x.sku === sku);
  if (!p) return page("Not found", `<div class="card"><h2>Product not found</h2></div>`);
  return page(p.name, `<div class="card"><img src="${SITE}/shop/img/${IMG[p.category] ?? "packs"}.png" alt="${esc(p.category)}"><h2>${esc(p.name)}</h2>
<p><b>USD ${p.price.toFixed(2)}</b> · <span class="pill">${p.stock > 0 ? `${p.stock} in stock` : "Out of stock"}</span></p><p>${esc(p.description)}</p>
<p class="muted">SKU ${esc(p.sku)} · ships in ${p.shipsInDays} day(s) · ${p.returnsAccepted ? "30-day returns" : "final sale"} · rated ${p.rating}/5</p>
<p class="muted">Ask your shopping assistant to buy it: checkout and payment run through Airwallex.</p></div>`);
}

async function orderPage(id: string) {
  const o = /^TRL-ORD-[A-Z0-9]{8}$/.test(id) ? await get(`order#${id}`) : undefined;
  if (!o) return page("Order not found", `<div class="card"><h2>Order not found</h2></div>`);
  const rows = (o.lines as any[]).map((l) => `<tr><td>${esc(l.name)} × ${l.qty}</td><td style="text-align:right">USD ${(l.unit * l.qty).toFixed(2)}</td></tr>`).join("");
  const paid = o.status === "PAID";
  return page(`Order ${id}`, `<div class="card"><h2>Order ${esc(id)}</h2><p><span class="pill">${paid ? "Paid" : "Awaiting payment"}</span></p>
<table>${rows}<tr><td><b>Subtotal</b></td><td style="text-align:right"><b>${money(o.subtotal_minor)}</b></td></tr></table>
${paid ? `<p>Paid ${esc(o.paid_currency ?? "USD")} ${esc(o.amount)} (delivery included) · payment ${esc(o.payment_intent_id)} · ${o.fulfillment_type ? `${esc(String(o.fulfillment_type).toLowerCase())}, option ${esc(o.selected_option_id)}` : ""}</p>` : `<p class="muted">This page updates when Airwallex confirms the payment.</p>`}</div>`);
}

/** The merchant's view of an order, for the kit's read-back (no shopper details). */
async function orderJson(id: string) {
  const o = /^TRL-ORD-[A-Z0-9]{8}$/.test(id) ? await get(`order#${id}`) : undefined;
  if (!o) return json(404, { error: "not_found" });
  return json(200, { id, status: o.status, subtotal_minor: o.subtotal_minor, lines: (o.lines as any[]).map((l) => ({ sku: l.sku, qty: l.qty })), payment_intent_id: o.payment_intent_id ?? null, amount: o.amount ?? null, currency: o.paid_currency ?? o.currency, selected_option_id: o.selected_option_id ?? null, paid_at: o.paid_at ?? null });
}

// ── Router ──────────────────────────────────────────────────────────────────
export async function handler(e: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const method = e.requestContext.http.method;
  const path = e.rawPath.replace(/\/+$/, "") || "/";
  const base = `https://${e.requestContext.domainName}`;
  const issuer = `${base}/oauth`;
  try {
    if (method === "POST" && path === "/checkout") return await createCheckout(e, base);
    if (method === "POST" && path === "/webhooks/airwallex") return await paymentWebhook(e);
    if (method === "GET" && ["/oauth/.well-known/openid-configuration", "/oauth/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/oauth", "/.well-known/openid-configuration/oauth"].includes(path)) return json(200, discovery(issuer), { "cache-control": "max-age=300" });
    if (method === "GET" && path === "/oauth/jwks") {
      const { signing_key_pem, kid } = await getSecrets();
      return json(200, publicJwks(signing_key_pem, kid), { "cache-control": "max-age=300" });
    }
    if (method === "POST" && path === "/oauth/register") return await register(e);
    if (method === "GET" && path === "/oauth/authorize") return await authorizePage(e);
    if (method === "POST" && path === "/oauth/authorize") return await authorizeSubmit(e);
    if (method === "POST" && path === "/oauth/token") return await token(e, issuer);
    let m: RegExpMatchArray | null;
    if (method === "GET" && (m = path.match(/^\/shop\/product\/([\w-]+)$/))) return productPage(m[1]!);
    if (method === "GET" && (m = path.match(/^\/shop\/orders\/([\w-]+)$/))) {
      if (e.queryStringParameters?.format === "json") return await orderJson(m[1]!);
      return await orderPage(m[1]!);
    }
    if (method === "GET" && path === "/") return page("Store", `<div class="card"><h2>Trailhead Outfitters</h2><p>120 products for the outdoors, sold through shopping assistants with Airwallex Agentic Commerce.</p><p><a href="shop/product/TRL-1000">See a product</a></p></div>`);
    return json(404, { error: "not_found" });
  } catch (err) {
    console.error(JSON.stringify({ route: path, error: String((err as Error)?.message ?? err).slice(0, 300) }));
    return json(500, { error: "server_error" });
  }
}
