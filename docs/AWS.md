# Running the Agent Desk on AWS

The fifteen kits run on **Amazon Bedrock AgentCore Runtime**, built to call the model on **Amazon Bedrock** with the runtime's own role. The hosted console is protected by **Amazon Cognito** sign-in. It follows the pattern of Airwallex's AWS reference builds for kits 1 to 8 ([awx-devx/airwallex-agentic-banking-aws](https://github.com/awx-devx/airwallex-agentic-banking-aws)), applied to our TypeScript build of all fifteen kits.

Everything still runs against the Airwallex sandbox and the Metal testnet only.

## Architecture

```text
browser ──► CloudFront ─► S3                    console page + config.js (public IDs only)
   │
   └──► API Gateway (HTTP API)
          │  Cognito JWT authorizer: only signed-in operators; no self sign-up
          ▼
        Lambda (console API)                    sets the approver from the verified token
          │  InvokeAgentRuntime (IAM; the runtime has no public endpoint)
          ▼
        AgentCore Runtime (Node.js 22, arm64)   the kits, unchanged
          ├─ model on Bedrock                   reads and explains; never sets amounts
          ├─ Secrets Manager                    Airwallex sandbox + Metal testnet keys
          ├─ Airwallex sandbox API, Metal testnet
          └─ headless Chromium                  kit 9 shops the test store

Airwallex ──► API Gateway (public) ──► Lambda (kit 10 merchant) ──► DynamoDB
                Create Checkout (HMAC-signed), OAuth server for shoppers,
                payment webhook, product and order pages
```

| Rule from the guide | How it holds on AWS |
|---|---|
| The model reads, code decides | The same kit code runs inside the runtime. Bedrock only extracts fields and explains decisions. Amounts, limits and request IDs come from each kit's `policy.ts`. |
| A person approves anything that moves money | The console API takes the approver from the operator's verified Cognito token. It never takes it from the request body. A request that claims `by: "agent"` is still recorded under the signed-in person. The kit then refuses any approval from the proposing agent. |
| Approval binds to the exact terms | Unchanged: the hash covers amount, currency, counterparty and terms. |
| Keep credentials out of the model's context | Keys live in Secrets Manager and are loaded into the process environment. They never reach a prompt. The runtime calls the model with its IAM role, so there is no model key at all. |
| Least privilege | The runtime role can invoke only the two inference profiles and read only its own secret. Only the console Lambda may invoke the runtime. |
| Cost guard | A monthly AWS Budget (USD 100 by default) emails you at 50% and 100% of actual spend, and at 100% of forecast spend. |

## What you need

- An AWS account, and credentials with administrator access in the deploy Region. Short-lived credentials (IAM Identity Center) are best.
- Bedrock model access in that Region. Set `-c modelId=` and `-c fallbackModelId=` to the inference profiles you want; the defaults are in `infra/app.ts`. Without Bedrock access the runtime uses the model API key from the secret, if one was seeded (`npm run aws:seed`), and otherwise the built-in rules.
- A Region where AgentCore Runtime is available. The default is `us-west-2`.
- Node.js 22, and this repository set up as in the README (the sandbox keys in `.env`).

## Deploy

```sh
npm ci
export AWS_REGION=us-west-2
npx cdk bootstrap aws://<account-id>/$AWS_REGION        # once per account and Region
npm run aws:deploy -- -c alertEmail=you@example.com      # builds the runtime package, then deploys
npm run aws:seed                                         # copies the sandbox keys from .env into Secrets Manager
npm run aws:operator -- you@example.com                  # invites you; Cognito emails a temporary password
```

`npm run aws:deploy` prints `ConsoleUrl`. Open it, sign in, pick a kit and run it.

- **Approving:** approvals in the console are recorded under your email.
- **IAM changes:** `cdk deploy` asks you to confirm them at the terminal. In a shell with no terminal, add `--require-approval never`.
- **Budget alerts:** the alert address receives the budget emails.

**What gets seeded:** `AWX_CLIENT_ID`, `AWX_API_KEY` and `METAL_RPC_URL`, plus the Metal clearing operator key (`.metal/operator.json`) for kit 12.

- `npm run aws:seed -- --dry-run` lists what would be sent, without the values.
- The Anthropic key is not sent, because on AWS the model is Bedrock.

## Kit 10's merchant on Airwallex Agentic Commerce

After the deploy, run `npm run aws:merchant -- keys`, `-- onboard` and `-- products`. Then add the `payment_intent.succeeded` webhook in the Airwallex web app, and store its secret with `WEBHOOK_SECRET=… npm run aws:merchant -- webhook`. [Kit 10's README](../kits/10-merchant-agentic-checkout/README.md) has the details and the desktop assistant setup.

## What is different from a local run

| | Local (`npm run console`) | AWS |
|---|---|---|
| Model | Anthropic API (`ANTHROPIC_API_KEY`) | the model on Bedrock (IAM role) |
| Approver | `operator`, or `APPROVER=` | the signed-in Cognito user |
| Browser for kits 9 and 10 | Playwright's Chromium | serverless Chromium for arm64 (`@sparticuz/chromium-min`), shipped in the package |
| Console updates | server-sent events | polling every second through API Gateway |
| Files (`runs/`, audit logs) | the repository | `/tmp/awx` inside the runtime session |

The console shares one runtime session, so one kit runs at a time, as it does locally. A session ends after an hour without use, and its run history is discarded with it. The sandbox state lives in Airwallex and is unaffected.

## Test it without an AWS account

```sh
npm run aws:build                                  # dist/agentcore: runtime.js, kits/kitNN.mjs, chromium/
CHROMIUM_PACK= PORT=8089 AWX_WORK_DIR=/tmp/awx node dist/agentcore/runtime.js
curl -s localhost:8089/ping
curl -s -XPOST localhost:8089/invocations -d '{"action":"run","kit":"03"}'
curl -s -XPOST localhost:8089/invocations -d '{"action":"events","since":0}'
```

When a kit asks for approval, answer it like this:

```sh
curl -s -XPOST localhost:8089/invocations -d '{"action":"approve","id":"<id>","approve":true,"by":"you@example.com"}'
```

`CHROMIUM_PACK=` (empty) uses Playwright's local Chromium, because the packaged Chromium is built for arm64. Run the commands with your `.env` exported.

## Remove it

```sh
npx cdk destroy --app "npx tsx infra/app.ts"
```

This deletes the stack: the runtime, API, user pool, secret, console bucket and budget.
