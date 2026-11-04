/**
 * Loads the deployment's secrets from AWS Secrets Manager into the process
 * environment, so the kits read them exactly as they read .env locally.
 *
 * The secret (AWX_SECRET_ARN) is one JSON object:
 *   {"AWX_CLIENT_ID": "...", "AWX_API_KEY": "...", "METAL_RPC_URL": "...",
 *    "METAL_FILES": {"operator.json": "...", ...}}
 * METAL_FILES are the Metal testnet key files that live in .metal/ locally;
 * they are written to the writable work directory with owner-only access.
 *
 * Only the names of what was loaded are ever returned or logged, never values.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export async function loadSecrets(): Promise<string[]> {
  const arn = process.env.AWX_SECRET_ARN;
  if (!arn) return [];
  const { SecretsManagerClient, GetSecretValueCommand } = await import("@aws-sdk/client-secrets-manager");
  const out = await new SecretsManagerClient({ region: process.env.AWS_REGION }).send(new GetSecretValueCommand({ SecretId: arn }));
  let values: Record<string, unknown> = {};
  try {
    values = JSON.parse(out.SecretString ?? "{}");
  } catch {
    console.error("The Agent Desk secret is not valid JSON; kits will run against the emulator");
    return [];
  }
  const loaded: string[] = [];
  for (const [k, v] of Object.entries(values)) {
    if (k === "METAL_FILES" && v && typeof v === "object") {
      mkdirSync(".metal", { recursive: true, mode: 0o700 });
      for (const [name, content] of Object.entries(v as Record<string, string>)) {
        const file = join(".metal", basename(name)); // no paths from the secret
        writeFileSync(file, String(content), { mode: 0o600 });
        chmodSync(file, 0o600);
      }
      loaded.push(`METAL_FILES(${Object.keys(v).length})`);
    } else if (/^[A-Z][A-Z0-9_]*$/.test(k) && typeof v === "string" && v && process.env[k] === undefined) {
      process.env[k] = v;
      loaded.push(k);
    }
  }
  return loaded;
}
