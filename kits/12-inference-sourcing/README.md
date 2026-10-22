# Kit 12 · Inference Sourcing Agent

**Track:** Inference Sourcing

An AI service writes research reports. Every step (model output in 1k-token chunks, web searches, filing lookups) is bought from x402 providers that accept Metal clearing: each job deposits once and signs its running total with every chunk, so providers can charge fractions of a cent. Customers pay by card through Airwallex: a pre-authorized hold for their budget, captured at what the job actually spent.

| Job | Customer | Card hold |
|---|---|---|
| A · EV battery supply-chain brief | Northwind Retail | USD 1.50 |
| B · Competitor pricing scan | Calder Precision Ltd | USD 1.20 |
| C · Regulatory filings brief | Brightline Creative | USD 1.00 |

The operator's USDZ float is 3.00, less than the three holds combined.

## What happens

1. **Hold and deposit.** Each customer's card is held for the budget (`authorization_type: pre_auth`, `auto_capture: false`). Each job's key gets a clearing deposit from the float; deposits count only from the next epoch.
2. **Route.** Each step goes to the cheapest provider that meets a 1.5 s latency SLA, at the price in that request's own `402` offer, never a cached one. A step the agent judges worth it (the customer-facing draft) goes to the premium model when the job can still afford to finish the rest.
3. **New information.**
   - Job C's filings cannot be found: after three empty lookups the job stops, and its unspent deposit is queued for withdrawal, claimable only after the epoch closes.
   - Job B's prompt needs four times its budgeted tokens, and the budget model slows to 2.5 s a chunk. The agent measures the slow answer and reroutes to the standard model.
4. **Re-plan job B.** The projection no longer fits the hold, so the agent raises the hold first. The customer approves the new amount, and the agent calls `increment_authorization`. Only then does it top up the deposit. The float is rationed above its floor: B gets what is free now and the rest waits for C's withdrawal, so B pauses for one epoch, then finishes.
5. **Settle.** Each job's clearing position (one total per key) decides its single capture, never above the hold. Job C's hold is cancelled, so its customer pays nothing and the business absorbs the lookups. Unused deposits are withdrawn after their epoch closes, and the operator pays each provider what it earned.

## Live or emulated

- **Airwallex: live.** Payment intents with pre-authorization, `increment_authorization`, one capture per intent (a second capture is refused by Airwallex), cancel.
- **Metal clearing: emulated.** Metal testnet is reachable (`npm run metal:check` makes a real x402 payment), but this kit's live clearing adapter is not wired yet. The emulator follows Metal's clearing rules: one deposit per payer key, cumulative signed totals across providers, deposits counted from the next epoch, `insufficient_deposit` / `between_epochs` refusals, and withdrawals claimable only after their epoch.

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
