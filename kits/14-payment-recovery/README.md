# Kit 14 · Failed-Payment Recovery

**Track:** Revenue Protection

Trailhead's subscription box bills five customers for November. Four charges fail, each for a different reason. Retrying the wrong ones wastes goodwill and breaks card-network rules, because networks fine merchants that retry "do not reattempt" codes or retry too often. So the agent decides from the issuer's response code, in code.

## What happens

1. **Charge.** One payment intent per invoice, charged live. Airwallex's sandbox returns real issuer responses:
   - **51** insufficient funds
   - **54** expired card
   - **05** do not honour
   - a **risk** block
2. **Plan, by response code** (`nextStep()`):
   - **51:** retry after payday (days 3, 5 and 7)
   - **05:** one retry, then ask for another card
   - **54:** never retry that card; ask for an update
   - **risk:** never retry; pause access and review
3. **New information** over the following days:
   - **The do-not-honour retry** declines again, so the agent stops retrying and asks for another card.
   - **Priya updates her expired card**, so the same invoice is charged once with it.
   - **Kai, blocked by risk, emails** another card number and asks for more retries. Card data never comes by email, and retrying a risk block is how card testing works, so a person approves pausing access and opening a fraud review.
   - **Leo's payday retry** declines again (51). Then he updates his card, and the same invoice is paid.
4. **Result.** Every invoice is read back from Airwallex:
   - collected USD 210.05 of USD 339.10, with USD 161.05 recovered after a decline
   - no invoice charged twice, because every retry confirms the same payment intent
   - no card or risk decline retried

Days are simulated so the run takes a minute; every charge and decline is a live Airwallex payment attempt.

## Live or emulated

Fully live: payment intents, declines with issuer response codes, retries on the same intent, read-back. The sandbox's documented test cards decide each outcome:
- `2223 0000 1018 1375` returns the response code in the cents (80.51 → 51, 80.54 → 54, 80.05 → 05)
- `4646 4646 4646 4644` is risk-blocked
- `4035 5010 0000 0008` succeeds

## Run it

```sh
npm run kit14
npm run console       # or pick kit 14 in the web console
```

## Where the logic is

- `policy.ts`:
  - `classify()` maps the issuer response to soft, generic, card or risk
  - `nextStep()` picks retry, new card, pause or give up, with a cap on attempts
  - `accessOn()` applies the grace period
- `policy.test.ts`: tests that pin them
