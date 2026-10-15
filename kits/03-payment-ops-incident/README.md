# Kit 03 · Payment Ops Incident Commander

**Track:** Treasury & Ops

A supplier says invoice INV-20931 (USD 4,800) never arrived, threatens to hold a container, and in the same email asks to be paid to a new bank account.

## What happens

1. **Decide.** The original transfer is SENT and 48 hours late. It can still arrive, so the agent requests a bank trace instead of resending, and flags the bank-detail change as possible invoice fraud.
2. **New information.** The bank returns the payment as `INCORRECT_ROUTING`. Airwallex cancels the transfer and drops the reason seconds later, so the agent keeps it from the failure event. A resend to the same account would fail again.
3. **Approval.** A person verifies the new account by calling the number on file (not the one in the email) and approves the exact replacement.
4. **Restart.** The agent re-runs the replace step. Its invoice lock refuses, and Airwallex rejects the reused `request_id`. Paid exactly once.

## Live or emulated

Fully live: beneficiaries, transfers, the bank return and the duplicate-request rejection.

## Run it

```sh
npm run kit3          # in the terminal
npm run console       # or pick kit 03 in the web console
```

## Where the logic is

`decideIncident()` encodes the transfer state machine: in-flight states never trigger a resend; failure types decide between resend, verify and ask.

- `policy.ts`: the decisions, pure code
- `policy.test.ts`: tests that pin them
- `fixtures.ts`: synthetic data for the demo
- `run.ts`: the demo flow against the sandbox
