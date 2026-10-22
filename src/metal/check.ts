/**
 * npm run metal:check — proves the live Metal testnet path end to end:
 * RPC endpoint (chain id), Metal's x402 facilitator, the faucet, and one real
 * x402 payment from a funded key to this project's own seller (src/metal/live-seller.ts).
 * Keys live in .metal/ (git-ignored).
 */
import "../core/env.ts";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startLiveSeller } from "./live-seller.ts";
import { METAL } from "./rail.ts";

const run = promisify(execFile);
const cli = "node_modules/.bin/metal-agent";
const ok = (s: string) => console.log(`  ✔ ${s}`);
const fail = (s: string) => {
  console.log(`  ✖ ${s}`);
  process.exit(1);
};

const rpc = process.env.METAL_RPC_URL;
if (!rpc) fail("METAL_RPC_URL is not set: create an endpoint at https://console-testnet.metalntwx.com and add it to .env");
const chain = (await (await fetch(rpc!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) })).json()) as { result?: string };
if (Number(chain.result) !== METAL.chainId) fail(`RPC answered chain ${chain.result}, expected ${METAL.chainId}`);
ok(`RPC endpoint on Metal testnet (chain ${METAL.chainId})`);
const sup = await fetch(`${METAL.facilitatorUrl}/supported`);
if (!sup.ok) fail(`facilitator answered ${sup.status}`);
ok("Metal x402 facilitator reachable");

mkdirSync(".metal", { recursive: true, mode: 0o700 });
const key = ".metal/check.json";
if (!existsSync(key)) await run(cli, ["key", "create", "--out", key]);
const address = JSON.parse(readFileSync(key, "utf8")).address as string;
try {
  const { stdout } = await run(cli, ["fund", address, "--network", "testnet"], { env: process.env });
  ok(stdout.split("\n")[0]!);
} catch (e: any) {
  console.log(`  ! faucet: ${(e.stderr || e.message).trim().split("\n").pop()} (continuing with the key's balance)`);
}

const payee = "0x000000000000000000000000000000000000dEaD";
const seller = await startLiveSeller([{ path: "/conditions", priceCents: () => 1, payTo: payee, description: "Trail conditions (metal:check)", handle: () => ({ route: "Mount Tamalpais loop", conditions: "dry, light wind" }) }]);
try {
  const unpaid = await fetch(`${seller.url}/conditions`);
  ok(`our x402 seller answers ${unpaid.status} with a Metal offer`);
  const { stdout } = await run(cli, ["pay", `${seller.url}/conditions`, "--network", "testnet", "--key", key], { env: process.env, timeout: 120_000 });
  const line = (k: string) => stdout.split("\n").find((l) => l.startsWith(`${k} `))?.slice(k.length + 1) ?? "";
  if (line("status") !== "200") fail(`payment did not complete:\n${stdout}`);
  ok(`paid ${line("amount")} on chain · transaction ${line("transaction")}`);
  ok(`explorer ${line("explorer")}`);
} finally {
  await seller.close();
}
