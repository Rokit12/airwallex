/**
 * Kit 10 merchant setup for Airwallex Agentic Commerce, after npm run aws:deploy:
 *
 *   npm run aws:merchant -- keys        generate the checkout HMAC secret and the OAuth signing key (once)
 *   npm run aws:merchant -- onboard     register the merchant with Airwallex (create_checkout, OAuth, images)
 *   npm run aws:merchant -- products    upload the 120-product catalogue (GMC attributes)
 *   npm run aws:merchant -- webhook     store the payment webhook's secret (WEBHOOK_SECRET in the environment)
 *   npm run aws:merchant -- update      resend the endpoint configuration (after the URLs change)
 *   npm run aws:merchant -- status      show the merchant config (redacted) and the MCP endpoint
 *
 * Secrets go from this machine to Secrets Manager (and, for onboarding, to
 * Airwallex) over TLS. Nothing secret is printed or written to the repository.
 */
import "../src/core/env.ts";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { AirwallexClient } from "../src/core/client.ts";
import { buildCatalog } from "../src/commerce/catalog.ts";
import { toGmc } from "../src/merchant/acp.ts";

const out = existsSync("infra/outputs.json") ? JSON.parse(readFileSync("infra/outputs.json", "utf8")).AgentDesk ?? {} : {};
const merchantUrl: string = (process.env.MERCHANT_URL ?? out.MerchantUrl ?? "").replace(/\/$/, "");
const siteUrl: string = (process.env.CONSOLE_URL ?? out.ConsoleUrl ?? "").replace(/\/$/, "");
const secretArn: string = process.env.MERCHANT_SECRET_ARN ?? out.MerchantSecretArn ?? "";
const cmd = process.argv[2];
if (!merchantUrl || !siteUrl || !secretArn) throw new Error("Deploy first (npm run aws:deploy writes infra/outputs.json)");

const sm = new SecretsManagerClient({ region: secretArn.split(":")[3] });
const readSecret = async (): Promise<Record<string, string>> => JSON.parse((await sm.send(new GetSecretValueCommand({ SecretId: secretArn }))).SecretString ?? "{}");
const writeSecret = (v: Record<string, string>) => sm.send(new PutSecretValueCommand({ SecretId: secretArn, SecretString: JSON.stringify(v) }));

const awx = new AirwallexClient();
const AC = "/pa/agentic_commerce";
const apis = (s: Record<string, string>) => ({
  create_checkout: `${merchantUrl}/checkout`,
  secret_key: s.checkout_secret,
  oauth: { acp: { oauth_base: `${merchantUrl}/oauth`, oauth_jwks: `${merchantUrl}/oauth/jwks`, scopes: ["openid", "email"] } },
});
const summary = (r: any) => ({ merchant_id: r.merchant_id, status: r.status, create_checkout: r.apis?.create_checkout, oauth: r.apis?.oauth, images: r.whitelisted_image_domains, mcp_endpoints: r.mcp_endpoints });
const saveMcp = (r: any) => {
  if (!r?.mcp_endpoints?.acp) return;
  const acp = String(r.mcp_endpoints.acp);
  const url = acp.startsWith("http") ? acp : `https://mcp.sandbox.airwallex.com${acp.startsWith("/") ? "" : "/"}${acp}`;
  writeFileSync("infra/merchant.json", JSON.stringify({ merchant_id: r.merchant_id, acp_mcp_url: url }, null, 2));
  console.log(`ACP MCP endpoint for Claude Desktop: ${url}`);
};

switch (cmd) {
  case "keys": {
    const s = await readSecret();
    if (s.signing_key_pem && s.checkout_secret) {
      console.log("keys already exist; not replacing them (Airwallex holds the checkout secret)");
      break;
    }
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await writeSecret({
      ...s,
      checkout_secret: randomBytes(32).toString("hex"),
      signing_key_pem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      kid: `trl-${new Date().toISOString().slice(0, 10)}`,
    });
    console.log("generated the checkout HMAC secret and the OAuth signing key in Secrets Manager");
    break;
  }
  case "onboard": {
    const s = await readSecret();
    if (!s.checkout_secret) throw new Error("run keys first");
    const r = await awx.post(`${AC}/onboard`, {
      psp_config: { api_key_data: { client_id: process.env.AWX_CLIENT_ID, api_key: process.env.AWX_API_KEY } },
      apis: apis(s),
      whitelisted_image_domains: [new URL(siteUrl).origin],
    });
    console.log(JSON.stringify(summary(r), null, 2));
    saveMcp(r);
    break;
  }
  case "update": {
    const s = await readSecret();
    const r = await awx.post(`${AC}/config/update`, { psp_config: { api_key_data: { client_id: process.env.AWX_CLIENT_ID, api_key: process.env.AWX_API_KEY } }, apis: apis(s), whitelisted_image_domains: [new URL(siteUrl).origin] });
    console.log(JSON.stringify(summary(r), null, 2));
    saveMcp(r);
    break;
  }
  case "products": {
    const products = buildCatalog().map((p) => toGmc(p, merchantUrl, siteUrl));
    for (let i = 0; i < products.length; i += 300) {
      const r = await awx.post(`${AC}/products`, { type: "gmc", gmc_products: products.slice(i, i + 300) });
      console.log(`products ${i + 1}-${Math.min(i + 300, products.length)}: added ${r.records_added}, updated ${r.records_updated}, failed ${r.records_failed}`);
    }
    break;
  }
  case "webhook": {
    const w = process.env.WEBHOOK_SECRET;
    if (!w) throw new Error("set WEBHOOK_SECRET to the payment_intent.succeeded webhook's secret from the Airwallex web app");
    await writeSecret({ ...(await readSecret()), webhook_secret: w });
    console.log(`webhook secret stored; Airwallex should deliver to ${merchantUrl}/webhooks/airwallex`);
    break;
  }
  case "status": {
    const r = await awx.get(`${AC}/config`);
    console.log(JSON.stringify(summary(r), null, 2));
    saveMcp(r);
    break;
  }
  default:
    console.log("usage: npm run aws:merchant -- keys | onboard | products | webhook | update | status");
}
