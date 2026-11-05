/**
 * Opens the Metal rail for kits 11 and 12.
 *
 * Live Metal testnet needs (1) network access to *.metalntwx.com and (2) an RPC
 * endpoint of your own from https://console-testnet.metalntwx.com, passed as
 * METAL_RPC_URL. With both, plain x402 payments settle on testnet (see
 * src/metal/live-seller.ts and `npm run metal:check`). Spending limits and
 * clearing fall back to the Metal emulator (src/metal/emulator.ts) when testnet is not
 * reachable. Kit 11's spending limits run live through openMandates() (src/metal/live-mandates.ts);
 * kit 12's clearing runs live through src/metal/clearing-port.ts.
 * Every emulated run says why; the Airwallex side always runs live.
 */
import { MetalChain, Clearing, newAddress } from "./emulator.ts";
import { Facilitator } from "./x402.ts";
import { say } from "../core/narrate.ts";
import { audit } from "../core/audit.ts";

export const METAL = {
  facilitatorUrl: "https://x402-testnet.metalntwx.com/x402/facilitator",
  faucetUrl: "https://faucet.metalntwx.com",
  explorerUrl: "https://testnet.metalntwx.com",
  chainId: 63825,
};

async function reachable(url: string) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    return r.status < 500;
  } catch {
    return false;
  }
}

export async function openMetal(withClearing = false) {
  const rpc = process.env.METAL_RPC_URL;
  const forced = process.env.METAL === "emulated" || process.env.RAILS === "emulated";
  let why = "";
  if (forced) why = "METAL=emulated";
  else if (!rpc) why = "no METAL_RPC_URL set (create an endpoint at console-testnet.metalntwx.com)";
  else if (!(await reachable(`${METAL.facilitatorUrl}/supported`))) why = "Metal testnet is not reachable from this machine (allow *.metalntwx.com)";
  else
    why = withClearing
      ? "Metal testnet is reachable, but this kit's live clearing adapter is not wired yet"
      : "Metal testnet is reachable and spending limits work there (npm run metal:check proves it), but this kit makes hundreds of payments and each on-chain one takes seconds and gas from a faucet that grants ten a day";
  if (process.env.METAL === "live" || process.env.RAILS === "live") throw new Error(`Metal live required but unavailable: ${why}`);
  say.warn(`Metal testnet: ${why}. Running the Metal side on the Metal emulator (documented limits, refusals, x402 offers${withClearing ? ", clearing epochs" : ""}); Airwallex stays live. Results labelled EMULATED.`);
  audit({ kind: "rail_switch", rail: "metal", to: "emulated", cause: why });
  const chain = new MetalChain();
  const clearing = withClearing ? new Clearing(chain, newAddress()) : undefined;
  return { mode: "emulated" as const, chain, clearing, facilitator: new Facilitator(chain, clearing), explorer: (tx: string) => `${METAL.explorerUrl}/tx/${tx} (emulated)` };
}

/**
 * Kit 11's rail: spending limits on Metal testnet when it is reachable with an RPC
 * endpoint, otherwise on the emulator (METAL=emulated forces it; METAL=live requires live).
 */
export async function openMandates() {
  const { EmulatedMandates } = await import("./mandates.ts");
  const { MandateFacilitator } = await import("./x402.ts");
  const rpc = process.env.METAL_RPC_URL;
  const forced = process.env.METAL === "emulated" || process.env.RAILS === "emulated";
  let why = "";
  if (forced) why = "METAL=emulated";
  else if (!rpc) why = "no METAL_RPC_URL set (create an endpoint at console-testnet.metalntwx.com)";
  else if (!(await reachable(`${METAL.facilitatorUrl}/supported`))) why = "Metal testnet is not reachable from this machine (allow *.metalntwx.com)";
  if (!why) {
    const { LiveMandates } = await import("./live-mandates.ts");
    const chain = new LiveMandates(rpc!);
    audit({ kind: "rail_switch", rail: "metal", to: "live" });
    return { mode: "live" as const, chain, facilitator: new MandateFacilitator(chain) };
  }
  if (process.env.METAL === "live" || process.env.RAILS === "live") throw new Error(`Metal live required but unavailable: ${why}`);
  say.warn(`Metal testnet: ${why}. Running the Metal side on the Metal emulator (documented limits, refusals, x402 offers); Airwallex stays live. Results labelled EMULATED.`);
  audit({ kind: "rail_switch", rail: "metal", to: "emulated", cause: why });
  const chain = new EmulatedMandates();
  return { mode: "emulated" as const, chain, facilitator: new MandateFacilitator(chain) };
}
