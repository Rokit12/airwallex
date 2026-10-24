# Kit 08 · Marketplace Settlement Agent

**Track:** Multi-Tenant Platforms

Buyers pay the marketplace; three sellers hold connected accounts. The platform holds exactly what they are owed, with no spare cash.

## What happens

1. **Plan.** Set each reserve from the seller's trailing refund rate; the newest seller holds the most.
2. **Act.** Pay two sellers their net proceeds.
3. **New information.** A carrier failure notice arrives before the third seller's payout. Recompute only that seller's reserve (USD 480 → 2,815), get approval, pay the reduced net.
4. **Recover.** Refunds exceed even the raised reserve, so recover the shortfall from the seller's wallet (checked first). Every seller reconciles to the cent, and the platform wallet equals the unreleased reserves.

## Live or emulated

Fully live: seller connected accounts, sales, reserves, net payouts and refund recovery.

## Run it

```sh
npm run kit8          # in the terminal
npm run console       # or pick kit 08 in the web console
```

## Where the logic is

`reserveFor()`, `reserveWithEvidence()` and `reconcile()`. Reserves live in this ledger because Airwallex has no escrow object for this flow.

- `policy.ts`: the decisions, pure code
- `policy.test.ts`: tests that pin them
- `fixtures.ts`: synthetic data for the demo
- `run.ts`: the demo flow against the sandbox
