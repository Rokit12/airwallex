# Kit 01 · Adaptive Treasury Controller

**Track:** Treasury & Ops

Five obligations in USD, EUR and GBP fall due within 72 hours. USD 18,000 is free above a USD 10,000 reserve floor, which is not enough for all of them.

## What happens

1. **Plan.** Rank by criticality and deadline. Fund the freight release first, buying only the EUR shortfall (including the SWIFT fee, net of EUR already held). Fund the GBP supplier and the lease. Defer the software renewal, which has a grace period. Escalate a new USD 12,000 vendor: new vendors over USD 10,000 need a person.
2. **New information.** A customer emails that part of a receivable slips a week. Forecast confidence drops from HIGH to LOW, and the autonomous FX limit falls from USD 8,000 to USD 4,000, so the same conversions now need approval.
3. **New information.** A USD 6,000 deposit lands. Only the decision it affects changes: the software renewal becomes fundable.
4. **Execute.** An approved FX conversion on a single-use quote (the approval binds the quote id, rate and amounts), a SWIFT payout in EUR and an ACH payout in USD, all read back as PAID. The agent confirms the reserve still holds after queued payments and flags any fee that differs from plan.

## Live or emulated

Fully live: balances, FX rates, quotes and conversions, beneficiaries, transfers, deposit and transfer simulations.

## Run it

```sh
npm run kit1          # in the terminal
npm run console       # or pick kit 01 in the web console
```

## Where the logic is

`plan()` ranks and funds within the floor; `changedLines()` reports only what new information changed; `receiptConfidence()` sets the FX autonomy limit.

- `policy.ts`: the decisions, pure code
- `policy.test.ts`: tests that pin them
- `fixtures.ts`: synthetic data for the demo
- `run.ts`: the demo flow against the sandbox
