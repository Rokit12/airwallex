/**
 * Loads a `.env` file from the project root into process.env (without
 * overriding variables that are already set). Keeps setup to: copy
 * .env.example to .env, paste sandbox keys, run.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const path = join(process.cwd(), ".env");
if (existsSync(path)) {
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
