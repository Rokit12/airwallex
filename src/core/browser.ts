/**
 * Headless Chromium for the kits that shop a site (9 and 10).
 *
 * Locally this is Playwright's own Chromium (npm run setup:browser). On AWS
 * AgentCore Runtime there is no browser installed, so the deployment package
 * carries a serverless Chromium build for arm64 (CHROMIUM_PACK points at it)
 * and Playwright drives that instead. The kit code is the same either way.
 */
import { chromium, type Browser } from "playwright";

export async function launchBrowser(): Promise<Browser> {
  const pack = process.env.CHROMIUM_PACK;
  if (!pack) return chromium.launch();
  const { default: Chromium } = await import("@sparticuz/chromium-min");
  return chromium.launch({ executablePath: await Chromium.executablePath(pack), args: Chromium.args, headless: true });
}
