/**
 * Kit 12 — Inference Sourcing Agent
 *
 * An AI service writes research reports. Every step (model paragraphs, searches,
 * data lookups) is bought from x402 providers by clearing on Metal: one deposit
 * per job, each payment signs the job key's running total. Customers pay by card
 * through Airwallex: a pre-authorized hold for their budget, captured at what the
 * job actually spent.
 *  1. Three providers per kind, different prices; hold each customer's card.
 *  2. Deposit into clearing per job (deposits count from the next epoch).
 *  3. Run three jobs at once, routing every step by the latest 402 price.
 *  4. Midway: job B's prompt uses 4× its tokens, the budget model slows, job C's
 *     filings cannot be found. Re-route, raise B's hold, ration the float.
 *  5. Capture what each job spent (once, never above the hold), cancel the failed
 *     job's hold, withdraw unused deposits after their epoch closes.
 */
import { AirwallexClient, newRequestId } from "../../src/core/client.ts";
import { say, usd } from "../../src/core/narrate.ts";
import { explain } from "../../src/core/llm.ts";
import { requestApproval, assertApproved, type Terms } from "../../src/core/approval.ts";
import { auditPath, audit } from "../../src/core/audit.ts";
import { newAddress } from "../../src/metal/emulator.ts";
import { PaymentRefused } from "../../src/metal/x402.ts";
import { emulatedClearing, liveClearing, liveClearingAvailable, type ClearingPort } from "../../src/metal/clearing-port.ts";
import { fmt, fmtMicros } from "../../src/metal/units.ts";
import { route, minCostToFinish, overrun, rationFloat, settleHold, DEFAULT_POLICY as P, type ProviderView, type Step } from "./policy.ts";
import { PROVIDERS, JOBS, FLOAT_CENTS, OVERRUN, MISSING_FILINGS, SLOW_LATENCY_MS, type JobSpec } from "./fixtures.ts";

const awx = new AirwallexClient();
let cp: ClearingPort | undefined;
const TEST_CARD = { number: "4035501000000008", expiry_month: "12", expiry_year: "2030", cvc: "123" };

interface Job extends JobSpec {
  key: string;
  intent: string;
  hold: number;
  stepIndex: number;
  chunksDone: number;
  failed: boolean;
  emptyLookups: number;
  spentByProvider: Record<string, number>;
}

