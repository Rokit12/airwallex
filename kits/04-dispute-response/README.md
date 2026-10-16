# Kit 04 · Dispute Response Agent

**Track:** Revenue Protection

A chargeback queue at an online merchant. The merchant pays a USD 25 chargeback fee even after winning, and each evidence response costs USD 15.

## What happens

1. **Plan.** Price each dispute on win probability (from evidence), the fee and the response cost. Challenge the USD 1,450 fraud claim with matching device, IP and a delivery signature (needs approval over USD 500). Accept the USD 18 not-received claim as low value. Escalate the credit-not-processed claim, where support never replied.
2. **Act.** Upload evidence PDFs, challenge, accept, and write an escalation ticket.
3. **New information.** The issuer rejects the challenge and moves it to chargeback. The agent reprices (win probability 0.85 → 0.595, fee now certain), asks for approval of the new submission, and challenges again with a 2FA session log.

## Live or emulated

Payment intents are created live and evidence uploads are live. The guide says this kit needs no enablement, but some sandbox accounts refuse to confirm a card by API (`This account is not enabled for native API access`). When that happens, the live intent is handed to the card emulator, and the payment and its disputes are labelled EMULATED. Once Airwallex enables native API access, the whole kit runs live with no code changes.

## Run it

```sh
npm run kit4          # in the terminal
npm run console       # or pick kit 04 in the web console
```

## Where the logic is

`decide()` compares the expected cost of accepting and challenging; `winProbability()` scores evidence and discounts each issuer rejection.

- `policy.ts`: the decisions, pure code
- `policy.test.ts`: tests that pin them
- `fixtures.ts`: synthetic data for the demo
- `run.ts`: the demo flow against the sandbox
