/**
 * Kit 9 — Approval-Bound Shopping Agent (buyer side)
 *
 * A shopper gives a need, a budget and a deadline. The agent shops a merchant
 * site in a real (headless) browser, builds the cart, and asks the shopper to
 * approve the exact product, merchant, delivery and total.
 *  - The merchant raises the price after approval: the agent pauses, keeps the
 *    same checkout, and asks again.
 *  - Payment credentials come from the credentials provider (the Airwallex
 *    sandbox test card, or the Airi CLI when AIRI_PAYMENT_METHOD_ID is set)
 *    straight into the hosted payment form.
 *  - The submission times out after the payment went through: the agent checks
 *    the order before retrying and does not pay twice, then reports the result.
 *
 * The merchant here is the local test storefront: real-merchant checkout needs
 * allowlisted Airi CLI access and a pre-funded card from Airwallex.
 */
import { launchBrowser } from "../../src/core/browser.ts";
import { RailsClient } from "../../src/core/rails.ts";
import { startStore } from "../../src/commerce/server.ts";
import { MERCHANT, DELIVERY } from "../../src/commerce/store.ts";
import { credentialsProvider, AiriRefused } from "../../src/commerce/credentials.ts";
import { say, usd } from "../../src/core/narrate.ts";
import { extract, explain } from "../../src/core/llm.ts";
import { requestApproval, assertApproved, type Terms } from "../../src/core/approval.ts";
import { auditPath } from "../../src/core/audit.ts";
import { choose, diffTerms, afterUnconfirmedSubmit, type Intent, type Offer, type ShownTerms } from "./policy.ts";

// Under USD 200 all-in: Airi's per-transaction limit for agent payments is USD 200 (Airwallex risk control).
const SHOPPER_REQUEST = `Hi! I need a 3-person tent for a family camping trip next weekend.
Keep it under $200 all-in, it has to arrive within 8 business days,
and I only buy from places that take returns.`;

const awx = new RailsClient();
const { store, url, close } = await startStore(awx);
const browser = await launchBrowser();
const page = await browser.newPage();
const provider = credentialsProvider();
/** A clean, already-narrated end of the run (for example, the shopper's wallet refused the payment). */
class StopRun extends Error {}
const num = async (sel: string) => Number(await page.getAttribute(sel, "data-value"));

