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

// ── Spending limits (mandates), live: bind one, pay under it, and get refused over its cap ──
// Kit 11's agents run under limits like this one (3 cents a purchase). Needs metal-agent 0.3.3+:
// accounts made by earlier versions come from an older factory and must be recreated.
const field = (out: string, k: string) => out.split("\n").find((l) => l.startsWith(`${k} `))?.slice(k.length + 1).trim() ?? "";
const cliRun = async (args: string[]) => (await run(cli, [...args, "--network", "testnet"], { env: process.env, timeout: 180_000 })).stdout;
const owner = ".metal/mandate-owner.json";
const acctFile = ".metal/mandate-account.txt";
if (!existsSync(owner)) await run(cli, ["key", "create", "--out", owner]);
const ownerAddr = JSON.parse(readFileSync(owner, "utf8")).address as string;
const faucet = async (addr: string) => { try { await cliRun(["fund", addr]); } catch { /* daily faucet limit: use the existing balance */ } };
await faucet(ownerAddr);
let account = existsSync(acctFile) ? readFileSync(acctFile, "utf8").trim() : "";
const freshAccount = async () => {
  account = field(await cliRun(["account", "create", "--key", owner]), "account");
  (await import("node:fs")).writeFileSync(acctFile, account);
};
if (!account) await freshAccount();
await faucet(account);
const id = Date.now().toString(36);
let cred = `.metal/mandate-sourcing-${id}.json`; // metal-agent never overwrites a credential file
await run(cli, ["mandate", "credential", "create", "--principal", account, "--cap", "0.03", "--budget", "0.10", "--payee", payee, "--expires-in", "3600", "--description", "sourcing agent (metal:check)", "--key", owner, "--network", "testnet", "--out", cred], { env: process.env });
let bound: string;
try {
  bound = await cliRun(["mandate", "bind", "--credential", cred, "--key", owner]);
} catch (e: any) {
  if (!/another factory/.test(String(e.stderr ?? e.message))) throw e;
  await freshAccount(); await faucet(account);
  cred = `.metal/mandate-sourcing-${id}b.json`;
  await run(cli, ["mandate", "credential", "create", "--principal", account, "--cap", "0.03", "--budget", "0.10", "--payee", payee, "--expires-in", "3600", "--description", "sourcing agent (metal:check)", "--key", owner, "--network", "testnet", "--out", cred], { env: process.env });
  bound = await cliRun(["mandate", "bind", "--credential", cred, "--key", owner]);
}
ok(`spending limit bound on chain: 3 cents a payment, 0.10 *USDZ budget · ${field(bound, "explorer")}`);
const paid = await cliRun(["mandate", "pull", "--credential", cred, "--to", payee, "--amount", "0.02", "--payment-id", `check-${id}-ok`]);
ok(`2 cents paid under the limit · ${field(paid, "explorer")}`);
// Recording a refusal is a transaction from the owner key; retry briefly if it fails for another reason.
let refused = "";
for (let attempt = 1; ; attempt++) {
  try { refused = await cliRun(["mandate", "pull", "--credential", cred, "--to", payee, "--amount", "0.04", "--payment-id", `check-${id}-over`, "--record-refusal", "--key", owner]); break; }
  catch (e: any) {
    // metal-agent exits non-zero when a payment is refused; the recorded refusal is in its output.
    if (/^outcome refused/m.test(String(e.stdout ?? ""))) { refused = String(e.stdout); break; }
    if (attempt >= 3) fail(`recording the refusal failed: ${String(e.stderr || e.message).split("\n").filter((l) => l.trim() && !/Warning|trace-warnings/.test(l)).pop()}`); await new Promise((r) => setTimeout(r, 5000)); }
}
if (field(refused, "outcome") !== "refused") fail(`a 4-cent payment over the 3-cent cap was not refused:\n${refused}`);
ok(`4 cents refused by Metal (${field(refused, "reason").split(" ")[0]}), refusal recorded on chain, nothing moved · transaction ${field(refused, "transaction")}`);
const status = await cliRun(["mandate", "status", "--credential", cred]);
ok(`limit status read back: spent ${field(status, "spent")}, ${field(status, "payments")} payment(s)`);