try {
  say.title("Kit 12 · Inference Sourcing Agent — buy every AI step at the live price, within each customer's hold");
  say.beat("goal", "Finish three research jobs inside their card holds, paying providers per paragraph, search and lookup by clearing, with a 1.50 *USDZ float smaller than the 2.50 the holds could spend.");

  // ── Providers ────────────────────────────────────────────────────────────
  say.beat("setup", "Start the x402 providers, hold each customer's card, deposit into clearing per job.");
  // Metal clearing: live on testnet when its clearing service is reachable, otherwise the emulator.
  const forced = process.env.METAL === "emulated" || process.env.RAILS === "emulated";
  const avail = forced ? { ok: false, why: "METAL=emulated" } : await liveClearingAvailable();
  if (avail.ok) {
    cp = await liveClearing(FLOAT_CENTS, (avail as any).extra);
    say.ok("Metal clearing: live on testnet (each job is its own clearing wallet; payments sign running totals off chain; epochs every few seconds)");
  } else {
    if (process.env.METAL === "live" || process.env.RAILS === "live") throw new Error(`Metal clearing live required but unavailable: ${avail.why}`);
    say.warn(`Metal clearing: ${avail.why}. Running clearing on the Metal emulator (documented deposits, epochs, refusals and withdrawals); Airwallex stays live. Results labelled EMULATED.`);
    audit({ kind: "rail_switch", rail: "metal-clearing", to: "emulated", cause: avail.why });
    cp = emulatedClearing(FLOAT_CENTS);
  }
  const clearing = cp;
  const live = Object.fromEntries(PROVIDERS.map((p) => [p.id, { price: p.priceMicros, latency: p.latencyMs, observed: p.latencyMs }]));
  let missingFilingsFor: string | null = null;
  await clearing.startProviders(PROVIDERS.map((p) => ({
    id: p.id,
    name: p.name,
    description: `one ${p.kind === "model" ? "paragraph" : p.kind === "search" ? "search" : "lookup"}`,
    priceMicros: () => live[p.id]!.price,
    latencyMs: () => live[p.id]!.latency,
    handle: (job: string | null) => {
      if (p.kind === "data" && job === missingFilingsFor) return { found: false };
      return { found: true, text: p.kind === "model" ? "…stand-in text for one paragraph…" : p.kind === "search" ? "3 results" : "1 filing" };
    },
  })));
  say.table(PROVIDERS.map((p) => ({ provider: p.id, kind: p.kind, tier: p.tier, "price per unit": fmtMicros(p.priceMicros), clearing: "yes" })));

  // ── Holds and deposits ───────────────────────────────────────────────────
  const jobs: Job[] = [];
  for (const spec of JOBS) {
    const pi = await awx.post("/pa/payment_intents/create", { request_id: newRequestId(), amount: spec.holdCents / 100, currency: "USD", merchant_order_id: `JOB-${spec.id}-${Date.now().toString(36).toUpperCase()}`, descriptor: "TRAILHEAD RESEARCH" });
    const held = await awx.post(`/pa/payment_intents/${pi.id}/confirm`, { request_id: newRequestId(), payment_method: { type: "card", card: { ...TEST_CARD, name: spec.customer } }, payment_method_options: { card: { authorization_type: "pre_auth", auto_capture: false } } });
    const key = `job-${spec.id}-${newAddress().slice(2, 10)}`;
    await clearing.openJob(key);
    jobs.push({ ...spec, key, intent: pi.id, hold: spec.holdCents, stepIndex: 0, chunksDone: 0, failed: false, emptyLookups: 0, spentByProvider: {} });
    say.step(`job ${spec.id} · ${spec.customer} · "${spec.title}" · card hold ${usd(spec.holdCents / 100)} → ${held.status}`);
  }
  say.step(`float ${fmt(clearing.floatCents())} covers less than the holds combined (${usd(JOBS.reduce((s, j) => s + j.holdCents, 0) / 100)}); floor ${fmtMicros(P.floatFloorMicros)}`);
  for (const j of jobs) await clearing.deposit(j.key, j.depositCents);
  say.table(jobs.map((j) => ({ job: j.id, deposit: fmt(j.depositCents), counts_from_epoch: clearing.epoch + 1 })));
  say.step(`float left ${fmt(clearing.floatCents())}. Deposits count from the next epoch, so nothing can be spent until epoch ${clearing.epoch} closes.`);
  await clearing.nextEpoch();
  say.ok(`epoch closed → epoch ${clearing.epoch}; each job key can now spend its deposit`);

  // ── Run ──────────────────────────────────────────────────────────────────
  const views = (): ProviderView[] => PROVIDERS.map((p) => ({ id: p.id, kind: p.kind, tier: p.tier, priceMicros: live[p.id]!.price, latencyMs: live[p.id]!.observed, up: true }));
  const restOf = (j: Job): Step[] => j.steps.slice(j.stepIndex + 1);
  const remainingOf = (j: Job, s: Step): Step => ({ ...s, chunks: s.chunks - j.chunksDone });

  /** Buy one chunk for a job from a provider, reading its 402 offer first. */
  async function buy(j: Job, providerId: string) {
    const lp = live[providerId]!;
    const res = await clearing.buy<{ found: boolean }>(j.key, providerId, j.id);
    lp.price = res.priceMicros; // the offer is the price; nothing cached beyond this request
    lp.observed = Math.round(lp.observed * 0.3 + res.providerMs * 0.7); // the provider's own answer time, not payment settlement
    j.spentByProvider[providerId] = (j.spentByProvider[providerId] ?? 0) + res.priceMicros;
    return res;
  }

  const routed = new Map<string, string>();
  /** Run up to `limit` chunks of a job's current step. Returns false when the job cannot go on. */
  async function advance(j: Job, limit: number): Promise<"ok" | "done" | "blocked" | "failed"> {
    if (j.failed) return "failed";
    const s = j.steps[j.stepIndex];
    if (!s) return "done";
    const step = remainingOf(j, s);
    const available = j.hold * 10_000 - clearing.spent(j.key) - minCostToFinish(restOf(j), views());
    const r = route(step, views(), available);
    const tag = `${j.id}:${s.id}`;
    if (routed.get(tag) !== r.provider) {
      say.decision(`job ${j.id} ${s.id}`, r.provider ?? "NO ROUTE", `${step.chunks} ${step.kind === "model" ? "paragraph" : step.kind === "search" ? "search" : "lookup"}(s), ${fmtMicros(r.costMicros)} at the latest offer: ${r.reason}.`);
      routed.set(tag, r.provider ?? "");
    }
    if (!r.provider) return "blocked";
    for (let n = 0; n < limit && j.chunksDone < s.chunks; n++) {
      try {
        const res = await buy(j, r.provider);
        j.chunksDone += 1;
        if (s.kind === "data" && !res.body.found) {
          j.emptyLookups += 1;
          if (j.emptyLookups >= MISSING_FILINGS.after) {
            j.failed = true;
            say.warn(`job ${j.id}: ${j.emptyLookups} lookups in a row found no filings for ${j.customer}; the report cannot be written`);
            return "failed";
          }
        }
        if (live[r.provider]!.observed > s.slaMs && n < limit - 1) {
          say.warn(`${r.provider} took ${live[r.provider]!.observed} ms for one paragraph (SLA ${s.slaMs} ms): re-routing the rest of job ${j.id} ${s.id}`);
          return "ok";
        }
      } catch (err) {
        if (err instanceof PaymentRefused && (err.reason === "insufficient_deposit" || err.reason === "between_epochs")) return "blocked";
        throw err;
      }
    }
    if (j.chunksDone >= s.chunks) {
      j.stepIndex += 1;
      j.chunksDone = 0;
      j.emptyLookups = 0;
    }
    return j.stepIndex >= j.steps.length ? "done" : "ok";
  }

  say.beat("run", "Three jobs run at once; every paragraph, search and lookup is paid by clearing at the price in that request's 402 offer.");
  missingFilingsFor = MISSING_FILINGS.job;
  // Phase 1: planning, search and lookups for every job.
  for (let round = 0; round < 40; round++) {
    let moved = false;
    for (const j of jobs) if (j.stepIndex < 3 && !j.failed) moved = (await advance(j, 2)) !== "failed" || moved;
    if (jobs.every((j) => j.stepIndex >= 3 || j.failed)) break;
    if (!moved) break;
  }
  say.table(jobs.map((j) => ({ job: j.id, step: j.failed ? "FAILED" : j.steps[j.stepIndex]?.id ?? "done", spent: fmtMicros(clearing.spent(j.key)), spendable: fmtMicros(clearing.spendable(j.key)) })));

  // Job C failed: stop spending, queue its unspent deposit for withdrawal.
  const C = jobs.find((j) => j.failed);
  if (C) {
    const w = await clearing.withdraw(C.key);
    const when = clearing.mode === "live" ? "claimable once its epoch is final (Metal's 5-minute challenge window)" : `claimable after epoch ${w.epoch} closes`;
    say.decision(`job ${C.id}`, "STOP AND WITHDRAW", `No filings exist to write from; spending more buys nothing. ${fmtMicros(w.queuedMicros)} queued for withdrawal, ${when}. Its card hold is cancelled at settlement, so ${C.customer} is not charged.`);
  }

  // ── New information ──────────────────────────────────────────────────────
  say.beat("new information", `Job ${OVERRUN.job}'s prompt uses ${OVERRUN.factor}× its budgeted tokens, and the budget model slows down.`);
  const B = jobs.find((j) => j.id === OVERRUN.job)!;
  const bDraft = B.steps.find((s) => s.id === OVERRUN.step)!;
  bDraft.chunks *= OVERRUN.factor;
  live["cobalt-mini"]!.latency = SLOW_LATENCY_MS;
  say.step(`job ${B.id} draft: ${bDraft.chunks / OVERRUN.factor} → ${bDraft.chunks} paragraphs · cobalt-mini now answers in ~${SLOW_LATENCY_MS} ms`);
  // The first slow chunk is how the agent finds out: it measures every answer.
  await advance(B, 2);

  const bRest = [remainingOf(B, B.steps[B.stepIndex]!), ...restOf(B)];
  const projectedRest = bRest.reduce((s, st) => s + route(st, views(), Number.MAX_SAFE_INTEGER).costMicros, 0);
  const o = overrun({ holdCents: B.hold, spentMicros: clearing.spent(B.key), projectedRestMicros: projectedRest, depositSpendableMicros: clearing.spendable(B.key) });
  say.decision(`job ${B.id} budget`, o.action, await explain({ ...o, hold: B.hold }, `Projected ${fmtMicros(o.projectedMicros)} against a hold of ${usd(B.hold / 100)}: raise the hold to ${usd(o.newHoldCents / 100)} first, then top up the deposit by ${fmtMicros(o.topUpMicros)}.`));
  if (o.action === "RAISE_HOLD_THEN_TOP_UP") {
    const t: Terms = { action: "RAISE_CARD_HOLD", amount: o.newHoldCents / 100, currency: "USD", counterparty: B.customer, intent: B.intent, job: B.title, reason: `prompt ${OVERRUN.factor}× budgeted tokens` };
    assertApproved(t, await requestApproval(t, `${B.customer}: the report needs more tokens than budgeted. Raise the card hold to ${usd(o.newHoldCents / 100)}?`));
    const inc = await awx.post(`/pa/payment_intents/${B.intent}/increment_authorization`, { request_id: newRequestId(), amount: o.newHoldCents / 100 });
    B.hold = o.newHoldCents;
    say.ok(`Airwallex hold for job ${B.id} raised to ${usd(Number(inc.latest_payment_attempt?.amount ?? inc.amount) || o.newHoldCents / 100)} (intent ${B.intent.slice(0, 16)}…)`);
  }

  // Ration the float: top-ups only above the floor; the rest waits for C's withdrawal.
  const floatMicros = clearing.floatCents() * 10_000;
  const ration = rationFloat(floatMicros, [{ job: B.id, micros: o.topUpMicros, progress: 0.5 }]);
  const g = ration.grants[0]!;
  say.decision("float", g.waiting > 0 ? "PARTIAL TOP-UP, REST WAITS" : "TOP UP", `Float ${fmtMicros(floatMicros)}, floor ${fmtMicros(P.floatFloorMicros)}: grant ${fmtMicros(g.micros)} now${g.waiting > 0 ? `; ${fmtMicros(g.waiting)} waits for job C's withdrawal, which is locked until ${clearing.mode === "live" ? "Metal finalizes it" : "its epoch closes"}` : ""}.`);
  const grantCents = Math.floor(g.micros / 10_000);
  if (grantCents > 0) await clearing.deposit(B.key, grantCents);

  // ── Finish ───────────────────────────────────────────────────────────────
  say.beat("finish", "Run the drafts and reviews; epochs close as the operator settles them.");
  const reportedWait = new Set<string>();
  let idleEpochs = 0;
  let finalityWaitStarted = 0;
  for (let round = 0; round < 600; round++) {
    let progressed = false;
    for (const j of jobs.filter((x) => !x.failed && x.stepIndex < x.steps.length)) {
      const r = await advance(j, 5);
      if (r === "ok" || r === "done") progressed = true;
      if (r === "blocked" && !reportedWait.has(`${j.id}:${clearing.epoch}`)) {
        reportedWait.add(`${j.id}:${clearing.epoch}`);
        say.step(`job ${j.id} is waiting: its spendable deposit is used up until a top-up counts (epoch ${clearing.epoch})`);
      }
    }
    if (jobs.every((j) => j.failed || j.stepIndex >= j.steps.length)) break;
    if (progressed) idleEpochs = 0;
    else if (C && clearing.awaitingFinality(C.key)) {
      // Live clearing: job C's withdrawal can be claimed only once its epoch is final. Wait for it (bounded).
      // Money leaves clearing after two finalities (balance final → queue → queued withdrawal final → claim),
      // each after a 5-minute challenge window, so this takes about ten minutes.
      if (!finalityWaitStarted) { finalityWaitStarted = Date.now(); say.step("job B waits for job C's unspent deposit: Metal releases it after two 5-minute challenge windows (the balance must be final to queue it, then the queued withdrawal must be final to claim it)"); }
      if (Date.now() - finalityWaitStarted > 15 * 60_000) { say.fail("job C's withdrawal did not come back within 15 minutes: stopping"); break; }
      await new Promise((r) => setTimeout(r, 15_000));
      const got = await clearing.claim(C.key);
      const secs = Math.round((Date.now() - finalityWaitStarted) / 1000);
      if (got) say.ok(`job C's withdrawal is final and claimed after ${secs} s: float +${fmt(got)}`);
      else { if (secs % 60 < 15) say.step(`still waiting (${secs} s): ${clearing.withdrawalStage(C.key)}`); continue; }
    } else if (++idleEpochs > 3) {
      say.fail("no job can progress and the float cannot fund them: stopping");
      break;
    }
    if (!progressed) {
      await clearing.nextEpoch();
      const claimed = C && clearing.mode === "emulated" ? await clearing.claim(C.key) : 0;
      say.ok(`epoch closed → ${clearing.epoch}${claimed ? ` · job C's withdrawal claimed: float +${fmt(claimed)}` : ""}`);
      // Fund whatever job B still needs from the float, above the floor.
      const need = Math.max(0, minCostToFinish([remainingOf(B, B.steps[B.stepIndex] ?? B.steps[B.steps.length - 1]!), ...restOf(B)], views()) - clearing.spendable(B.key) - clearing.pendingDeposits(B.key));
      const more = rationFloat(clearing.floatCents() * 10_000, [{ job: B.id, micros: need, progress: 0.8 }]).grants[0]!;
      const cents = Math.ceil(more.micros / 10_000);
      if (cents > 0 && clearing.floatCents() * 10_000 - cents * 10_000 >= P.floatFloorMicros) {
        await clearing.deposit(B.key, cents);
        say.step(`topped up job B by ${fmt(cents)} from the float (counts from epoch ${clearing.epoch + 1})`);
      }
    }
  }
  await clearing.nextEpoch();

  // ── Settle ───────────────────────────────────────────────────────────────
  say.beat("settle", "Read each job's clearing position, capture once from it (never above the hold), cancel the failed job, withdraw unused deposits.");
  const rows = [];
  for (const j of jobs) {
    const spent = clearing.spent(j.key);
    const s = settleHold(spent, j.hold, j.failed);
    if (s.action === "CAPTURE") {
      const cap = await awx.post(`/pa/payment_intents/${j.intent}/capture`, { request_id: newRequestId(), amount: s.captureCents / 100 });
      say.ok(`job ${j.id}: captured ${usd(s.captureCents / 100)} of a ${usd(j.hold / 100)} hold → ${cap.status}`);
    } else {
      const c = await awx.post(`/pa/payment_intents/${j.intent}/cancel`, { request_id: newRequestId(), cancellation_reason: "Report could not be produced" });
      say.ok(`job ${j.id}: hold cancelled → ${c.status}; ${j.customer} pays nothing, the business absorbs ${fmtMicros(s.absorbedMicros)}`);
    }
    if (!j.failed) await clearing.withdraw(j.key);
    rows.push({ job: j.id, customer: j.customer, status: j.failed ? "FAILED" : j.stepIndex >= j.steps.length ? "DONE" : "UNFINISHED", hold: usd(j.hold / 100), spent: fmtMicros(spent), charged: usd(s.captureCents / 100), providers: Object.entries(j.spentByProvider).map(([k, v]) => `${k} ${fmtMicros(v)}`).join(", ") });
  }
  let back = 0;
  if (clearing.mode === "emulated") {
    await clearing.nextEpoch();
    for (const j of jobs) back += await clearing.claim(j.key);
  }
  const paid = clearing.providerEarnings();
  const earned = Object.entries(paid.earnings).filter(([, v]) => v > 0).map(([k, v]) => `${k.split(" (")[0]} ${fmtMicros(v)}`).join(", ");
  say.step(clearing.mode === "live"
    ? `unused deposits stay in clearing until Metal finalizes them; \`npm run metal:withdraw\` brings them back to the operator (run it again ~5 minutes later to claim) · providers earned: ${earned} (${paid.note})`
    : `unused deposits withdrawn after the epoch closed: float +${fmt(back)} · providers earned: ${earned} (${paid.note})`);

  say.beat("result", clearing.mode === "emulated" ? "Outcome (Metal clearing EMULATED; Airwallex card holds live)." : "Outcome (Metal clearing live on testnet; Airwallex card holds live).");
  say.table(rows);
  const overHold = rows.some((r, i) => Number(r.charged.replace(/[^\d.]/g, "")) > jobs[i]!.hold / 100);
  const unfinished = rows.filter((r) => r.status === "UNFINISHED").length;
  say[!overHold && !unfinished ? "ok" : "fail"](`${jobs.filter((j) => !j.failed).length - unfinished} reports delivered, 1 failed and not charged · every hold captured once or cancelled, none above its hold · ${clearing.mode === "live" ? `float ${fmt(clearing.floatCents())} of ${fmt(FLOAT_CENTS)} now, plus unused deposits on their way back` : `float back to ${fmt(clearing.floatCents())} of ${fmt(FLOAT_CENTS)} (the rest paid providers)`}`);
  say.step(`audit log: ${auditPath}`);
} finally {
  await cp?.close();
}
