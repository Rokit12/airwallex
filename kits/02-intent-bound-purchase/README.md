# Kit 02 · Intent-Bound Purchase Agent

**Track:** Expense & Policy

A SaaS vendor offers USD 1,200 per month or USD 11,808 per year up front (18% cheaper, non-refundable).

## What happens

1. **Plan.** Forecast 13 weeks of cash for both plans against a USD 12,000 reserve. Annual breaks the floor in week 7, so pick monthly and record week 9 (after a receivable lands) as the date to reconsider.
2. **Enforce.** Issue a virtual card whose controls only allow that choice: USD only, the vendor's merchant categories, USD 1,200 per transaction and per month.
3. **Prove.** Simulate five authorizations: the monthly bill, the annual price, the same bill in EUR, a restaurant charge, and a second charge in the month. Each outcome must match what the policy predicts.
4. **New information.** The vendor raises the price to USD 1,350. The approval no longer covers the terms, so the agent freezes its own card (the next charge declines CARD_INACTIVE) and asks again, for the new price and the new limits.

## Live or emulated

Fully live: wallet, deposit, forecast, cardholder, virtual card issuing, card controls, and every authorization and decline (Airwallex itself declines the over-limit, wrong-currency, wrong-merchant and inactive-card attempts). If an account's card issuing or authorization simulator is unavailable, that part switches to the card emulator and the run is labelled EMULATED.

## Run it

```sh
npm run kit2          # in the terminal
npm run console       # or pick kit 02 in the web console
```

## Where the logic is

`choosePlan()` compares the two cash paths; `controlsFor()` builds card controls from the decision; `predict()` states what each authorization should do.

- `policy.ts`: the decisions, pure code
- `policy.test.ts`: tests that pin them
- `fixtures.ts`: synthetic data for the demo
- `run.ts`: the demo flow against the sandbox
