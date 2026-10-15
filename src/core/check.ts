/** Connection check from the hackathon guide: log in, list global accounts, list balances. */
import { AirwallexClient, AwxError } from "./client.ts";
import { Sandbox } from "./sandbox.ts";

const awx = new AirwallexClient();
const sb = new Sandbox(awx);
try {
  await awx.login();
  console.log("✔ login: bearer token received");
  const gas = await sb.globalAccounts();
  console.log(`✔ global accounts: ${gas.length}`, gas.map((g) => `${g.id} ${g.currency ?? ""} ${g.country_code ?? ""}`));
  console.log("✔ balances:", (await sb.balances()).map((b) => `${b.currency} ${b.available_amount}`).join(", ") || "(empty)");
  if (process.argv.includes("--fund")) {
    const usd = await sb.ensureUsd(25_000);
    console.log(`✔ funded: USD ${usd} available`);
  }
} catch (err) {
  if (err instanceof AwxError) {
    console.error(`✖ ${err.message}`);
    if (err.path === "/authentication/login") {
      console.error("  Check: Client ID / API key, key not IP-restricted, key scopes, business not 'In review'.");
    }
  } else console.error(err);
  process.exit(1);
}
