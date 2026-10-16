# Kit 05 · Platform Spend Controller

**Track:** Multi-Tenant Platforms

A card platform for small businesses. Each customer is a connected account with its own wallet and a platform-issued card.

## What happens

1. **Setup.** Open three customers, fund their wallets, issue cards with platform controls, and show a limit decline.
2. **New information.** Two customers' deposits are late and both have a card payment due today. Bridge capital above the floor covers only one.
3. **Ration.** Bridge the customer with a bank pre-notification and a 92% on-time history. Decline the one backed only by the customer's word, with a past late repayment. A partial bridge is never offered, because the card payment would still decline.
4. **Collect.** The late deposit lands. Recover the bridge and the monthly fee with charges, checking each wallet first.

## Live or emulated

Runs on the platform emulator until Airwallex enables connected accounts; switches to live automatically.

## Run it

```sh
npm run kit5          # in the terminal
npm run console       # or pick kit 05 in the web console
```

## Where the logic is

`rationBridges()` and `repayProbability()`.

- `policy.ts`: the decisions, pure code
- `policy.test.ts`: tests that pin them
- `fixtures.ts`: synthetic data for the demo
- `run.ts`: the demo flow against the sandbox

## Live cards while connected accounts are unavailable

If Airwallex refuses to open connected accounts, the customers' wallets run on the platform emulator but **cards stay live**. Each customer gets a real virtual card on the platform's Airwallex account. Before every authorization, the platform sets that card's per-transaction limit to the lower of the platform control (USD 3,500) and the customer's wallet balance. Airwallex then approves or declines the authorization itself. A decline caused by the wallet limit is reported as `INSUFFICIENT_FUNDS`, and Airwallex's own reason (`LIMIT_EXCEEDED`) is kept alongside it.
