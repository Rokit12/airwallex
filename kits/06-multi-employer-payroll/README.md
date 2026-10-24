# Kit 06 · Multi-Employer Payroll Executor

**Track:** Multi-Tenant Platforms

Weekly contractor payroll in USD, EUR and GBP for three employers, each a connected account.

## What happens

1. **Plan.** Price each payroll including SWIFT fees before converting. Summing all employers' balances says there is enough; checking each employer's own balance shows Beacon is short.
2. **Execute.** Atlas pays in full: FX, beneficiaries and transfers all on Atlas's behalf.
3. **Beacon.** Pay one contractor in full, hold the other, and ask a person to approve a platform advance. Another employer's money is never used.
4. **New information.** Cobalt's deposit lands mid-run. It funds Cobalt only; Beacon is still short until the advance.

## Live or emulated

Fully live: three employer connected accounts, payroll funding, a platform advance, FX and contractor payouts in EUR, USD and GBP. Airwallex has not configured fee pricing for FX and payouts inside connected accounts on our account, so those are routed through the platform account, live: the employer's own balance is charged, the platform converts or pays the contractor, and converted money returns to that employer. No employer's money ever pays for another.

## Run it

```sh
npm run kit6          # in the terminal
npm run console       # or pick kit 06 in the web console
```

## Where the logic is

`price()`, `planEmployer()` and `naivePooledCheck()` (the bug the kit guards against).

- `policy.ts`: the decisions, pure code
- `policy.test.ts`: tests that pin them
- `fixtures.ts`: synthetic data for the demo
- `run.ts`: the demo flow against the sandbox
