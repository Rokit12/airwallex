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
6. **Treasury.** Earnings above what sourcing and support may still spend (and the gas reserve) are pulled to a Metal address treasury controls. The payout's answer is "lost", so the agent reads the chain before resending; it finds the payment and sends nothing twice. The earnings are credited to Airwallex as a deposit referencing the Metal transaction, after checking `GET /deposits` so they are never credited twice. Then kit 1's calls: an FX conversion to exactly the euros needed, a beneficiary, and the licence fee paid by SWIFT.

## Live or emulated

- **Airwallex: live.** Deposit credited by Metal transaction hash, `GET /deposits` duplicate check, FX quote and conversion to EUR, EUR beneficiary, SWIFT transfer of the licence fee to PAID.
- **Metal: emulated in the kit, proven live separately.** With `METAL_RPC_URL` set, `npm run metal:check` runs on Metal testnet: it pays this project's own x402 seller (`src/metal/live-seller.ts`, the official `@x402/express` middleware with Metal's scheme), then binds a spending limit like the sourcing agent's (3 cents a payment), pays 2 cents under it, and has a 4-cent payment refused on chain (`mandate_cap_exceeded`, nothing moved). This needs `@metalntwx/metal-agent` 0.3.3 or later. The kit itself makes over 200 payments, and each on-chain one takes seconds and gas from a faucet that grants ten a day, so the kit runs its limits on the Metal emulator (`src/metal/emulator.ts`). The emulator follows Metal's documented rules: per-payment caps, lifetime budgets, payee lists, refusals that name the limit and move nothing, replace carrying spend, payments by id paid at most once.

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
