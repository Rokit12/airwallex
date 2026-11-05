# Kit 11 · x402 Business Agents

**Track:** Agent Payments

Customers' agents buy market data from Trailhead per query, paid over x402 on Metal. A query sells for 5 cents and its upstream data costs 2 cents. Three agents run the business from one Metal account and may spend 20 *USDZ between them, each under its own mandate (spending limits Metal enforces):

| Agent | Job | Mandate |
|---|---|---|
| Sourcing | buys the upstream data, from the listed seller only | USDZ 10 in all, at most 3 cents a purchase |
| Support | refunds customers | USDZ 4 |
| Treasury | watches spending, moves earnings to Airwallex, pays the monthly licence fee invoiced in euros | USDZ 6, to one Metal address it controls |

## What happens

1. **Allocate.** Metal checks each mandate on its own, never their sum, so the agent checks in code that the budgets stay within the 20 *USDZ and that what the agents may still spend fits the balance with a gas reserve left over.
2. **Sell.** Customers' agents read the API's `402` offer, pay, and get data; each sale buys upstream data at 2 cents.
3. **New information: price rise.** The upstream raises its price to 4 cents, above the sourcing agent's 3-cent cap. The next purchase is refused (`OverPerPaymentCap`), the refusal is recorded on chain and moves nothing, and support refunds the customer who paid for that query.
4. **Re-plan.** Treasury proposes new limits within the 20 *USDZ: sourcing cap 4c + 10% = 5c, and budget for the 200 purchases still expected, taken from support above its refund reserve. At 4 cents upstream the margin would be 1 cent, below the 2-cent minimum, so the proposal also raises the query price to 6 cents. A person approves, and the mandates are replaced (spend carries over).
5. **New information: disputed batch.** A customer says its agent never placed a batch of 18 orders and that some data was wrong. The upstream has also withdrawn one batch of its data. The signed orders on chain show the customer's agent did place every one; the 4 queries that returned the withdrawn batch are refunded from support's budget, and the query already refunded at the price rise is not refunded again.
6. **Treasury.** Earnings above what sourcing and support may still spend (and the gas reserve) are pulled to a Metal address treasury controls. Before any retry the agent reads the chain, finds the payment, and resending under the same payment id returns the same settlement: nothing is paid twice. The earnings are credited to Airwallex as a deposit referencing the Metal transaction, after checking `GET /deposits` so they are never credited twice. Then kit 1's calls: an FX conversion to exactly the euros needed, a beneficiary, and the licence fee paid by SWIFT.

## Live or emulated

- **Airwallex: live.** Deposit credited by Metal transaction hash, `GET /deposits` duplicate check, FX quote and conversion to EUR, EUR beneficiary, SWIFT transfer of the licence fee to PAID.
- **Metal: live on testnet** whenever `METAL_RPC_URL` is set (`src/metal/live-mandates.ts`, which runs metal-agent's own commands in-process):
  - **Funding.** One key (`.metal/operator.json`) is topped up from the faucet at most once per run; the owner's account and each customer agent's account are created fresh and funded from it by transfer. Calling the faucet once per account would hit its ten-a-day limit (Metal's advice).
  - **Limits.** The three mandates are bound on the owner's MetalAccount and later replaced on chain (spend carried over). Each customer agent pays under its own mandate on its own account.
  - **Payments.** Every sale is two mandate pulls (customer → API, sourcing → upstream): over 400 in a run, plus refunds and the sweep. Metal's facilitator submits each pull and pays its gas, so the kit sends them about ten at a time (`METAL_CONCURRENCY`); a run's payments take about three minutes. A pull that was not sent is sent again under the same payment id, which Metal pays at most once.
  - **Reading back.** The refusal, the disputed customer's signed orders and the sweep are read from the accounts' `MandatePayment` and `MandateRefused` logs, with explorer links.
  - `METAL=emulated` runs the same flow on the Metal emulator (`src/metal/emulator.ts`) in seconds; it follows Metal's documented rules. `npm run metal:check` is a quick live smoke test.

## Run it

```sh
npm run kit11         # in the terminal
npm run console       # or pick kit 11 in the web console
npm run metal:check   # live Metal testnet: faucet + a real x402 payment (needs METAL_RPC_URL)
```

## Where the logic is

- `checkAllocation()`: budgets within the 20 *USDZ ceiling, and what agents may still spend inside the balance minus the gas reserve.
- `proposeReallocation()`: REALLOCATE, RATION_CALLS or RAISE_API_PRICE, with the moves, the new limits and the query price.
- `resolveDisputedBatch()`: signed orders stand, wrong data is refunded, nothing is refunded twice.
- `sweepAmount()`, `afterTimeout()`, `depositDecision()`: how much to move, what to do after a lost answer, and never crediting a hash twice.

Files: `policy.ts` (decisions), `policy.test.ts` (tests), `fixtures.ts` (synthetic data), `run.ts` (the flow).
