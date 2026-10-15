# Kit 09 · Approval-Bound Shopping Agent

**Track:** Agentic Commerce

A shopper wants a 2-person backpacking tent under USD 260 all-in, arriving within 8 business days, from a merchant that takes returns.

## What happens

1. **Shop.** The agent searches a merchant site in a real headless browser and reads every product page. It rejects items that don't match the need (a better-rated 3-person tent is not a 2-person tent), are over budget, or arrive late.
2. **Approve.** The shopper approves product, merchant, delivery and total.
3. **New information.** The merchant raises the price. The agent re-reads the total before paying, pauses on the same checkout, and asks again.
4. **Pay.** Credentials come from the credentials provider (Airi CLI once access is granted; the sandbox test card until then) straight into the hosted payment form, never into the model or logs.
5. **Verify.** The submission times out after the payment went through. The agent checks the order before any retry, does not pay twice, and reports the result back.

## Live or emulated

Real headless Chromium against the local test storefront. Merchant payments go through Airwallex payment intents (card emulator until card acceptance is enabled). Real-merchant checkout needs Airi CLI access: set `AIRI_MANDATE_CMD`, `AIRI_CREDENTIALS_CMD` and `AIRI_REPORT_CMD` (see `src/commerce/credentials.ts`).

## Run it

```sh
npm run kit9          # in the terminal
npm run console       # or pick kit 09 in the web console
```

## Where the logic is

`choose()` with `mismatch()`, `diffTerms()` and `afterUnconfirmedSubmit()`.

- `policy.ts`: selection, term comparison, retry safety
- `policy.test.ts`
- `run.ts`: the demo flow (browser automation)
