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
 *     refused (recorded on chain) and the customer refunded.
 *  4. Treasury proposes new limits within the 20 *USDZ (and a higher query price
 *     when the margin gets too thin); a person approves; mandates are replaced.
 *  5. A customer disputes a batch: its agent "never placed" them and some data was
 *     wrong. The signed orders on chain show it did; queries from the batch the
 *     upstream withdrew are refunded from support's budget, none twice.
 *  6. Sweep earnings to Airwallex with the Metal transaction hash as reference
 *     (never credited twice), convert USD to EUR, pay the licence fee by SWIFT.
 */
import { AirwallexClient, newRequestId, money } from "../../src/core/client.ts";
import { Sandbox } from "../../src/core/sandbox.ts";
import { say, usd } from "../../src/core/narrate.ts";
import { explain } from "../../src/core/llm.ts";
import { requestApproval, assertApproved, type Terms } from "../../src/core/approval.ts";
import { auditPath, audit } from "../../src/core/audit.ts";
import { openMetal } from "../../src/metal/rail.ts";
import { newAddress, MetalRefused, type Address, type Mandate } from "../../src/metal/emulator.ts";
import { startSeller, payFetch, exactPayment, PaymentRefused, type Seller } from "../../src/metal/x402.ts";
import { fmt } from "../../src/metal/units.ts";
import { checkAllocation, proposeReallocation, sweepAmount, afterTimeout, depositDecision, resolveDisputedBatch, DEFAULT_POLICY, type AgentId, type AgentLimits, type AgentState, type DisputedCharge } from "./policy.ts";
import { API, UPSTREAM, BUYERS, OPENING_LIMITS, OPENING_BALANCE_CENTS, CALLS_BEFORE, CALLS_AFTER, REMAINING_CALLS_EXPECTED, BAD_BATCH_CALLS, DISPUTE, LICENCE } from "./fixtures.ts";

const awx = new AirwallexClient();
const sb = new Sandbox(awx);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (s: string) => `${s.slice(0, 10)}…${s.slice(-4)}`;
const sellers: Seller[] = [];

