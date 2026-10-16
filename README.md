# Airwallex Agent Desk

Ten agents that run real financial workflows on the [Airwallex](https://www.airwallex.com) sandbox for **Trailhead Outfitters LLC**, a US business. Each agent makes a financial decision, changes it when the balance, deadline, evidence or risk changes, and then moves money or hands the decision to a person.

Built for the Airwallex agentic banking hackathon. **Sandbox only. No real money.**

![The Agent Console stopping a run for approval of exact payment terms](docs/images/console-approval.png)

## Contents

- [The agents](#the-agents)
- [Quick start](#quick-start)
- [Running the agents](#running-the-agents)
- [Configuration](#configuration)
- [How the agents are built](#how-the-agents-are-built)
- [Live and emulated](#live-and-emulated)
- [Tests](#tests)
- [Project layout](#project-layout)
- [What we learned about the sandbox](#what-we-learned-about-the-sandbox)
- [More documentation](#more-documentation)

## The agents

| Kit | Agent | The decision it makes | Details |
|---|---|---|---|
| 01 | Adaptive Treasury Controller | What to fund, convert, defer or escalate when cash is short, and how much FX it may book without a person | [README](kits/01-adaptive-treasury/README.md) |
| 02 | Intent-Bound Purchase Agent | Monthly or annual SaaS terms from a cash forecast, enforced with virtual-card controls | [README](kits/02-intent-bound-purchase/README.md) |
| 03 | Payment Ops Incident Commander | Wait, trace, replace or escalate a missing supplier payment without paying twice | [README](kits/03-payment-ops-incident/README.md) |
| 04 | Dispute Response Agent | Accept, challenge or escalate chargebacks on evidence and cost | [README](kits/04-dispute-response/README.md) |
| 05 | Platform Spend Controller | Which late customer gets scarce bridge capital so their card payment clears | [README](kits/05-platform-spend/README.md) |
| 06 | Multi-Employer Payroll Executor | Pay each employer's contractors from that employer's money only | [README](kits/06-multi-employer-payroll/README.md) |
| 07 | Portfolio Lending Agent | Collect revenue-based repayments and size an advance above the reserve floor | [README](kits/07-portfolio-lending/README.md) |
| 08 | Marketplace Settlement Agent | Seller reserves, net payouts, re-reserving on new risk, recovering refund shortfalls | [README](kits/08-marketplace-settlement/README.md) |
| 09 | Approval-Bound Shopping Agent | Buy only what the shopper approved, ask again on any change, never pay twice | [README](kits/09-approval-bound-shopping/README.md) |
| 10 | Merchant-Enabled Agentic Checkout | Sell through Claude via the merchant's MCP tools and a hosted payment page | [README](kits/10-merchant-agentic-checkout/README.md) |

## Quick start

You need **Node.js 22 or later** and a free **Airwallex sandbox account**.

**1. Get sandbox credentials.** Sign up at [sandbox.airwallex.com](https://www.sandbox.airwallex.com/global/signup). In the web app, open **Account → Developer → API keys** and create a key. Leave its IP allowlist empty and give it read and write access.

**2. Install.**

```sh
git clone https://github.com/Rokit12/airwallex.git
cd airwallex
npm install
npm run setup:browser        # Chromium for kits 9 and 10
```

**3. Add your keys.**

```sh
cp .env.example .env
```

Open `.env` and paste your `AWX_CLIENT_ID` and `AWX_API_KEY`. The file is ignored by git.

**4. Check the connection and fund the wallet.**

```sh
npm run check                # logs in, lists global accounts and balances
npm run fund                 # tops USD up to 25,000 with a simulated deposit if needed
```

**5. Open the console and run an agent.**

```sh
npm run console              # then open http://localhost:4310
```

Pick a kit and press **Run agent**. When the agent needs a person, the run stops on an approval card; press **Approve these terms** or **Decline**.

## Running the agents

### Web console

`npm run console` serves the Agent Console at http://localhost:4310. Each run streams the agent's goal, plan, incoming documents, every decision with its reason, tables, approvals, and the final state read back from Airwallex.

| Desktop | Phone, dark mode |
|---|---|
| ![Kit 1 plan in the console](docs/images/console-kit1.png) | ![Console on a phone](docs/images/console-phone-dark.png) |

To share runs without a server, run `npm run record` (runs every kit, approving automatically) and then `npm run build:replay`. That writes `preview/agent-console.html`, a single page that replays the recorded runs.

### Terminal

```sh
npm run kit1                 # … through npm run kit10
npm run demo                 # kit 1 then kit 3
```

Approval prompts wait for your answer in the terminal (type `y` and press Enter).

To run all ten agents one after another without stopping, approving everything automatically:

```sh
APPROVE=yes npm run record   # every kit, end to end; each run saved to runs/console/
```

### Let Claude shop the test store (kits 9 and 10)

```sh
npm run store                # storefront on :4320, MCP endpoint at /mcp
claude mcp add-json trailhead-store '{"type":"http","url":"http://localhost:4320/mcp"}'
```

Then ask Claude, for example: "Find me a set of insulated water bottles under $85 with returns."

## Configuration

All settings live in `.env` (see [`.env.example`](.env.example)).

| Variable | Required | Purpose |
|---|---|---|
| `AWX_CLIENT_ID`, `AWX_API_KEY` | Yes | Airwallex sandbox credentials |
| `ANTHROPIC_API_KEY` | No | Lets Claude read emails, quotes and notes and explain decisions. Without it, deterministic rules reach the same decisions. |
| `AGENT_MODEL` | No | Claude model for the above |
| `APPROVE` | No | `yes` approves every request automatically (unattended runs); `no` declines |
| `APPROVER` | No | Name recorded on approvals |
| `DEMO_PACE` | No | Milliseconds to pause between story beats, for recordings |
| `RAILS` | No | `live` disables the emulator fallback; `emulated` forces it |
| `PORT`, `STORE_PORT` | No | Console port (4310) and storefront port (4320) |
| `AIRI_MANDATE_CMD`, `AIRI_CREDENTIALS_CMD`, `AIRI_REPORT_CMD` | No | Airi CLI commands for kit 9, from the Airi beta instructions |

## How the agents are built

- **Money rules live in code.** Amounts, limits, reserve floors, fees and state transitions are plain TypeScript functions with tests (`kits/*/policy.ts`). The same facts always give the same decision.
- **The model reads and explains.** With `ANTHROPIC_API_KEY` set, Claude extracts facts from emails, quotes and case notes, and explains decisions. Its output is validated against a type, checked against the ledger, and the ledger wins on any disagreement. It never chooses an amount and never sees card data.
- **Approvals are bound to exact terms.** An approval is a hash of the amount, currency, counterparty, terms and evidence the person saw. If anything changes afterwards (a price rise, a new FX quote, a new dispute stage), the approval no longer matches and the agent asks again.
- **No double payments.** Every payout runs under a per-obligation lock written before the API call. Retries reuse the same `request_id`; new payments always get a new one.
- **Errors are unconfirmed, not failures.** After a timeout or server error, the agent re-reads the object from Airwallex before deciding anything.
- **Tenants are never pooled.** Platform agents check each customer's own balance and never use one customer's money for another.
- **Everything is audited.** Each run writes a JSONL log of every API call, decision and approval to `runs/`, with card numbers, CVCs and tokens redacted.

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) has diagrams of how these pieces fit together.

## Live and emulated

Every kit calls the real Airwallex sandbox API first. Some features have to be switched on by Airwallex for an account. When Airwallex refuses one, that part of the run switches to an emulator built from Airwallex's documented sandbox behaviour, and the run is labelled **Card rail emulated** or **Platform rail emulated**. The same code goes live as soon as the feature is enabled.

Status on our US sandbox account:

| Kits | Live | Emulated until Airwallex enables it |
|---|---|---|
| 1, 3 | Everything: FX, SWIFT and ACH payouts, bank returns | – |
| 2 | Everything: wallet, forecast, cardholder, **virtual card issuing, card controls and real authorizations/declines** | – |
| 4 | Payment intents are created live; evidence uploads | Confirming a card by API (needs native API / PCI access) and the disputes that follow |
| 5 | **Virtual cards, card controls and authorizations** (each card's limit mirrors the customer's wallet, so Airwallex approves or declines); FX | Connected accounts and platform payments |
| 6–8 | FX rates and quotes | Connected accounts and platform payments |
| 9 | Headless browser shopping on the test storefront; payment intents | Card confirmation by API; Airi CLI for real merchants |
| 10 | Merchant MCP server, hosted payment page, payment intents | Card confirmation by API; merchant-side Agentic Commerce |

`RAILS=live npm run kit5` disables the fallback, which is a quick way to check whether a feature is enabled yet.

## Tests

```sh
npm test                     # 47 policy tests across all ten kits
npm run typecheck
npm run verify               # both, as CI runs them
```

The tests cover the decision logic of every kit and need no credentials. GitHub Actions runs `npm run verify` on every push.

## Project layout

```
kits/NN-name/
  policy.ts          the decisions (pure functions)
  policy.test.ts     tests that pin them
  fixtures.ts        synthetic data for the demo
  run.ts             the demo flow against the sandbox
  README.md          what the kit shows
src/core/            Airwallex client, emulators, approvals, lock, audit, Claude calls
src/console/         web console server, kit runner, recorder, replay builder
src/commerce/        test storefront, merchant MCP server, card credentials provider
ui/index.html        the console page
docs/                architecture, troubleshooting, video script, screenshots
preview/             replay page built from recorded runs
runs/                audit logs and run outputs (git-ignored)
```

## What we learned about the sandbox

- **Failed transfers end CANCELLED, and the failure reason disappears** within seconds. The agents keep it from the failure event.
- **A transfer transition can return HTTP 500 and still apply.** The agents re-read before trusting any error.
- **SWIFT fees can differ from the documented flat fee:** EUR 13.40 was charged against EUR 12.85 expected. Kit 1 flags the variance.
- **ACH payouts carried a USD 3.00 fee.** The agents read `fee_amount` from each transfer rather than assuming LOCAL is free.
- **Reusing a `request_id` returns `duplicate_request_id`.** Kit 3 relies on this as its second defence against paying twice.

## More documentation

- [Architecture](docs/ARCHITECTURE.md): layers, decision flow, core modules, console event protocol
- [Troubleshooting](docs/TROUBLESHOOTING.md): login, access, and run-time issues
- [Video script](docs/VIDEO_SCRIPT.md): a timed walkthrough under five minutes
- Each kit's README, linked in [the table above](#the-agents)

## License

[MIT](LICENSE)
