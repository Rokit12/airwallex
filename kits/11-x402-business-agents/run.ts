/**
 * Kit 11 — x402 Business Agents
 *
 * Customers' agents buy market data per query (5c), paid in *USDZ over x402 on
 * Metal. Three agents share 20 *USDZ under their own mandates (limits Metal enforces):
 *   SOURCING buys the upstream data (10 *USDZ, at most 3c a purchase), SUPPORT
 *   refunds customers (4), TREASURY moves earnings to Airwallex and pays a monthly
 *   licence fee invoiced in euros (6).
 *  1. Fund the account; the agents' budgets fit the 20 *USDZ and the balance.
 *  2. Sell queries; each buys upstream data at 2c.
 *  3. The upstream price rises to 4c, above the 3c cap: the next purchase is
 *     refused (nothing moves; the refusal is recorded on chain) and the customer's
 *     query is answered with an error, so its payment is never settled.
 *  4. Treasury proposes new limits within the 20 *USDZ (and a higher query price
 *     when the margin gets too thin); a person approves; mandates are replaced.
 *  5. A customer disputes a batch: its agent "never placed" them and some data was
 *     wrong. Each charge carries the agent's signed order (requireSignedOffer),
 *     stored with its transaction hash and verified against the payment
 *     (verifyMandatePayment); queries from the batch the upstream withdrew are
 *     refunded from support's budget, none twice.
 *  6. Sweep earnings to Airwallex with the Metal transaction hash as reference
 *     (never credited twice), convert USD to EUR, pay the licence fee by SWIFT.
 */
import { AirwallexClient, newRequestId, money } from "../../src/core/client.ts";
import { Sandbox } from "../../src/core/sandbox.ts";
import { say, usd } from "../../src/core/narrate.ts";
import { explain } from "../../src/core/llm.ts";
import { requestApproval, assertApproved, type Terms } from "../../src/core/approval.ts";
import { auditPath, audit } from "../../src/core/audit.ts";
import { openMandates } from "../../src/metal/rail.ts";
import { inBatches } from "../../src/metal/mandates.ts";
import { MetalRefused, type Address, type Mandate } from "../../src/metal/emulator.ts";
import { startMarketSeller, marketPay, verifySignedOrder, type MarketSeller } from "../../src/metal/market.ts";
import { fmt } from "../../src/metal/units.ts";
import { checkAllocation, proposeReallocation, sweepAmount, afterTimeout, depositDecision, resolveDisputedBatch, DEFAULT_POLICY, type AgentId, type AgentLimits, type AgentState, type DisputedCharge } from "./policy.ts";
import { API, UPSTREAM, BUYERS, OPENING_LIMITS, OPENING_BALANCE_CENTS, CALLS_BEFORE, CALLS_AFTER, REMAINING_CALLS_EXPECTED, BAD_BATCH_CALLS, DISPUTE, LICENCE } from "./fixtures.ts";

const awx = new AirwallexClient();
const sb = new Sandbox(awx);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (s: string) => `${s.slice(0, 10)}…${s.slice(-4)}`;
const sellers: MarketSeller[] = [];

