/**
 * npm run metal:withdraw — bring unspent clearing deposits from kit 12's live runs back to the
 * operator. Money leaves clearing after two finalities, each after a 5-minute challenge window:
 * the first run queues every final balance, a run ~5 minutes later claims what was queued.
 */
import "../core/env.ts";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { METAL_NETWORKS } from "@metalntwx/metal-pay";
import { openClearingWallet } from "@metalntwx/metal-pay/node";
import { withdrawRetrying } from "./clearing-port.ts";
import { METAL } from "./rail.ts";

const root = ".metal/clearing";
if (!existsSync(".metal/operator.json") || !existsSync(root)) { console.log("  · no live clearing runs to withdraw from"); process.exit(0); }
const operator = privateKeyToAccount(JSON.parse(readFileSync(".metal/operator.json", "utf8")).privateKey);
const sup = (await (await fetch(`${METAL_NETWORKS.testnet.facilitatorUrl}/supported`)).json()) as any;
const { settlement, serviceUrl } = sup.kinds.find((k: any) => k.scheme === "bajillion").extra;
const dirs = readdirSync(root).filter((d) => d.startsWith("run-")).flatMap((r) => readdirSync(`${root}/${r}`).map((j) => `${root}/${r}/${j}`));
let claimed = 0n;
for (const dir of dirs) {
  const wallet = await openClearingWallet(dir);
  try {
    const w = await withdrawRetrying({ rpcUrl: process.env.METAL_RPC_URL!, chainId: METAL.chainId, from: operator, settlement, signer: wallet.signer, serviceUrl, destination: operator.address });
    const got = w.status === "sent" ? w.claimed.reduce((s, c) => s + c.amount, 0n) : 0n;
    claimed += got;
    console.log(`  · ${dir.split("/").slice(-2).join("/")}: ${w.status}${w.status === "sent" ? ` · claimed ${Number(got / 10n ** 12n) / 1e6} *USDZ${w.queued ? " · queued the rest" : ""}` : w.status === "waiting" ? ` (queued; final after epoch ${w.epoch})` : ""}`);
  } catch (e) {
    console.log(`  ! ${dir}: ${(e as Error).message.split("\n")[0]}`);
  } finally {
    await wallet.close();
  }
}
console.log(`  ✔ claimed ${Number(claimed / 10n ** 12n) / 1e6} *USDZ back to the operator. Anything queued is claimable ~5 minutes from now: run this again.`);
