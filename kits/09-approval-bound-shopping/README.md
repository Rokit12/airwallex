# Kit 09 · Approval-Bound Shopping Agent

**Track:** Agentic Commerce

A shopper wants a 2-person backpacking tent under USD 260 all-in, arriving within 8 business days, from a merchant that takes returns.

## What happens

1. **Shop.** The agent searches a merchant site in a real headless browser and reads every product page. It rejects items that don't match the need (a better-rated 3-person tent is not a 2-person tent), are over budget, or arrive late.
2. **Approve.** The shopper approves product, merchant, delivery and total.
3. **New information.** The merchant raises the price. The agent re-reads the total before paying, pauses on the same checkout, and asks again.
4. **Pay.** Credentials come from the credentials provider straight into the hosted payment form, never into the model or logs. With the Airi CLI, the agent creates a mandate for exactly the approved merchant, total and item, the shopper confirms it with their passkey at the link Airi returns, the agent fetches a single-use credential into an owner-only file, fills the form from it and deletes the file, then reports the result (`SUCCEEDED`, `DECLINED` or `CANCELLED`) to Airi.
5. **Verify.** The submission times out after the payment went through. The agent checks the order before any retry, does not pay twice, and reports the result back.

## Live or emulated

Real headless Chromium against the local test storefront. Merchant payments are live Airwallex payment intents, confirmed with the documented test card. On an account without native API access for payments, card confirmation falls back to the card emulator. Card credentials come from the sandbox test card unless `AIRI_PAYMENT_METHOD_ID` is set, which switches to the Airi CLI (see below and `src/commerce/credentials.ts`).

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

## Using the Airi CLI

Your Airi account must be on the CLI beta allowlist (ask devhelp@airwallex.com).

```sh
npm install -g @airwallex/airi-cli@beta
airi-cli auth login                 # approve the device code in your browser
airi-cli payment-methods list       # pick an agent-enabled card
echo "AIRI_PAYMENT_METHOD_ID=<id>" >> .env
npm run kit9                        # confirm the payment with your passkey when the link appears
```

Airi's test mode (a test card with a fake credential) is not released yet. Until it is, a mandate uses a real card from your Airi wallet, so leave `AIRI_PAYMENT_METHOD_ID` unset to run on the sandbox test card. The local store charges through the Airwallex sandbox, which moves no real money.