try {
  say.title("Kit 11 · x402 Business Agents — three agents share 20 *USDZ; limits move when costs do");
  say.beat("goal", `Keep ${API.name} selling queries at a profit while three agents spend only within the 20 *USDZ of limits a person set.`);

  // ── Setup ────────────────────────────────────────────────────────────────
  say.beat("setup", "Fund the business's Metal account and give each agent its own key and limits.");
  const metal = await openMandates();
  const { chain, facilitator } = metal;
  const live = metal.mode === "live";
  const BUYER_FUNDS = 600; // each customer agent's account
  if (metal.mode === "live") {
    // One faucet top-up at most, to one key; every account below is funded from it (Metal's advice).
    const f = await metal.chain.ensureFunds(OPENING_BALANCE_CENTS + BUYERS.length * BUYER_FUNDS + 50);
    say.step(`funding key ${short(f.funder)} holds ${fmt(f.cents)}${f.faucet ? " after one faucet top-up" : " (no faucet call needed)"}; it funds every account in this run`);
  }
  const upstreamPayTo = chain.newPayee();
  const treasuryWallet = chain.newPayee(); // a Metal address the treasury controls, the bridge to Airwallex
  const owner = await chain.openAccount("owner", OPENING_BALANCE_CENTS); // the owner's MetalAccount; its key stays away from every agent
  say.step(`owner account ${short(owner)} · balance ${fmt(await chain.balanceOf(owner))} on ${chain.network}`);

  const alloc = checkAllocation(await chain.balanceOf(owner), OPENING_LIMITS);
  if (!alloc.ok) throw new Error(`budgets ${alloc.totalCents}c exceed the room ${alloc.roomCents}c`);
  say.decision("allocation", "FITS", `Agents may spend ${fmt(alloc.budgetsCents)} between them (the ceiling is ${fmt(DEFAULT_POLICY.agentCeilingCents)}), inside the ${fmt(alloc.roomCents)} balance left after the gas reserve. Metal checks each mandate alone, so the sum is checked in code.`);

  const payeesFor = (a: AgentId): Address[] => (a === "SOURCING" ? [upstreamPayTo] : a === "TREASURY" ? [treasuryWallet] : []);
  const terms = (l: AgentLimits) => ({ payees: l.payees === "LISTED" ? payeesFor(l.agent) : [], capCents: l.capCents, budgetCents: l.budgetCents, expiresAt: Date.now() + 30 * 86_400_000, description: `${l.agent.toLowerCase()} agent` });
  // The owner key signs each binding in turn (one key, one nonce sequence).
  const mandates = {} as Record<AgentId, Mandate>;
  mandates.SOURCING = await chain.bind(owner, "SOURCING", terms(OPENING_LIMITS[0]!));
  mandates.SUPPORT = await chain.bind(owner, "SUPPORT", terms(OPENING_LIMITS[1]!));
  mandates.TREASURY = await chain.bind(owner, "TREASURY", terms(OPENING_LIMITS[2]!));
  const limitsTable = async () =>
    say.table(await Promise.all((Object.keys(mandates) as AgentId[]).map(async (a) => {
      const s = await chain.status(mandates[a].id);
      const m = chain.mandate(mandates[a].id);
      return { agent: a, mandate: short(m.id), payees: m.payees.length ? "listed" : "any", cap: fmt(s.capCents), budget: fmt(s.budgetCents), spent: fmt(s.spentCents), payments: s.payments };
    })));
  await limitsTable();
  if (live) say.step(`limits bound on Metal testnet · ${chain.explorer("").replace(/\/tx\/$/, "")}/address/${owner}`);

  // Buyers are other businesses' agents paying from their own Metal accounts.
  const buyers = await Promise.all(BUYERS.map(async (name, i) => {
    const acct = await chain.openAccount(`buyer-${i + 1}`, BUYER_FUNDS);
    return { name, acct, mandate: await chain.bind(acct, `buyer:${name}`, { payees: [], capCents: 100, budgetCents: BUYER_FUNDS, expiresAt: Date.now() + 86_400_000, description: "buyer" }) };
  }));
  say.step(`${buyers.length} customer agents, each with its own Metal account and spending limit`);

  // ── x402 sellers ─────────────────────────────────────────────────────────
  // Live: the official x402 middleware with Metal's scheme; the query route requires the customer agent's
  // signed order (requireSignedOffer). A payment settles only after the handler succeeds.
  let upstreamPrice = UPSTREAM.priceCents;
  let apiPrice = API.priceCents;
  let call = 0; // queries started so far; each request carries its 1-based number in x-n
  const versionFor = (n: number) => (n >= BAD_BATCH_CALLS.from && n <= BAD_BATCH_CALLS.to ? UPSTREAM.badVersion : `feed-2026-10-28T${n < BAD_BATCH_CALLS.from ? "08" : "10"}`);
  const upstream = await startMarketSeller(chain, [
    { path: UPSTREAM.path, priceCents: () => upstreamPrice, payTo: upstreamPayTo, description: "reference price feed", handle: async (req) => ({ status: 200, body: { version: versionFor(Number(req.headers["x-n"])), quote: "EUR/USD 1.0842, Brent 81.20" } }) },
  ], () => {});
  sellers.push(upstream);

  const stats = { revenue: 0, upstream: 0, refunds: 0, served: 0, refused: 0 };
  /**
   * Every query, keyed by its payment: who paid, the query number, price and data version; once its payment
   * settles, the transaction hash, the customer agent's signed order and what was delivered (nothing else stores them).
   */
  const sales = new Map<string, { buyer: Address; n: number; priceCents: number; version: string; charged: boolean; tx?: string; signedOrder?: string; delivered?: unknown }>();
  const refunded = new Set<string>();
  const refund = async (to: Address, cents: number, why: string, paymentId: string) => {
    const ev = await chain.pull(mandates.SUPPORT.id, to, cents, { paymentId: `refund-${paymentId}` });
    stats.refunds += cents;
    refunded.add(paymentId);
    audit({ kind: "decision", subject: "refund", action: why, paymentId, cents });
    return ev;
  };
  const api = await startMarketSeller(chain, [{
    path: API.path,
    priceCents: () => apiPrice,
    payTo: owner,
    description: "One market-data query",
    signedOrders: true,
    handle: async (req, ctx) => {
      const n = Number(req.headers["x-n"]);
      const price = apiPrice;
      const upPrice = upstreamPrice;
      // A refusal within the cap is not the mandate's (for example a facilitator checking against a block that
      // trails the clock): a new payment a moment later is a fresh authorization, and nothing was paid before it.
      let up = await marketPay(chain, mandates.SOURCING.id, `${upstream.url}${UPSTREAM.path}`, { "x-n": String(n) });
      for (let attempt = 1; up.status === 402 && attempt <= 4 && upPrice <= (await chain.status(mandates.SOURCING.id)).capCents; attempt++) {
        await sleep(1500 * attempt);
        up = await marketPay(chain, mandates.SOURCING.id, `${upstream.url}${UPSTREAM.path}`, { "x-n": String(n) });
      }
      if (up.status === 200) {
        stats.upstream += upPrice;
        sales.set(ctx.paymentKey, { buyer: ctx.payer, n, priceCents: price, version: up.body.version, charged: false });
        return { status: 200, body: { data: up.body.quote, version: up.body.version } };
      }
      if (up.status !== 402) throw new Error(`upstream answered ${up.status}`);
      // Refused over the sourcing cap: nothing moved. Answer the customer with an error, so its payment is never settled.
      stats.refused += 1;
      sales.set(ctx.paymentKey, { buyer: ctx.payer, n, priceCents: price, version: "none", charged: false });
      say.warn(`sourcing refused by Metal: ${up.refusal?.reason ?? "refused"} (price ${fmt(upPrice)} over the ${fmt((await chain.status(mandates.SOURCING.id)).capCents)} cap)`);
      // Record the refusal on chain (the owner key submits it; it moves nothing) for the audit trail,
      // only when the mandate itself refuses this price: a pull within the cap would pay.
      let recorded: string | undefined;
      if (upPrice <= (await chain.status(mandates.SOURCING.id)).capCents) throw new Error(`upstream purchase for query ${n} refused within the cap: ${up.refusal?.reason ?? "unknown"}`);
      try { await chain.pull(mandates.SOURCING.id, upstreamPayTo, upPrice, { paymentId: `refused-query-${n}`, recordRefusal: true }); }
      catch (e) { if (!(e instanceof MetalRefused)) throw e; recorded = e.tx; say.step(`refusal recorded on chain: ${e.reason}${e.tx ? ` · ${live ? chain.explorer(e.tx) : short(e.tx)}` : ""}`); }
      audit({ kind: "decision", subject: "refused query", action: "ANSWER_ERROR_NOT_CHARGED", n, recorded });
      say.step(`query ${n} answered with an error: the customer's payment was not settled, so there is nothing to refund`);
      return { status: 503, body: { error: "upstream refused the purchase; you were not charged" } };
    },
  }], (sale) => {
    const q = sales.get(sale.paymentKey);
    if (q) Object.assign(q, { charged: true, tx: sale.tx, signedOrder: sale.signedOrder, delivered: sale.delivered });
    stats.revenue += sale.cents;
    stats.served += 1;
  });
  sellers.push(api);
  say.step(`x402 sellers up: ${API.name} at ${fmt(apiPrice)}/query (pays to the owner account; signed order required) · upstream ${UPSTREAM.name} at ${fmt(upstreamPrice)}/request`);

  async function serveOne(n: number) {
    const b = buyers[(n - 1) % buyers.length]!;
    // The customer's agent reads the 402 offer, signs the order and pays under its own mandate.
    let r = await marketPay(chain, b.mandate.id, `${api.url}${API.path}`, { "x-n": String(n) });
    // The facilitator answered success:false (rate_limited): the payment did not settle, so nothing was charged
    // and a new payment is safe. Any other unconfirmed outcome is not retried.
    for (let attempt = 1; r.status === 402 && r.refusal?.reason === "rate_limited" && attempt <= 5; attempt++) {
      await sleep(2000 * attempt);
      r = await marketPay(chain, b.mandate.id, `${api.url}${API.path}`, { "x-n": String(n) });
    }
    if (r.status === 200 || r.status === 503) return; // 503: upstream refused, customer not charged
    throw new Error(`buyer call failed: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  }
  /** Serve `count` queries; on Metal testnet many settle at once (each is its own pair of payments). */
  async function serve(count: number) {
    const ns = Array.from({ length: count }, (_, i) => call + i + 1);
    call += count;
    const t0 = Date.now();
    let done = 0;
    await inBatches(ns, chain.concurrency, async (n) => {
      await serveOne(n);
      done += 1;
      if (live && (done % 30 === 0 || done === count)) say.step(`${done}/${count} queries settled on Metal testnet (${Math.round((Date.now() - t0) / 1000)} s, ${chain.concurrency} at a time)`);
    });
  }

  // ── Serve ────────────────────────────────────────────────────────────────
  say.beat("serve", `Customers' agents buy queries at ${fmt(apiPrice)}; each sale buys upstream data at ${fmt(upstreamPrice)}.`);
  await serve(CALLS_BEFORE);
  say.ok(`${stats.served} queries sold · revenue ${fmt(stats.revenue)} · upstream ${fmt(stats.upstream)} · margin ${fmt(stats.revenue - stats.upstream)}`);

  // ── Price change ─────────────────────────────────────────────────────────
  say.beat("new information", "The upstream seller raises its price.");
  say.document(UPSTREAM.notice);
  upstreamPrice = UPSTREAM.raisedPriceCents;
  say.step(`the next 402 offer from ${UPSTREAM.name} asks ${fmt(upstreamPrice)}; the sourcing cap is ${fmt((await chain.status(mandates.SOURCING.id)).capCents)}`);
  await serve(1);

  say.beat("verify", "Read the sourcing agent's payments and refusals back from the chain.");
  const history = await chain.verify(mandates.SOURCING.id);
  const refusals = history.filter((e) => e.kind === "refusal");
  say.table(history.slice(-3).map((e) => ({ block: e.block, kind: e.kind, amount: fmt(e.cents ?? 0), reason: e.reason ?? "", tx: short(e.tx) })));
  say.ok(`chain shows ${history.length - refusals.length} payments and ${refusals.length} refusal (${refusals[0]?.reason}); the refusal moved nothing`);

  // ── Reallocate ───────────────────────────────────────────────────────────
  say.beat("plan", "Treasury proposes new limits that keep the API running and the sum inside the balance.");
  const states = (): Promise<AgentState[]> =>
    Promise.all((Object.keys(mandates) as AgentId[]).map(async (a) => {
      const s = await chain.status(mandates[a].id);
      return { agent: a, capCents: s.capCents, budgetCents: s.budgetCents, spentCents: s.spentCents, payees: chain.mandate(mandates[a].id).payees.length ? "LISTED" as const : "ANY" as const };
    }));
  const treasuryNeed = OPENING_LIMITS[2]!.budgetCents; // the whole treasury budget is earmarked for this month's sweep
  const before = await states();
  const r = proposeReallocation({ agents: before, balanceCents: await chain.balanceOf(owner), newUpstreamPriceCents: upstreamPrice, apiPriceCents: apiPrice, remainingCalls: REMAINING_CALLS_EXPECTED, treasuryNeedCents: treasuryNeed });
  say.step(`expected this period: ${REMAINING_CALLS_EXPECTED} more upstream requests × ${fmt(upstreamPrice)} = ${fmt(r.sourcingNeedCents)} · sourcing has ${fmt(before[0]!.budgetCents - before[0]!.spentCents)} left · treasury keeps its ${fmt(treasuryNeed)} for the earnings sweep`);
  say.decision("limits", r.action, await explain({ ...r }, r.reason));
  say.table(r.limits.map((l) => {
    const b = before.find((x) => x.agent === l.agent)!;
    return { agent: l.agent, cap: `${fmt(b.capCents)} → ${fmt(l.capCents)}`, budget: `${fmt(b.budgetCents)} → ${fmt(l.budgetCents)}`, spent: fmt(b.spentCents) };
  }));
  if (r.action !== "REALLOCATE") throw new Error(`policy chose ${r.action}; this demo expects a reallocation`);

  if (r.apiPriceCents !== apiPrice) say.step(`query price ${fmt(apiPrice)} → ${fmt(r.apiPriceCents)}: at ${fmt(upstreamPrice)} upstream the margin would be ${fmt(apiPrice - upstreamPrice)}, below the ${fmt(DEFAULT_POLICY.minMarginCents)} minimum`);
  const t: Terms = { action: "REPLACE_MANDATES", amount: r.shortfallCents / 100, currency: "USDZ", counterparty: "Metal account " + short(owner), limits: r.limits.map((l) => `${l.agent} cap ${l.capCents}c budget ${l.budgetCents}c`).join("; "), moves: r.moves.map((m) => `${m.cents}c from ${m.from}`).join(", "), query_price: `${r.apiPriceCents}c` };
  assertApproved(t, await requestApproval(t, "Approve the new spending limits? The owner key signs them; agents never hold it."));
  for (const l of r.limits) {
    const old = mandates[l.agent];
    const s = await chain.status(old.id);
    if (s.capCents === l.capCents && s.budgetCents === l.budgetCents) continue;
    mandates[l.agent] = await chain.replace(old.id, terms(l));
  }
  const fits = checkAllocation(await chain.balanceOf(owner), await states());
  if (!fits.ok) throw new Error("new limits exceed the balance");
  apiPrice = r.apiPriceCents;
  say.ok(`mandates replaced (spend carried over); budgets total ${fmt(fits.budgetsCents)} of the ${fmt(DEFAULT_POLICY.agentCeilingCents)} ceiling; agents may still spend ${fmt(fits.totalCents)}; queries now ${fmt(apiPrice)}`);
  await limitsTable();

  say.beat("serve", `Customers keep buying at ${fmt(apiPrice)}; sourcing now pays ${fmt(upstreamPrice)} within its new cap.`);
  const servedBefore = stats.served;
  await serve(CALLS_AFTER);
  say.ok(`${stats.served - servedBefore} more queries sold · total revenue ${fmt(stats.revenue)} · upstream ${fmt(stats.upstream)} · refunds ${fmt(stats.refunds)}`);

  // ── Disputed batch ───────────────────────────────────────────────────────
  say.beat("new information", "A customer disputes a batch of charges, and the upstream withdraws a batch of its data.");
  const disputer = buyers[DISPUTE.buyerIndex]!;
  say.document(DISPUTE.message);
  say.document(UPSTREAM.correction);
  // The customer's charges in the disputed range, plus the query the upstream refused (answered with an error);
  // an attempt whose settlement the facilitator refused was never charged and is not part of the batch.
  const disputed = [...sales.entries()].filter(([, v]) => v.buyer?.toLowerCase() === disputer.acct.toLowerCase() && v.n >= DISPUTE.fromCall && v.n <= DISPUTE.toCall && (v.charged || v.version === "none"));
  // The signed orders: each charge carries the customer agent's signed order; check it against the payment on chain.
  const checks = await inBatches(disputed, chain.concurrency, async ([id, v]) =>
    v.charged && v.tx ? verifySignedOrder(chain, disputer.mandate.id, { path: API.path, paymentKey: id, payer: v.buyer, cents: v.priceCents, tx: v.tx, signedOrder: v.signedOrder ?? "", delivered: v.delivered }) : { ok: false, detail: "never charged" });
  const charges: DisputedCharge[] = disputed.map(([id, v], i) => ({ paymentId: id, signedOnChain: checks[i]!.ok, dataVersion: v.version, alreadyRefunded: refunded.has(id), charged: v.charged }));
  const d = resolveDisputedBatch(charges, [UPSTREAM.badVersion], (id) => sales.get(id)!.priceCents);
  say.table(d.lines.map((l, i) => ({ query: sales.get(l.paymentId)!.n, signed_order: l.outcome === "NOT_CHARGED" ? "– (not charged)" : checks[i]!.ok ? `verified · ${short(sales.get(l.paymentId)!.tx!)}` : `✖ ${checks[i]!.detail.slice(0, 60)}`, data: l.dataVersion, outcome: l.outcome, refund: fmt(l.refundCents) })).sort((a, b) => a.query - b.query));
  const chargedCount = charges.filter((c) => c.charged !== false).length;
  say.decision("disputed batch", d.summary.noSuchCharge ? "PARTLY_UNPROVEN" : "SIGNED_BY_CUSTOMER", await explain({ ...d.summary, refundCents: d.refundCents }, `Each of the ${chargedCount} disputed charges carries ${disputer.name}'s signed order, verified against its payment on chain, so its agent did place them. ${d.summary.refund} returned data from the withdrawn batch ${UPSTREAM.badVersion}: refund those. ${d.summary.notCharged ? `${d.summary.notCharged} was never charged: the upstream refused it, so the customer's payment was not settled. ` : ""}The other ${d.summary.upheld} stand.`));
  await inBatches(d.lines.filter((x) => x.outcome === "REFUND_WRONG_DATA"), chain.concurrency, (l) => refund(disputer.acct, l.refundCents, "wrong data", l.paymentId));
  const supportLeft = await chain.status(mandates.SUPPORT.id);
  say.ok(`support refunded ${d.summary.refund} queries (${fmt(d.refundCents)}) from its own budget, each under its ${fmt(supportLeft.capCents)} cap · support has ${fmt(supportLeft.remainingCents)} left · no charge refunded twice`);

  // ── Treasury to Airwallex ────────────────────────────────────────────────
  say.beat("treasury", "Move earnings above what the agents may still spend to Airwallex, then pay the licence fee in euros.");
  const tStatus = await chain.status(mandates.TREASURY.id);
  const balanceNow = await chain.balanceOf(owner);
  const sweep = Math.min(sweepAmount(balanceNow, await states()), tStatus.capCents, tStatus.remainingCents);
  const sweepId = `sweep-${new Date().toISOString().slice(0, 10)}-${Date.now().toString(36)}`;
  say.step(`sweep ${fmt(sweep)}: balance ${fmt(balanceNow)} minus sourcing and support headroom and the gas reserve`);
  const sent = await chain.pull(mandates.TREASURY.id, treasuryWallet, sweep, { paymentId: sweepId });
  if (live) say.step(`payout on chain: ${chain.explorer(sent.tx)}`);
  say.step("Before any retry of a payout, the agent reads the chain: a lost answer must never become a second payment.");
  const onChain = (await chain.verify(mandates.TREASURY.id)).find((e) => e.paymentId === sweepId);
  const next = afterTimeout(onChain ? "paid" : "not_found");
  say.decision("sweep payout", next, onChain ? `Found on chain in block ${onChain.block} (${short(onChain.tx)}): already paid, so nothing is resent.` : "Not on chain: resend under the same payment id.");
  const again = await chain.pull(mandates.TREASURY.id, treasuryWallet, sweep, { paymentId: sweepId });
  say.step(`resending under the same payment id returns the same settlement (${again.tx === sent.tx ? "no second payment" : "NEW PAYMENT"})`);

  const ga = await sb.usdGlobalAccount();
  const refsOf = async () => {
    const d = await awx.get<any>("/deposits");
    const items: any[] = Array.isArray(d) ? d : (d.items ?? []);
    return items.map((x) => String(x.reference ?? x.payer?.reference ?? ""));
  };
  const dec1 = depositDecision(await refsOf(), sent.tx);
  say.decision("credit Airwallex", dec1, "The Airwallex sandbox cannot receive stablecoins: earnings stay at a Metal address we control and a deposit is simulated with the Metal transaction hash as its reference.");
  if (dec1 === "CREDIT") {
    const dep = await awx.post("/simulation/deposit/create", { global_account_id: ga, amount: sweep / 100, payer_name: "Metal earnings (treasury agent)", reference: sent.tx });
    say.ok(`Airwallex deposit ${dep.id} · ${usd(sweep / 100)} · reference ${short(sent.tx)}`);
  }
  let seen = false;
  for (let i = 0; i < 6 && !seen; i++) {
    seen = (await refsOf()).some((x) => x.toLowerCase() === sent.tx.toLowerCase());
    if (!seen) await sleep(1500);
  }
  const dec2 = depositDecision(await refsOf(), sent.tx);
  say.step(`a retry of the credit step reads GET /deposits first → ${dec2}${seen ? "" : " (deposit list not updated yet; the deposit id above is the record)"}`);
  audit({ kind: "decision", subject: "credit retry", action: dec2 });

  // Licence fee: kit 1's calls. Convert exactly the EUR needed (invoice plus the SWIFT fee), pay by SWIFT.
  const swiftFee = 12.85;
  const eurNeeded = money(LICENCE.amount + swiftFee);
  const quote = await awx.post("/fx/quotes/create", { request_id: newRequestId(), buy_currency: "EUR", sell_currency: "USD", buy_amount: eurNeeded, validity: "MIN_1" });
  const conv = await awx.post("/fx/conversions/create", { request_id: newRequestId(), quote_id: quote.quote_id, buy_currency: "EUR", sell_currency: "USD", buy_amount: eurNeeded });
  say.ok(`FX ${conv.status}: bought EUR ${conv.buy_amount} (invoice ${LICENCE.amount} + SWIFT fee ${swiftFee}) for USD ${conv.sell_amount} @ ${conv.client_rate ?? quote.client_rate}`);
  const ben = await awx.post("/beneficiaries/create", { request_id: newRequestId(), ...LICENCE.beneficiary });
  // A transient fee_unknown is retried with the same request_id, so the payout can never be created twice.
  const licenceRequestId = newRequestId();
  let tr: any;
  for (let attempt = 1; ; attempt++) {
    try { tr = await awx.post("/transfers/create", { request_id: licenceRequestId, beneficiary_id: ben.id ?? ben.beneficiary_id, transfer_amount: String(LICENCE.amount), transfer_currency: "EUR", source_currency: "EUR", transfer_method: "SWIFT", reference: LICENCE.invoice, reason: "professional_business_services" }); break; }
    catch (e) { if (attempt >= 4 || !/fee_unknown/.test(String((e as Error).message))) throw e; say.step(`Airwallex answered fee_unknown; retrying the same payout (same request id) in ${5 * attempt} s`); await sleep(5000 * attempt); }
  }
  await sb.advanceTransfer(tr.id, "SENT");
  const status = await sb.advanceTransfer(tr.id, "PAID");
  say.ok(`licence ${LICENCE.invoice}: EUR ${LICENCE.amount} to ${LICENCE.licensor} by SWIFT (fee ${tr.fee_amount ?? swiftFee}) → ${status}`);

  // ── Result ───────────────────────────────────────────────────────────────
  say.beat("result", metal.mode === "emulated" ? "Final state (Metal side EMULATED; Airwallex live)." : "Final state read back from Metal testnet and Airwallex.");
  await limitsTable();
  const finalStates = await states();
  const ownerNow = await chain.balanceOf(owner);
  const final = checkAllocation(ownerNow, finalStates);
  say.table([
    { item: "Query revenue (x402)", usdz: fmt(stats.revenue) },
    { item: "Upstream purchases", usdz: fmt(-stats.upstream) },
    { item: "Refunds", usdz: fmt(-stats.refunds) },
    { item: "Swept to Airwallex", usdz: fmt(-sweep) },
    { item: "Owner account now", usdz: fmt(ownerNow) },
    { item: "Budgets left, all agents", usdz: fmt(finalStates.reduce((s, a) => s + a.budgetCents - a.spentCents, 0)) },
  ]);
  const good = final.ok && status === "PAID" && refusals.length === 1;
  say[good ? "ok" : "fail"](`one refusal, no unapproved limit change, disputed batch resolved (${d.summary.refund} refunded, none twice), sweep paid once and credited once, licence fee ${status}; budgets ${fmt(final.budgetsCents)} within the ${fmt(DEFAULT_POLICY.agentCeilingCents)} ceiling and what agents may still spend (${fmt(final.totalCents)}) ${final.ok ? "fits" : "EXCEEDS"} the balance after gas (${fmt(final.roomCents)})`);
  say.step(`audit log: ${auditPath}`);
} finally {
  await Promise.all(sellers.map((s) => s.close()));
}
void money;
void MetalRefused;
