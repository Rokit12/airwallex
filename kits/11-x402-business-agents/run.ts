/**
 * Kit 11 — x402 Business Agents
 *
 * Trailhead sells a trail-conditions API to other agents, paid per call in *USDZ
 * over x402 on Metal. Three agents run the business from one Metal account, each
 * under its own mandate (spending limits Metal enforces):
 *   SOURCING buys upstream forecasts, SUPPORT refunds buyers, TREASURY moves
 *   earnings to Airwallex and pays a contractor's monthly GBP invoice.
 *  1. Fund the account, give each agent limits whose sum fits the balance.
 *  2. Serve buyers while buying upstream; refund a call.
 *  3. The upstream seller raises its price above the sourcing cap: the next
 *     purchase is refused (and recorded on chain), the buyer is refunded.
 *  4. Treasury proposes new limits; a person approves; mandates are replaced.
 *  5. Sweep earnings to a Metal address, credit them to Airwallex with the
 *     transaction hash as reference (never twice), convert, pay the invoice.
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
import { checkAllocation, proposeReallocation, sweepAmount, afterTimeout, depositDecision, type AgentId, type AgentLimits, type AgentState } from "./policy.ts";
import { API, UPSTREAM, BUYERS, OPENING_LIMITS, OPENING_BALANCE_CENTS, CALLS_BEFORE, CALLS_AFTER, REMAINING_CALLS_EXPECTED, CONTRACTOR } from "./fixtures.ts";

const awx = new AirwallexClient();
const sb = new Sandbox(awx);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (s: string) => `${s.slice(0, 10)}…${s.slice(-4)}`;
const sellers: Seller[] = [];

try {
  say.title("Kit 11 · x402 Business Agents — one Metal account, three agents, limits that move when costs do");
  say.beat("goal", `Keep ${API.name} answering buyers at a profit while three agents spend only within the limits a person set.`);

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
  say.decision("allocation", "FITS", `Agents may spend ${fmt(alloc.totalCents)} of ${fmt(alloc.roomCents)} available after the gas reserve; ${fmt(alloc.unallocatedCents)} left unallocated. Metal checks each mandate alone, so this sum is checked in code.`);

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
  const upstream = await startSeller(UPSTREAM.name, {
    [UPSTREAM.path]: { scheme: "exact", price: () => upstreamPrice, payTo: upstreamPayTo, description: "7-day mountain forecast", handle: () => ({ forecast: "clear, 4°C at summit, wind 18 km/h" }) },
  }, facilitator);
  sellers.push(upstream);

  const stats = { revenue: 0, upstream: 0, refunds: 0, served: 0, refused: 0 };
  const refund = (to: Address, cents: number, why: string, paymentId: string) => {
    const ev = chain.pull(mandates.SUPPORT.id, to, cents, { paymentId });
    stats.refunds += cents;
    return ev;
  };
  const api = await startSeller(API.name, {
    [API.path]: {
      scheme: "exact",
      price: () => API.priceCents,
      payTo: owner,
      description: "Trail conditions for one route",
      handle: async (req) => {
        const buyer = String(req.headers["x-buyer"] ?? "");
        const paidId = String(req.headers["x-call"] ?? "");
        stats.revenue += API.priceCents;
        try {
          const up = await payFetch<{ forecast: string }>(`${upstream.url}${UPSTREAM.path}`, exactPayment(mandates.SOURCING.id));
          stats.upstream += up.price;
          stats.served += 1;
          return { route: "Mount Tamalpais loop", conditions: up.body.forecast };
        } catch (err) {
          if (!(err instanceof PaymentRefused)) throw err;
          stats.refused += 1;
          const ev = refund(buyer as Address, API.priceCents, "upstream refused", `refund-${paidId}`);
          say.warn(`sourcing refused by Metal: ${err.reason} — ${err.detail}${err.tx ? ` · refusal recorded in ${short(err.tx)}` : ""}`);
          say.step(`support refunded ${fmt(API.priceCents)} to the buyer · ${short(ev.tx)}`);
          return { error: "upstream unavailable; refunded" };
        }
      },
    },
  }, facilitator);
  sellers.push(api);
  say.step(`x402 sellers up: ${API.name} at ${fmt(API.priceCents)}/call (pays to the owner account) · upstream ${UPSTREAM.name} at ${fmt(upstreamPrice)}/call`);

  let call = 0;
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
  say.beat("serve", `Buyer agents call the API; each paid call buys one upstream forecast at ${fmt(upstreamPrice)}.`);
  await serve(CALLS_BEFORE);
  say.ok(`${stats.served} calls served · revenue ${fmt(stats.revenue)} · upstream ${fmt(stats.upstream)} · margin ${fmt(stats.revenue - stats.upstream)}`);
  const complaint = buyers[1]!;
  const ev1 = refund(complaint.acct, API.priceCents, "stale answer", "refund-complaint-1");
  say.ok(`${complaint.name} reported a stale answer: support refunded ${fmt(API.priceCents)} (any payee, under its ${fmt(OPENING_LIMITS[1]!.capCents)} cap) · ${short(ev1.tx)}`);

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
  const gbpRate = Number((await awx.get("/fx/rates/current", { query: { buy_currency: "GBP", sell_currency: "USD", buy_amount: CONTRACTOR.amount } })).rate);
  const invoiceUsdCents = Math.ceil(CONTRACTOR.amount * gbpRate * 100);
  const treasuryNeed = sweepAmount(chain.balanceOf(owner), states());
  const r = proposeReallocation({ agents: states(), balanceCents: chain.balanceOf(owner), newUpstreamPriceCents: upstreamPrice, apiPriceCents: API.priceCents, remainingCalls: REMAINING_CALLS_EXPECTED, treasuryNeedCents: treasuryNeed });
  say.step(`expected this period: ${REMAINING_CALLS_EXPECTED} more upstream calls × ${fmt(upstreamPrice)} = ${fmt(r.sourcingNeedCents)} · sourcing has ${fmt(states()[0]!.budgetCents - states()[0]!.spentCents)} left · treasury needs ${fmt(treasuryNeed)} (invoice ≈ ${usd(invoiceUsdCents / 100)} at ${gbpRate} USD/GBP)`);
  say.decision("limits", r.action, await explain({ ...r }, r.reason));
  const before = states();
  say.table(r.limits.map((l) => {
    const b = before.find((x) => x.agent === l.agent)!;
    return { agent: l.agent, cap: `${fmt(b.capCents)} → ${fmt(l.capCents)}`, budget: `${fmt(b.budgetCents)} → ${fmt(l.budgetCents)}`, spent: fmt(b.spentCents) };
  }));
  if (r.action !== "REALLOCATE") throw new Error(`policy chose ${r.action}; this demo expects a reallocation`);

  const t: Terms = { action: "REPLACE_MANDATES", amount: r.shortfallCents / 100, currency: "USDZ", counterparty: "Metal account " + short(owner), limits: r.limits.map((l) => `${l.agent} cap ${l.capCents}c budget ${l.budgetCents}c`).join("; "), moves: r.moves.map((m) => `${m.cents}c from ${m.from}`).join(", ") };
  assertApproved(t, await requestApproval(t, "Approve the new spending limits? The owner key signs them; agents never hold it."));
  for (const l of r.limits) {
    const old = mandates[l.agent];
    const s = chain.status(old.id);
    if (s.capCents === l.capCents && s.budgetCents === l.budgetCents) continue;
    mandates[l.agent] = chain.replace(old.id, terms(l));
  }
  const fits = checkAllocation(chain.balanceOf(owner), states());
  if (!fits.ok) throw new Error("new limits exceed the balance");
  say.ok(`mandates replaced (spend carried over); agents may still spend ${fmt(fits.totalCents)} of ${fmt(fits.roomCents)}`);
  limitsTable();

  say.beat("serve", `Buyers keep calling; sourcing now pays ${fmt(upstreamPrice)} within its new cap.`);
  const servedBefore = stats.served;
  await serve(CALLS_AFTER);
  say.ok(`${stats.served - servedBefore} more calls served · total revenue ${fmt(stats.revenue)} · upstream ${fmt(stats.upstream)} · refunds ${fmt(stats.refunds)}`);

  // ── Treasury to Airwallex ────────────────────────────────────────────────
  say.beat("treasury", "Move earnings above what the agents may still spend to Airwallex, then pay the contractor.");
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

  // Contractor invoice: convert exactly the GBP needed, pay by Faster Payments.
  const quote = await awx.post("/fx/quotes/create", { request_id: newRequestId(), buy_currency: "GBP", sell_currency: "USD", buy_amount: CONTRACTOR.amount, validity: "MIN_1" });
  const conv = await awx.post("/fx/conversions/create", { request_id: newRequestId(), quote_id: quote.quote_id, buy_currency: "GBP", sell_currency: "USD", buy_amount: CONTRACTOR.amount });
  say.ok(`FX ${conv.status}: bought GBP ${conv.buy_amount} for USD ${conv.sell_amount} @ ${conv.client_rate ?? quote.client_rate}`);
  const ben = await awx.post("/beneficiaries/create", { request_id: newRequestId(), ...CONTRACTOR.beneficiary });
  const tr = await awx.post("/transfers/create", { request_id: newRequestId(), beneficiary_id: ben.id ?? ben.beneficiary_id, transfer_amount: String(CONTRACTOR.amount), transfer_currency: "GBP", source_currency: "GBP", transfer_method: "LOCAL", reference: CONTRACTOR.invoice, reason: "professional_business_services" });
  await sb.transferTransition(tr.id, "SENT");
  await sb.transferTransition(tr.id, "PAID").catch(() => {});
  let status = "";
  for (let i = 0; i < 8; i++) {
    status = (await awx.get(`/transfers/${tr.id}`)).status;
    if (status === "PAID") break;
    await sleep(1500);
  }
  say.ok(`invoice ${CONTRACTOR.invoice}: GBP ${CONTRACTOR.amount} to ${CONTRACTOR.name} by Faster Payments → ${status}`);

  // ── Result ───────────────────────────────────────────────────────────────
  say.beat("result", metal.mode === "emulated" ? "Final state (Metal side EMULATED; Airwallex live)." : "Final state read back from Metal and Airwallex.");
  limitsTable();
  const final = checkAllocation(chain.balanceOf(owner), states());
  say.table([
    { item: "API revenue (x402)", usdz: fmt(stats.revenue) },
    { item: "Upstream purchases", usdz: fmt(-stats.upstream) },
    { item: "Refunds", usdz: fmt(-stats.refunds) },
    { item: "Swept to Airwallex", usdz: fmt(-sweep) },
    { item: "Owner account now", usdz: fmt(chain.balanceOf(owner)) },
    { item: "Budgets left, all agents", usdz: fmt(states().reduce((s, a) => s + a.budgetCents - a.spentCents, 0)) },
  ]);
  say[final.ok ? "ok" : "fail"](`one refusal, no unapproved limit change, sweep paid once and credited once, invoice ${status}; what agents may still spend (${fmt(final.totalCents)}) ${final.ok ? "fits" : "EXCEEDS"} the balance after gas (${fmt(final.roomCents)})`);
  say.step(`audit log: ${auditPath}`);
} finally {
  await Promise.all(sellers.map((s) => s.close()));
}
void money;
void MetalRefused;
