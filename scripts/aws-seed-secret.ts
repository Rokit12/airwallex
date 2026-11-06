/**
 * Copies the sandbox credentials from your local .env and .metal/ into the
 * deployment's Secrets Manager secret, so the kits on AgentCore use the same
 * Airwallex sandbox account and Metal testnet keys as your local runs.
 *
 *   npm run aws:seed                 (reads infra/outputs.json for the secret)
 *   npm run aws:seed -- --dry-run    (lists what would be sent; no values)
 *
 * Values go straight from your machine to Secrets Manager over TLS. Nothing is
 * printed, logged or written to the repository. The Anthropic key is not sent:
 * on AWS the model is on Bedrock, called with the runtime's IAM role.
 */
import "../src/core/env.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const KEYS = ["AWX_CLIENT_ID", "AWX_API_KEY", "METAL_RPC_URL"];
const dry = process.argv.includes("--dry-run");

const outputs = existsSync("infra/outputs.json") ? JSON.parse(readFileSync("infra/outputs.json", "utf8")) : {};
const secretArn = process.env.DESK_SECRET_ARN ?? outputs.AgentDesk?.SecretArn;
if (!secretArn && !dry) throw new Error("No secret ARN: deploy first (npm run aws:deploy writes infra/outputs.json) or set DESK_SECRET_ARN");

const value: Record<string, unknown> = {};
for (const k of KEYS) if (process.env[k]) value[k] = process.env[k];
if (!value.AWX_CLIENT_ID || !value.AWX_API_KEY) throw new Error("AWX_CLIENT_ID and AWX_API_KEY must be set in .env");

// Only the Metal key the kits read at run time: the clearing operator (kit 12).
// Mandate and check keys stay on your machine; npm run metal:check is a local tool.
const METAL_FILES = ["operator.json"];
const files: Record<string, string> = {};
for (const f of METAL_FILES) if (existsSync(join(".metal", f))) files[f] = readFileSync(join(".metal", f), "utf8");
if (Object.keys(files).length) value.METAL_FILES = files;

const size = Buffer.byteLength(JSON.stringify(value));
console.log(`secret: ${Object.keys(value).join(", ")}${value.METAL_FILES ? ` (${Object.keys(value.METAL_FILES as object).length} Metal files)` : ""}, ${size} bytes`);
if (size > 60_000) throw new Error("Secret over Secrets Manager's 64 KB limit: prune old files in .metal/");
if (dry) process.exit(0);

const { SecretsManagerClient, PutSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
const region = secretArn.split(":")[3];
await new SecretsManagerClient({ region }).send(new PutSecretValueCommand({ SecretId: secretArn, SecretString: JSON.stringify(value) }));
console.log(`seeded ${secretArn.split(":").slice(-1)[0]} in ${region}. New runtime sessions pick it up; the next console run uses it.`);
