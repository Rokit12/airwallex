# Kit 12 · Inference Sourcing Agent

**Track:** Inference Sourcing

An AI service writes research reports. Every step (model paragraphs, web searches, filing lookups) is bought from x402 providers that accept Metal clearing: each job deposits once and signs its running total with every purchase. Model providers charge 1, 2 and 5 cents a paragraph, a web search costs 2 cents and a data lookup 3. Customers pay by card through Airwallex: a pre-authorized hold for their budget, captured at what the job actually spent.

| Job | Customer | Card hold |
|---|---|---|
| A · EV battery supply-chain brief | Northwind Retail | USD 1.00 |
| B · Competitor pricing scan | Calder Precision Ltd | USD 0.75 |
| C · Regulatory filings brief | Brightline Creative | USD 0.75 |

The operator's float is 1.50 *USDZ, less than the 2.50 the three jobs could spend.

## What happens

1. **Hold and deposit.** Each customer's card is held for the budget (`authorization_type: pre_auth`, `auto_capture: false`). Each job's key gets a clearing deposit from the float; deposits count only from the next epoch.
2. **Route.** Each step goes to the cheapest provider that meets a 1.5 s latency target, at the price in that request's own `402` offer, never a cached one. A step the agent judges worth it (the customer-facing draft) goes to the premium model when the job can still afford to finish the rest.
3. **New information.**
   - Job C's filings cannot be found: after three empty lookups the job stops, and its unspent deposit is queued for withdrawal, claimable only after the epoch closes.
   - Job B's prompt runs to four times the tokens budgeted (9 → 36 paragraphs), and the cheapest model slows to 2.5 s a paragraph under the load. The agent measures the slow answer and reroutes to the standard model.
4. **Re-plan job B.** The projection no longer fits the hold, so the agent raises the hold first. The customer approves the new amount, and the agent calls `increment_authorization`. Only then does it top up the deposit. The float is rationed above its floor: B gets what is free now and the rest waits for C's withdrawal, so B pauses for one epoch, then finishes.
5. **Settle.** Each job's clearing position (one total per key) decides its single capture, never above the hold. Job C's hold is cancelled, so its customer pays nothing and the business absorbs the lookups. Unused deposits are withdrawn after their epoch closes, and the operator pays each provider what it earned.

## Live or emulated

- **Airwallex: live.** Payment intents with pre-authorization, `increment_authorization`, one capture per intent (a second capture is refused by Airwallex), cancel.
- **Metal clearing: live on testnet** (`@metalntwx/metal-pay` 0.3.4, `src/metal/clearing-port.ts`). Each provider is an x402 seller offering Metal's clearing scheme (`bajillion`) next to `exact`; each job is its own clearing wallet with its own deposit from the operator; every paragraph, search and lookup is paid by signing the job's running total off chain, and Metal certifies totals on chain every few seconds. Refusals are handled as Metal documents them: `between_epochs` is retried after the given delay, `answer_lost` and `payment_held` resend the same request (never paying twice), and `insufficient_deposit` blocks the job until a top-up counts.
- **Live timing.** Money leaves clearing after two finalities, each after the contract's 5-minute challenge window: a balance must be final before it can be queued for withdrawal, and the queued withdrawal must be final before it can be claimed. So in a live run job B waits about ten minutes for job C's unspent deposit, and the whole kit takes about 15–20 minutes. Unspent deposits left at the end stay in clearing until final: `npm run metal:withdraw` queues them, and running it again about five minutes later claims them back to the operator.
- **Fallback.** Without `METAL_RPC_URL`, or if Metal's clearing service (`clearing-testnet.metalntwx.com`) isn't reachable, the kit runs clearing on the Metal emulator (`src/metal/emulator.ts`), which follows the same rules on a compressed clock, and labels the run. `METAL=emulated npm run kit12` forces this for a 30-second run.

## Run it

```sh
npm run kit12         # in the terminal
npm run console       # or pick kit 12 in the web console
```

## Where the logic is

- `route()` and `minCostToFinish()`: provider choice by live price, SLA and remaining budget.
- `overrun()`: CONTINUE, TOP_UP, or RAISE_HOLD_THEN_TOP_UP (hold before deposit).
- `rationFloat()`: top-ups above the float floor, nearest-to-done first.
- `settleHold()`: one capture from the position, never above the hold; CANCEL for a failed job.

Files: `policy.ts` (decisions), `policy.test.ts` (tests), `fixtures.ts` (synthetic data), `run.ts` (the flow).