try {
  say.title("Kit 9 · Approval-Bound Shopping Agent — buying a tent within approved terms");
  say.beat("goal", "Buy exactly what the shopper approves, ask again if anything changes, and never pay twice.");
  say.step(`merchant: ${MERCHANT.name} at ${url} (local test storefront) · payment credentials: ${provider.name}`);
  say.document(SHOPPER_REQUEST);
  const { value: intent } = await extract(
    "Extract JSON: need (string), budget (number, total including delivery), arriveWithinDays (number), returnsRequired (boolean).",
    SHOPPER_REQUEST,
    (v: any): v is Intent => v && typeof v.need === "string" && typeof v.budget === "number" && typeof v.arriveWithinDays === "number" && typeof v.returnsRequired === "boolean",
    () => ({ need: "3-person tent", budget: 200, arriveWithinDays: 8, returnsRequired: true }),
  );
  say.step(`intent: ${intent.need}, ≤ ${usd(intent.budget)} all-in, arrive ≤ ${intent.arriveWithinDays} business days, returns ${intent.returnsRequired ? "required" : "optional"}`);

  say.beat("shop", "Search the merchant site and read every matching product page.");
  await page.goto(url);
  await page.fill("#q", intent.need);
  await page.press("#q", "Enter");
  await page.waitForSelector(".result, li");
  const links = await page.$$eval(".result a", (as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")!));
  const offers: Offer[] = [];
  for (const href of links.slice(0, 6)) {
    await page.goto(url + href);
    offers.push({
      sku: href.split("/").pop()!,
      name: (await page.textContent("#name"))!.trim(),
      price: await num("#price"),
      shipsInDays: await num("#ships"),
      returnsAccepted: (await page.getAttribute("#returns", "data-value")) === "true",
      stock: await num("#stock"),
      rating: await num("#rating"),
    });
  }
  say.table(offers.map((o) => ({ sku: o.sku, product: o.name, price: o.price, ships_in: o.shipsInDays, returns: o.returnsAccepted, stock: o.stock, rating: o.rating })));
  const { pick, rejected } = choose(offers, [...DELIVERY], intent);
  for (const r of rejected) say.step(`rejected ${r.sku}: ${r.why}`);
  if (!pick) {
    say.warn("nothing fits the shopper's terms; ask the shopper before widening the search");
    process.exit(0);
  }
  say.decision("pick", `${pick.offer.name} · ${pick.delivery.id} · ${usd(pick.total)}`, await explain({ pick, intent }, `Best-rated option that arrives in ${pick.eta} business days and fits ${usd(intent.budget)} with returns.`));

  say.beat("cart", "Build the cart and read the checkout total from the page.");
  await page.goto(`${url}/product/${pick.offer.sku}`);
  await page.click("#add");
  await page.waitForSelector("#total");
  await page.check(`input[name=delivery][value=${pick.delivery.id}]`);
  await page.click("#update");
  await page.waitForSelector("#total");
  const ref = (await page.textContent("#ref"))!.trim();
  const shown = async (): Promise<ShownTerms> => ({ merchant: MERCHANT.name, sku: pick.offer.sku, product: pick.offer.name, delivery: pick.delivery.id, total: await num("#total"), currency: "USD" });
  const approvedTerms = await shown();
  const toTerms = (t: ShownTerms): Terms => ({ action: "BUY", amount: t.total, currency: t.currency, counterparty: t.merchant, product: `${t.sku} ${t.product}`, delivery: t.delivery, checkout: ref });
  let approval = await requestApproval(toTerms(approvedTerms), `Buy ${approvedTerms.product} from ${approvedTerms.merchant}, ${approvedTerms.delivery.toLowerCase()} delivery, ${usd(approvedTerms.total)} total?`);
  if (!approval) throw new Error("Shopper did not approve");

  say.beat("new information", "The merchant updates the tent's price before payment.");
  store.setPrice(pick.offer.sku, pick.offer.price + 4); // e.g. 185 → 189: still inside the budget, so the shopper is asked again
  await page.reload(); // always re-read the final total before paying
  const now = await shown();
  const changes = diffTerms(approvedTerms, now);
  let terms = toTerms(approvedTerms);
  if (changes.length) {
    say.decision("checkout", "PAUSE AND RE-ASK", `Terms changed after approval (${changes.join("; ")}). Keeping checkout ${ref} and the cart; asking the shopper again.`);
    terms = toTerms(now);
    if (now.total > intent.budget) {
      say.warn(`new total ${usd(now.total)} is over the shopper's budget; stopping without paying`);
      process.exit(0);
    }
    approval = await requestApproval(terms, `Price went up: ${changes.join("; ")}. Still buy for ${usd(now.total)}?`);
    if (!approval) throw new Error("Shopper declined the new price");
  }
  assertApproved(terms, approval);

  say.beat("pay", `Shopper authorized payment; get a mandate and one-time credentials from ${provider.name}.`);
  let mandate;
  try {
    mandate = await provider.createMandate({
      amount: terms.amount, currency: terms.currency, merchant: MERCHANT.name, merchantUrl: MERCHANT.url, merchantCountry: "US",
      item: { name: String(terms.product), unitPrice: terms.amount, quantity: 1 }, description: `${terms.product}, ${String(terms.delivery).toLowerCase()} delivery (checkout ${ref})`, termsHash: approval.termsHash,
    });
  } catch (e) {
    if (!(e instanceof AiriRefused)) throw e;
    // The shopper's own wallet said no. Its limits are the shopper's control: never split the order or switch cards to get around them.
    say.warn(`Airi refused the payment mandate: ${e.message}`);
    say.decision("pay", "STOP AND ASK THE SHOPPER", `The shopper's Airi wallet refused ${usd(terms.amount)} (${e.message}). The agent will not split the order or use another card to get under the limit. Nothing was charged; checkout ${ref} and the cart are kept so the shopper can raise the limit in Airi or choose a cheaper option.`);
    say.ok(`nothing charged · checkout ${ref} kept · the shopper decides`);
    throw new StopRun();
  }
  say.step(`mandate ${mandate.id} for ${usd(mandate.amount)} at ${mandate.merchant}, bound to terms ${mandate.termsHash}`);
  if (mandate.approvalUrl) say.warn(`confirm this payment in Airi with your passkey: ${mandate.approvalUrl} (the agent waits up to 5 minutes)`);
  await page.click("#pay");
  await page.waitForSelector("#paynow");
  const payTotal = await num("#total");
  if (payTotal !== terms.amount) throw new Error(`Payment page shows ${payTotal}, approved ${terms.amount}: stopping`);
  const card = await provider.credentials(mandate); // goes straight into the hosted form; never logged or shown to a model
  await page.fill("#number", card.number);
  await page.fill("#expiry_month", card.expiry_month);
  await page.fill("#expiry_year", card.expiry_year);
  await page.fill("#cvc", card.cvc);
  await page.fill("#cardname", card.name);
  say.step(`card fields filled from the provider (•••• ${card.number.slice(-4)})`);

  store.slowNextPaymentMs = 6000; // demo: the merchant's response is slow even though the payment completes
  let confirmed = false;
  try {
    await Promise.all([page.waitForURL(/\/orders\//, { timeout: 2500 }), page.click("#paynow", { noWaitAfter: true })]);
    confirmed = true;
  } catch {
    say.warn("payment submission timed out: outcome unconfirmed. Checking the order before doing anything else.");
  }

  say.beat("verify", "Read the order status from the merchant; retry only if no payment went through.");
  const check = await browser.newPage();
  await check.goto(`${url}/orders/${ref}`);
  let status = (await check.textContent("#status"))!.trim();
  for (let i = 0; i < 30 && afterUnconfirmedSubmit(status) === "WAIT"; i++) {
    if (i === 0) say.decision("after submit", "WAIT", "Merchant reports the payment is still PROCESSING. Paying again now could charge twice, so wait and re-read.");
    await new Promise((r) => setTimeout(r, 1000));
    await check.reload();
    status = (await check.textContent("#status"))!.trim();
  }
  const order = (await check.textContent("#order"))!.trim();
  const attempts = await check.$$eval(".attempt", (els) => els.length);
  const next = afterUnconfirmedSubmit(status);
  say.decision("after submit", next, `Merchant reports ${status}${order ? `, order ${order}` : ""}, ${attempts} payment attempt(s)${confirmed ? "" : " — the timeout was only a slow response"}.`);
  await provider.report(mandate, { status, order });
  say.step(`payment result reported to ${provider.name}: ${status}${order ? ` · ${order}` : ""}`);

  say.beat("result", awx.mode.payments === "emulated" ? "Outcome (merchant's card acceptance EMULATED on this account)." : "Outcome.");
  const co = store.getCheckout(ref)!;
  say.table([{ checkout: ref, product: co.items[0]!.name, delivery: co.delivery.id, approved_total: terms.amount, charged: co.status === "PAID" ? co.total : 0, attempts: co.attempts.length, order: co.orderNumber ?? "" }]);
  say[co.status === "PAID" && co.attempts.length === 1 && co.total === terms.amount ? "ok" : "fail"](`charged once, exactly the approved ${usd(terms.amount)} · order ${co.orderNumber}`);
  say.step(`audit log: ${auditPath}`);
} catch (e) {
  if (!(e instanceof StopRun)) throw e;
} finally {
  await browser.close();
  await close();
}
