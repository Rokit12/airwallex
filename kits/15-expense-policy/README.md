# Kit 15 · Expense Policy Agent

**Track:** Expense & Policy

Dana Kim travels to Denver on a company virtual card. Card controls stop what the policy forbids outright. Receipts decide the rest.

## What happens

1. **Enforce.** A travel card whose controls allow only airfare, lodging, meals and rides (MCCs), with USD 600 per transaction and USD 2,500 per month.
2. **Spend (live authorizations).** Flight, hotel, client dinner, an Uber and a coffee go through. A games purchase is **declined by Airwallex at the till** (`MERCHANT_CATEGORY_NOT_ALLOWED`).
3. **Receipts.** The model reads Dana's receipts into fields. Code matches each to a card transaction, to the cent, and checks it:
   - the nightly lodging cap
   - the meal cap per person
   - cabin class
   - personal items
   - receipts are required from USD 25
4. **Plan.** The hotel minibar (USD 62) is personal, and the Uber receipt is missing, so the settlement is **held**: nothing is paid on an incomplete trip.
5. **New information.** Dana sends the Uber receipt and confirms the minibar. She also asks for a USD 180 bar tab to be paid "today, finance already said it's fine". The bar tab fails policy, and a claimed approval in a message is not an approval.
6. **Settle.** USD 89 of approved out-of-pocket costs (parking and a bag fee), minus USD 62 personal, gives **USD 27**. It's paid to Dana's account on file, which passes Airwallex's beneficiary schema and validation, after a person approves.

## Live or emulated

Fully live: card issuing with spend controls, authorizations (one declined by the card), the beneficiary checks and the reimbursement payout.

## Run it

```sh
npm run kit15
npm run console       # or pick kit 15 in the web console
```

## Where the logic is

- `policy.ts`:
  - `matchReceipt()` matches a receipt to a card transaction
  - `checkReceipt()` checks it against policy
  - `reviewCard()` reviews every transaction
  - `settle()` works out reimbursement versus deduction, holds when a receipt is missing, and freezes the card after repeated blocked attempts
- `policy.test.ts`: tests that pin them
