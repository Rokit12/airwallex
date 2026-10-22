# Kit 11 · x402 Business Agents

**Track:** Agent Payments

Trailhead sells a trail-conditions API to other companies' agents for USDZ 0.10 a call, paid over x402 on Metal. Three agents run the business from one Metal account, each under its own mandate (spending limits Metal enforces):

| Agent | Pays | Limits |
|---|---|---|
| Sourcing | the upstream forecast seller only | USDZ 0.05 per payment, USDZ 3.00 budget |
| Support | any buyer (refunds) | USDZ 0.50 per refund, USDZ 5.00 budget |
| Treasury | one Metal address it controls | USDZ 60.00 per payment and budget |

## What happens

1. **Allocate.** Metal checks each mandate on its own, never their sum, so the agent checks in code that what all agents may still spend fits inside the balance with a gas reserve left over.
2. **Serve.** Buyer agents read the API's `402` offer, pay, and get an answer; each paid call buys one upstream forecast at USDZ 0.04. Support refunds a buyer who reports a stale answer.
3. **New information.** The upstream seller raises its price to USDZ 0.07, above the sourcing cap. The next purchase is refused (`OverPerPaymentCap`) and the refusal is recorded on chain, moving nothing. Support refunds the buyer who paid for that call. The agent reads the sourcing mandate's payments and refusal back from the chain.
4. **Re-plan.** Treasury proposes new limits: sourcing cap 7c + 10% = 8c, and enough budget for the 120 calls still expected, taken from unallocated balance first, then support above its refund reserve, then treasury above its own needs. If the upstream price met or beat the API price it would reprice instead; if nothing could move it would ration calls. A person approves the exact limits; the mandates are replaced, carrying their spend.
5. **Treasury.** Earnings above what sourcing and support may still spend (and the gas reserve) are pulled to a Metal address treasury controls. The payout's answer is "lost", so the agent reads the chain before resending; it finds the payment and sends nothing, and a resend under the same payment id is a no-op. The Airwallex sandbox cannot receive stablecoins, so the agent simulates a deposit whose `reference` is the Metal transaction hash, after checking `GET /deposits` for that hash so it never credits twice. It then converts USD to exactly GBP 30 and pays the contractor's invoice by Faster Payments.

## Live or emulated

- **Airwallex: live.** Deposit credited by Metal transaction hash, `GET /deposits` duplicate check, FX quote and conversion, GBP beneficiary, Faster Payments transfer to PAID.
- **Metal: emulated, with live testnet proven separately.** With `METAL_RPC_URL` set, `npm run metal:check` funds a key from the faucet and pays this project's own x402 seller (`src/metal/live-seller.ts`, the official `@x402/express` middleware with Metal's scheme) on Metal testnet. Spending limits run on the Metal emulator (`src/metal/emulator.ts`), because binding a mandate currently reverts on Metal testnet for every account, Metal's own documented example included. The emulator follows Metal's documented rules: per-payment caps, lifetime budgets, payee lists, refusals that name the limit and move nothing, replace carrying spend, payments by id paid at most once.

## Run it

```sh
npm run kit11         # in the terminal
npm run console       # or pick kit 11 in the web console
npm run metal:check   # live Metal testnet: faucet + a real x402 payment (needs METAL_RPC_URL)
```

## Where the logic is

- `checkAllocation()`: what agents may still spend must fit the balance minus the gas reserve.
- `proposeReallocation()`: REALLOCATE, RATION_CALLS or RAISE_API_PRICE, with the moves and new limits.
- `sweepAmount()`, `afterTimeout()`, `depositDecision()`: how much to move, what to do after a lost answer, and never crediting a hash twice.

Files: `policy.ts` (decisions), `policy.test.ts` (tests), `fixtures.ts` (synthetic data), `run.ts` (the flow).
