# Kit 13 · Cash Placement & Reconciliation

**Track:** Treasury & Ops

The guide leaves this one open: *"Cash placement and reconciliation are Treasury & Ops jobs too, and we have not written kits for them. Good territory if you want a problem few other builders will take on."*

Six customer invoices are due today. A EUR supplier bill and a GBP supplier bill fall due within two weeks, alongside a USD payroll.

## What happens

1. **Plan.** On expected collections (USD 19,830), keep a USD buffer for payroll and pre-fund both the EUR and the GBP bills. Nothing is booked yet: you don't place cash you haven't received.
2. **Reconcile the morning statement.** Four payments land as live sandbox deposits, with payer names and references. The agent reads them back from Airwallex's deposit list and applies them in code:
   - an exact payment
   - one payment covering two invoices ("Remittance 1002/1003")
   - a payment USD 18 short, written off as a bank fee within the tolerance (the lesser of USD 25 and 0.5%)
3. **New information: the afternoon statement.**
   - A customer pays the same invoice twice and doesn't pay its other one. The second payment is **owed back**: it isn't income, and it doesn't settle the other invoice without the customer saying so.
   - USD 25,000 arrives from an unknown payer, so it's **quarantined**.
   - An email then asks for the 25,000 to go to a *new* IBAN: urgent, "already approved by your CFO", "skip the usual process". The agent flags these as untrusted instructions and **refuses**. Money only goes back to its source, through the bank's return process, after a person verifies the payer. It's escalated.
4. **Re-decide on identified cash only (USD 13,412).** The USD buffer and the GBP bill still fit. The EUR bill doesn't, so it's **deferred** rather than part-funded.
5. **Execute with approvals.**
   - The duplicate is refunded to the customer's account on file. The refund account passes Airwallex's beneficiary schema and validation first, and a person approves the exact amount and account.
   - GBP 2,400 is bought on a single-use quote. The approval binds the quote, rate and amounts, because the FX is above the agent's USD 2,500 limit.
6. **Result.** The statement ties out to the cent: USD 42,192 = 13,412 income + 3,780 owed back + 25,000 quarantined. Open invoices, deferred bills and the quarantined money are written to `runs/kit13-exceptions.json` for a person.

## Live or emulated

Fully live: simulated deposits read back from Airwallex's deposit list, the beneficiary schema check and validation, the refund payout, and the FX quote and conversion.

## Run it

```sh
npm run kit13         # in the terminal
npm run console       # or pick kit 13 in the web console
```

## Where the logic is

- `policy.ts`: the decisions, pure code
  - `matchDeposits()` applies payments to invoices and never guesses between two possible sets
  - `tieOut()` explains every cent
  - `placementPlan()` keeps a USD buffer and funds whole bills earliest first
  - `refundAllowed()` only allows refunds to the account on file
- `policy.test.ts`: tests that pin them
- `fixtures.ts`: invoices, statement lines, bills and the suspicious email
