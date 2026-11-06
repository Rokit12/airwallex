import { test } from "node:test";
import assert from "node:assert/strict";
import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { buildCatalog } from "../commerce/catalog.ts";
import { checkoutResponse, findOrderId, fulfillmentProblems, sign, toGmc, verifySignature } from "./acp.ts";
import { accessTokenClaims, allowedRedirect, discovery, pkceMatches, publicJwks, signJwt } from "./oauth.ts";

const catalog = buildCatalog();
const now = Date.UTC(2026, 10, 4, 12);

test("Create Checkout calls are accepted only with a fresh, matching signature", () => {
  const body = '{"line_items":[]}';
  const ts = String(now);
  const sig = sign("s3cret", ts, body);
  assert.equal(verifySignature("s3cret", ts, body, sig, now), true);
  assert.equal(verifySignature("s3cret", ts, body + " ", sig, now), false, "body changed");
  assert.equal(verifySignature("other", ts, body, sig, now), false, "wrong secret");
  assert.equal(verifySignature("s3cret", String(now - 10 * 60_000), body, sign("s3cret", String(now - 10 * 60_000), body), now), false, "stale timestamp");
  assert.equal(verifySignature("s3cret", undefined, body, sig, now), false);
  assert.equal(verifySignature("s3cret", ts, body, "zz", now), false);
});

test("a checkout prices the cart in minor units, caps quantity at stock and covers every line", () => {
  const p = catalog.find((x) => x.stock >= 2)!;
  const out = catalog.find((x) => x.stock === 0)!;
  const { response, subtotalMinor } = checkoutResponse(
    { currency: "USD", line_items: [{ id: "li_1", item_id: p.sku, requested_quantity: 2 }, { id: "li_2", item_id: out.sku, requested_quantity: 1 }, { id: "li_3", item_id: "NOPE", requested_quantity: 1 }], shipping_address: { street: "1 Main St", city: "Denver", state: "CO", postcode: "80202", country_code: "US" } },
    catalog, "TRL-ORD-ABCDEFGH", "https://m.example/shop/orders/TRL-ORD-ABCDEFGH", new Date(now),
  ) as any;
  assert.equal(subtotalMinor, Math.round(p.price * 100) * 2);
  assert.deepEqual(response.line_items.map((l: any) => l.available_quantity), [2, 0, 0]);
  assert.deepEqual(response.totals.map((t: any) => t.type), ["subtotal", "tax", "total"]);
  assert.ok(!response.totals.some((t: any) => t.type === "fulfillment"), "Airwallex adds the fulfillment row");
  assert.deepEqual(fulfillmentProblems(response), []);
  assert.equal(response.fulfillment.methods[0].options[0].cost, 600);
});

test("only USD is sold", () => {
  const p = catalog.find((x) => x.stock > 0)!;
  const { response } = checkoutResponse({ currency: "EUR", line_items: [{ id: "a", item_id: p.sku, requested_quantity: 1 }] }, catalog, "TRL-ORD-AAAAAAAA", "x") as any;
  assert.equal(response.line_items[0].available_quantity, 0);
});

test("the fulfillment rule check catches what Airwallex would reject", () => {
  const bad = { line_items: [{ id: "a" }, { id: "b" }], fulfillment: { methods: [{ id: "m", type: "SHIPPING", line_item_ids: ["a"], destinations: [{ id: "m" }], options: [] }, { id: "m2", type: "SHIPPING", line_item_ids: ["a", "b"], destinations: [], options: [] }] } };
  assert.deepEqual(fulfillmentProblems(bad).sort(), ["duplicate_fulfillment_id", "fulfillment_does_not_cover_cart", "multiple_fulfillment_methods_per_type"]);
});

test("products go to Airwallex in GMC attributes", () => {
  const g = toGmc(catalog[0]!, "https://m.example", "https://img.example");
  for (const k of ["id", "title", "description", "link", "image_link", "availability", "price"]) assert.ok(g[k], k);
  assert.match(String(g.price), /^\d+\.\d{2} USD$/);
  assert.ok(String(g.image_link).startsWith("https://img.example/"));
  assert.ok(Array.isArray(g.product_type), "product_type is a list");
});

test("the order id is found in a webhook payload wherever it is carried", () => {
  assert.equal(findOrderId({ data: { object: { agentic_payment_data: { checkout_id: "TRL-ORD-ZXCVBNM1" } } } }), "TRL-ORD-ZXCVBNM1");
  assert.equal(findOrderId({ data: {} }), null);
});

test("OAuth: discovery, redirect policy and PKCE", () => {
  const d = discovery("https://m.example/oauth");
  assert.equal(d.issuer, "https://m.example/oauth");
  assert.ok(d.code_challenge_methods_supported.includes("S256"));
  assert.equal(allowedRedirect("http://localhost:3334/oauth/callback"), true);
  assert.equal(allowedRedirect("https://assistant.example/api/mcp/auth_callback"), true);
  assert.equal(allowedRedirect("http://evil.example/cb"), false);
  assert.equal(allowedRedirect("javascript:alert(1)"), false);
  const verifier = "a".repeat(43);
  const challenge = "ZtNPunH49FD35FWYhT5Tv8I7vRKQJ8uxMaL0_9eHjNA"; // sha256("a"*43), base64url
  assert.equal(pkceMatches(verifier, challenge), true);
  assert.equal(pkceMatches("b".repeat(43), challenge), false);
  assert.equal(pkceMatches("short", challenge), false);
});

test("OAuth: tokens are RS256 JWTs with exp and iat that verify against the published JWKS", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const claims = accessTokenClaims("https://m.example/oauth", "client1", "guest:1", "openid", 1_000_000);
  const jwt = signJwt(claims, pem, "k1");
  const [h, b, s] = jwt.split(".");
  const jwk = publicJwks(pem, "k1").keys[0]!;
  const ok = createVerify("RSA-SHA256").update(`${h}.${b}`).verify(createPublicKey({ key: jwk as any, format: "jwk" }), Buffer.from(s!, "base64url"));
  assert.equal(ok, true);
  const body = JSON.parse(Buffer.from(b!, "base64url").toString());
  assert.equal(body.exp - body.iat, 3600);
  assert.equal(JSON.parse(Buffer.from(h!, "base64url").toString()).kid, "k1");
  assert.ok(!("awx_customer_id" in body), "guest shopper");
});