try {
  say.title("Kit 11 · x402 Business Agents — three agents share 20 *USDZ; limits move when costs do");
  say.beat("goal", `Keep ${API.name} selling queries at a profit while three agents spend only within the 20 *USDZ of limits a person set.`);

  // ── Setup ────────────────────────────────────────────────────────────────
  say.beat("setup", "Fund the business's Metal account and give each agent its own key and limits.");
  const metal = await openMetal();
  const { chain, facilitator } = metal;
  const owner = newAddress(); // the owner's MetalAccount; its key stays away from every agent
  const upstreamPayTo = newAddress();
  const treasuryWallet = newAddress(); // a Metal address the treasury controls, the bridge to Airwallex
  chain.faucet(owner, OPENING_BALANCE_CENTS);
  say.step(`owner account ${short(owner)} · balance ${fmt(chain.balanceOf(owner))} on ${chain.network}`);

  const alloc = checkAllocation(chain.balanceOf(owner), OPENING_LIMITS);
  if (!alloc.ok) throw new Error(`budgets ${alloc.totalCents}c exceed the room ${alloc.roomCents}c`);
  say.decision("allocation", "FITS", `Agents may spend ${fmt(alloc.budgetsCents)} between them (the ceiling is ${fmt(DEFAULT_POLICY.agentCeilingCents)}), inside the ${fmt(alloc.roomCents)} balance left after the gas reserve. Metal checks each mandate alone, so the sum is checked in code.`);

  const payeesFor = (a: AgentId): Address[] => (a === "SOURCING" ? [upstreamPayTo] : a === "TREASURY" ? [treasuryWallet] : []);
  const terms = (l: AgentLimits) => ({ payees: l.payees === "LISTED" ? payeesFor(l.agent) : [], capCents: l.capCents, budgetCents: l.budgetCents, expiresAt: Date.now() + 30 * 86_400_000, description: `${l.agent.toLowerCase()} agent` });
  const mandates: Record<AgentId, Mandate> = {
    SOURCING: chain.bind(owner, "SOURCING", terms(OPENING_LIMITS[0]!)),
    SUPPORT: chain.bind(owner, "SUPPORT", terms(OPENING_LIMITS[1]!)),
    TREASURY: chain.bind(owner, "TREASURY", terms(OPENING_LIMITS[2]!)),
  };
  const limitsTable = () =>
    say.table((Object.keys(mandates) as AgentId[]).map((a) => {
      const s = chain.status(mandates[a].id);
      const m = chain.mandate(mandates[a].id);
      return { agent: a, mandate: short(m.id), payees: m.payees.length ? "listed" : "any", cap: fmt(s.capCents), budget: fmt(s.budgetCents), spent: fmt(s.spentCents), payments: s.payments };
    }));
  limitsTable();

  // Buyers are other businesses' agents paying from their own Metal accounts.
  const buyers = BUYERS.map((name) => {
    const acct = newAddress();
    chain.faucet(acct, 2_000);
    return { name, acct, mandate: chain.bind(acct, `buyer:${name}`, { payees: [], capCents: 100, budgetCents: 2_000, expiresAt: Date.now() + 86_400_000, description: "buyer" }) };
  });

  // ── x402 sellers ─────────────────────────────────────────────────────────
  let upstreamPrice = UPSTREAM.priceCents;
  let apiPrice = API.priceCents;
  let call = 0; // 1-based number of the query being served
  const versionFor = (n: number) => (n >= BAD_BATCH_CALLS.from && n <= BAD_BATCH_CALLS.to ? UPSTREAM.badVersion : `feed-2026-10-28T${n < BAD_BATCH_CALLS.from ? "08" : "10"}`);
  const upstream = await startSeller(UPSTREAM.name, {
    [UPSTREAM.path]: { scheme: "exact", price: () => upstreamPrice, payTo: upstreamPayTo, description: "reference price feed", handle: () => ({ version: versionFor(call), quote: "EUR/USD 1.0842, Brent 81.20" }) },
  }, facilitator);
  sellers.push(upstream);

  const stats = { revenue: 0, upstream: 0, refunds: 0, served: 0, refused: 0 };
  /** Every sale: who paid, for which query, at what price, and which data version it returned. */
  const sales = new Map<string, { buyer: Address; n: number; priceCents: number; version: string }>();
  const refunded = new Set<string>();
  const refund = (to: Address, cents: number, why: string, paymentId: string) => {
    const ev = chain.pull(mandates.SUPPORT.id, to, cents, { paymentId: `refund-${paymentId}` });
    stats.refunds += cents;
    refunded.add(paymentId);
    audit({ kind: "decision", subject: "refund", action: why, paymentId, cents });
    return ev;
  };
  const api = await startSeller(API.name, {
    [API.path]: {
      scheme: "exact",
      price: () => apiPrice,
      payTo: owner,
      description: "One market-data query",
      handle: async (req) => {
        const buyer = String(req.headers["x-buyer"] ?? "") as Address;
        const paidId = String(req.headers["x-call"] ?? "");
        stats.revenue += apiPrice;
        try {
          const up = await payFetch<{ version: string; quote: string }>(`${upstream.url}${UPSTREAM.path}`, exactPayment(mandates.SOURCING.id));
          stats.upstream += up.price;
          stats.served += 1;
          sales.set(paidId, { buyer, n: call, priceCents: apiPrice, version: up.body.version });
          return { data: up.body.quote, version: up.body.version };
        } catch (err) {
          if (!(err instanceof PaymentRefused)) throw err;
          stats.refused += 1;
          sales.set(paidId, { buyer, n: call, priceCents: apiPrice, version: "none" });
          const ev = refund(buyer, apiPrice, "upstream refused", paidId);
          say.warn(`sourcing refused by Metal: ${err.reason} — ${err.detail}${err.tx ? ` · refusal recorded in ${short(err.tx)}` : ""}`);
          say.step(`support refunded ${fmt(apiPrice)} to the customer · ${short(ev.tx)}`);
          return { error: "upstream unavailable; refunded" };
        }
      },
    },
  }, facilitator);
  sellers.push(api);
  say.step(`x402 sellers up: ${API.name} at ${fmt(apiPrice)}/query (pays to the owner account) · upstream ${UPSTREAM.name} at ${fmt(upstreamPrice)}/request`);

  async function serve(n: number) {
    for (let i = 0; i < n; i++) {
      const b = buyers[call % buyers.length]!;
      call += 1;
      const pay = exactPayment(b.mandate.id);
      const res = await fetch(`${api.url}${API.path}`); // buyer reads the 402 offer…
      if (res.status !== 402) throw new Error("API should ask for payment first");
      const offer = JSON.parse(Buffer.from(res.headers.get("payment-required")!, "base64").toString()).accepts[0];
      const p = pay(offer); // …signs it under its own mandate, and repeats the request with the payment
      const paid = await fetch(`${api.url}${API.path}`, { headers: { "payment-signature": Buffer.from(JSON.stringify(p)).toString("base64"), "x-buyer": b.acct, "x-call": p.scheme === "exact" ? p.paymentId : "" } });
      if (!paid.ok) throw new Error(`buyer call failed: ${paid.status}`);
      await paid.json();
    }
  }

  // ── Serve ────────────────────────────────────────────────────────────────
  say.beat("serve", `Customers' agents buy queries at ${fmt(apiPrice)}; each sale buys upstream data at ${fmt(upstreamPrice)}.`);
  await serve(CALLS_BEFORE);
  say.ok(`${stats.served} queries sold · revenue ${fmt(stats.revenue)} · upstream ${fmt(stats.upstream)} · margin ${fmt(stats.revenue - stats.upstream)}`);

  // ── Price change ─────────────────────────────────────────────────────────
  say.beat("new information", "The upstream seller raises its price.");
  say.document(UPSTREAM.notice);
  upstreamPrice = UPSTREAM.raisedPriceCents;
  say.step(`the next 402 offer from ${UPSTREAM.name} asks ${fmt(upstreamPrice)}; the sourcing cap is ${fmt(chain.status(mandates.SOURCING.id).capCents)}`);
  await serve(1);

  say.beat("verify", "Read the sourcing agent's payments and refusals back from the chain.");
  const history = chain.verify(mandates.SOURCING.id);
  const refusals = history.filter((e) => e.kind === "refusal");
  say.table(history.slice(-3).map((e) => ({ block: e.block, kind: e.kind, amount: fmt(e.cents ?? 0), reason: e.reason ?? "", tx: short(e.tx) })));
  say.ok(`chain shows ${history.length - refusals.length} payments and ${refusals.length} refusal (${refusals[0]?.reason}); the refusal moved nothing`);

  // ── Reallocate ───────────────────────────────────────────────────────────
  say.beat("plan", "Treasury proposes new limits that keep the API running and the sum inside the balance.");
  const states = (): AgentState[] =>
    (Object.keys(mandates) as AgentId[]).map((a) => {
      const s = chain.status(mandates[a].id);
      return { agent: a, capCents: s.capCents, budgetCents: s.budgetCents, spentCents: s.spentCents, payees: chain.mandate(mandates[a].id).payees.length ? "LISTED" : "ANY" };
    });
  const treasuryNeed = OPENING_LIMITS[2]!.budgetCents; // the whole treasury budget is earmarked for this month's sweep
  const r = proposeReallocation({ agents: states(), balanceCents: chain.balanceOf(owner), newUpstreamPriceCents: upstreamPrice, apiPriceCents: apiPrice, remainingCalls: REMAINING_CALLS_EXPECTED, treasuryNeedCents: treasuryNeed });
  say.step(`expected this period: ${REMAINING_CALLS_EXPECTED} more upstream requests × ${fmt(upstreamPrice)} = ${fmt(r.sourcingNeedCents)} · sourcing has ${fmt(states()[0]!.budgetCents - states()[0]!.spentCents)} left · treasury keeps its ${fmt(treasuryNeed)} for the earnings sweep`);
  say.decision("limits", r.action, await explain({ ...r }, r.reason));
  const before = states();
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
    const s = chain.status(old.id);
    if (s.capCents === l.capCents && s.budgetCents === l.budgetCents) continue;
    mandates[l.agent] = chain.replace(old.id, terms(l));
  }
  const fits = checkAllocation(chain.balanceOf(owner), states());
  if (!fits.ok) throw new Error("new limits exceed the balance");
  apiPrice = r.apiPriceCents;
  say.ok(`mandates replaced (spend carried over); budgets total ${fmt(fits.budgetsCents)} of the ${fmt(DEFAULT_POLICY.agentCeilingCents)} ceiling; agents may still spend ${fmt(fits.totalCents)}; queries now ${fmt(apiPrice)}`);
  limitsTable();

  say.beat("serve", `Customers keep buying at ${fmt(apiPrice)}; sourcing now pays ${fmt(upstreamPrice)} within its new cap.`);
  const servedBefore = stats.served;
  await serve(CALLS_AFTER);
  say.ok(`${stats.served - servedBefore} more queries sold · total revenue ${fmt(stats.revenue)} · upstream ${fmt(stats.upstream)} · refunds ${fmt(stats.refunds)}`);

  // ── Disputed batch ───────────────────────────────────────────────────────
  say.beat("new information", "A customer disputes a batch of charges, and the upstream withdraws a batch of its data.");
  const disputer = buyers[DISPUTE.buyerIndex]!;
  say.document(DISPUTE.message);
  say.document(UPSTREAM.correction);
  const disputedIds = [...sales.entries()].filter(([, v]) => v.buyer === disputer.acct && v.n >= DISPUTE.fromCall && v.n <= DISPUTE.toCall).map(([id]) => id);
  // The signed orders: each charge is a payment the customer's own key signed under its own mandate.
  const signed = new Map(chain.verify(disputer.mandate.id).filter((e) => e.kind === "payment" && e.to === owner && e.paymentId).map((e) => [e.paymentId!, e]));
  const charges: DisputedCharge[] = disputedIds.map((id) => ({ paymentId: id, signedOnChain: signed.has(id), dataVersion: sales.get(id)!.version, alreadyRefunded: refunded.has(id) }));
  const d = resolveDisputedBatch(charges, [UPSTREAM.badVersion], (id) => sales.get(id)!.priceCents);
  say.table(d.lines.map((l) => ({ query: sales.get(l.paymentId)!.n, signed_order: l.signedOnChain ? `block ${signed.get(l.paymentId)!.block}` : "none", data: l.dataVersion, outcome: l.outcome, refund: fmt(l.refundCents) })));
  say.decision("disputed batch", d.summary.noSuchCharge ? "PARTLY_UNPROVEN" : "SIGNED_BY_CUSTOMER", await explain({ ...d.summary, refundCents: d.refundCents }, `All ${charges.length} disputed charges are payments signed under ${disputer.name}'s own mandate, so its agent did place them. ${d.summary.refund} returned data from the withdrawn batch ${UPSTREAM.badVersion}: refund those. ${d.summary.alreadyRefunded} was already refunded when the upstream refused it, so it is not refunded again. The other ${d.summary.upheld} stand.`));
  for (const l of d.lines.filter((x) => x.outcome === "REFUND_WRONG_DATA")) refund(disputer.acct, l.refundCents, "wrong data", l.paymentId);
  const supportLeft = chain.status(mandates.SUPPORT.id);
  say.ok(`support refunded ${d.summary.refund} queries (${fmt(d.refundCents)}) from its own budget, each under its ${fmt(supportLeft.capCents)} cap · support has ${fmt(supportLeft.remainingCents)} left · no charge refunded twice`);

  // ── Treasury to Airwallex ────────────────────────────────────────────────
  say.beat("treasury", "Move earnings above what the agents may still spend to Airwallex, then pay the licence fee in euros.");
  const sweep = Math.min(sweepAmount(chain.balanceOf(owner), states()), chain.status(mandates.TREASURY.id).capCents, chain.status(mandates.TREASURY.id).remainingCents);
  const sweepId = `sweep-${new Date().toISOString().slice(0, 10)}`;
  say.step(`sweep ${fmt(sweep)}: balance ${fmt(chain.balanceOf(owner))} minus sourcing and support headroom and the gas reserve`);
  const sent = chain.pull(mandates.TREASURY.id, treasuryWallet, sweep, { paymentId: sweepId });
  say.warn("the facilitator did not answer within 5 s: the payout is unconfirmed. Reading the chain before anything else.");
  const onChain = chain.verify(mandates.TREASURY.id).find((e) => e.paymentId === sweepId);
  const next = afterTimeout(onChain ? "paid" : "not_found");
  say.decision("sweep payout", next, onChain ? `Found on chain in block ${onChain.block} (${short(onChain.tx)}): already paid, so nothing is resent.` : "Not on chain: resend under the same payment id.");
  const again = chain.pull(mandates.TREASURY.id, treasuryWallet, sweep, { paymentId: sweepId });
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
  const tr = await awx.post("/transfers/create", { request_id: newRequestId(), beneficiary_id: ben.id ?? ben.beneficiary_id, transfer_amount: String(LICENCE.amount), transfer_currency: "EUR", source_currency: "EUR", transfer_method: "SWIFT", reference: LICENCE.invoice, reason: "professional_business_services" });
  await sb.transferTransition(tr.id, "SENT");
  await sb.transferTransition(tr.id, "PAID").catch(() => {});
  let status = "";
  for (let i = 0; i < 8; i++) {
    status = (await awx.get(`/transfers/${tr.id}`)).status;
    if (status === "PAID") break;
    await sleep(1500);
  }
  say.ok(`licence ${LICENCE.invoice}: EUR ${LICENCE.amount} to ${LICENCE.licensor} by SWIFT (fee ${tr.fee_amount ?? swiftFee}) → ${status}`);

  // ── Result ───────────────────────────────────────────────────────────────
  say.beat("result", metal.mode === "emulated" ? "Final state (Metal side EMULATED; Airwallex live)." : "Final state read back from Metal and Airwallex.");
  limitsTable();
  const final = checkAllocation(chain.balanceOf(owner), states());
  say.table([
    { item: "Query revenue (x402)", usdz: fmt(stats.revenue) },
    { item: "Upstream purchases", usdz: fmt(-stats.upstream) },
    { item: "Refunds", usdz: fmt(-stats.refunds) },
    { item: "Swept to Airwallex", usdz: fmt(-sweep) },
    { item: "Owner account now", usdz: fmt(chain.balanceOf(owner)) },
    { item: "Budgets left, all agents", usdz: fmt(states().reduce((s, a) => s + a.budgetCents - a.spentCents, 0)) },
  ]);
  const good = final.ok && status === "PAID" && refusals.length === 1;
  say[good ? "ok" : "fail"](`one refusal, no unapproved limit change, disputed batch resolved (${d.summary.refund} refunded, none twice), sweep paid once and credited once, licence fee ${status}; budgets ${fmt(final.budgetsCents)} within the ${fmt(DEFAULT_POLICY.agentCeilingCents)} ceiling and what agents may still spend (${fmt(final.totalCents)}) ${final.ok ? "fits" : "EXCEEDS"} the balance after gas (${fmt(final.roomCents)})`);
  say.step(`audit log: ${auditPath}`);
} finally {
  await Promise.all(sellers.map((s) => s.close()));
}
void money;
void MetalRefused;
