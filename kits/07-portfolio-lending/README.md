# Kit 07 · Portfolio Lending Agent

**Track:** Dynamic Lending

A platform funds revenue-based advances. Borrowers repay a share of each week's revenue.

## What happens

1. **Plan.** On forecast repayments, the third borrower's USD 25,000 advance would breach the USD 20,000 floor, so plan a partial tranche.
2. **Collect.** Revenue lands. One borrower's revenue fell and it paid its own supplier, so its wallet is short: collect what is there and record the rest as a receivable, never a charge that would fail.
3. **Re-decide.** Size the tranche on cash actually collected (USD 23,300 → 22,200), get approval for that exact amount, disburse, and reconcile with a balance report.

## Live or emulated

Runs on the platform emulator until Airwallex enables connected accounts.

## Run it

```sh
npm run kit7          # in the terminal
npm run console       # or pick kit 07 in the web console
```

## Where the logic is

`collection()` and `decideDisbursement()` (full, partial tranche, or delay).

- `policy.ts`: the decisions, pure code
- `policy.test.ts`: tests that pin them
- `fixtures.ts`: synthetic data for the demo
- `run.ts`: the demo flow against the sandbox
