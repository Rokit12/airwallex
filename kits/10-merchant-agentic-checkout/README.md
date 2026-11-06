# Kit 10 · Merchant-Enabled Agentic Checkout

**Track:** Agentic Commerce

A merchant, Trailhead Outfitters, sells through shoppers' AI assistants on **Airwallex Agentic Commerce**. The merchant is onboarded with Airwallex, and its 120 products are in Airwallex's catalogue. Shoppers' assistants buy through Airwallex's merchant MCP endpoint. The merchant's own endpoints run on AWS:

| Merchant endpoint | What it does |
|---|---|
| `POST /checkout` (Create Checkout) | Airwallex calls it to price a cart. It verifies Airwallex's HMAC signature on the raw body and rejects stale timestamps. It answers with stock per line, delivery and pickup options covering every line, and totals in minor units. Prices come from code (`src/merchant/acp.ts`), never from the assistant. |
| OAuth server (`/oauth/...`) | Discovery, dynamic client registration, guest sign-in, and authorization code with PKCE. It issues RS256 access tokens that Airwallex verifies against the published JWKS. |
| `POST /webhooks/airwallex` | Receives `payment_intent.succeeded`. It verifies the webhook's own signature, ignores repeated deliveries by event id, and marks the order paid with the shopper's delivery choice. |
| `/shop/product/{sku}`, `/shop/orders/{id}` | The catalogue's product links and each order's page. |

## What happens

1. **Connect.** The assistant opens Airwallex's merchant MCP endpoint. It names the merchant's OAuth server, and the shopper signs in there as a guest.
2. **Search.** `explore_products` searches Airwallex's copy of the catalogue. The agent keeps the best matches for the request, with returns, under the budget.
3. **Price.** `create_checkout_session` makes Airwallex call the merchant's Create Checkout endpoint on AWS. The agent picks the delivery option the shopper asked for, and Airwallex adds the delivery line to the total.
4. **Confirm.** The shopper approves the exact merchant, product, quantity, delivery, total and checkout session. The total is re-read before paying and must still match.
5. **Pay.** The shopper's checkout UI tokenizes the card with Airwallex (`create_delegate_payment_token`). The agent only gets a token limited to this session and the approved total, so card numbers never reach it.
6. **Exception.** The first card is blocked by Airwallex's risk check. The agent reads the session: it's still waiting for payment, with no completed order and no charge. So the shopper pays again on the same session, not a new one.
7. **Result.** The second card succeeds. The agent checks Airwallex has exactly one successful payment for the order, and that the merchant's webhook has marked it paid.

## Live or emulated

Fully live on Airwallex Agentic Commerce once the merchant is onboarded (see below):
- **On Airwallex:** onboarding, catalogue ingest, the merchant MCP endpoint and its tools, checkout sessions priced by the merchant, delegate payment tokens, payments, the declined card and the retry.
- **On AWS:** the merchant's endpoints.

Before onboarding, `npm run kit10` falls back to the kit's own local merchant MCP server and hosted payment page, with live Airwallex payment intents. `ACP_MODE=local` forces that mode.

## Set up the live merchant

After `npm run aws:deploy` ([docs/AWS.md](../../docs/AWS.md)):

```sh
npm run aws:merchant -- keys        # checkout HMAC secret + OAuth signing key, into Secrets Manager
npm run aws:merchant -- onboard     # POST /pa/agentic_commerce/onboard; prints the ACP MCP endpoint
npm run aws:merchant -- products    # 120 products in GMC attributes, POST /pa/agentic_commerce/products
```

Then, in the Airwallex web app, go to **Developer → Webhooks** and add a `payment_intent.succeeded` webhook to `<MerchantUrl>/webhooks/airwallex`. Store its secret with `WEBHOOK_SECRET=… npm run aws:merchant -- webhook`.

## Shop from a desktop AI assistant

Add Airwallex's merchant MCP endpoint (printed by `onboard`, saved in `infra/merchant.json`) to your assistant's MCP settings (for desktop assistants that take a config file, through `mcp-remote`):

```json
{ "mcpServers": { "trailhead-outfitters": { "command": "npx", "args": ["-y", "mcp-remote", "https://mcp.sandbox.airwallex.com/pa/ai/<merchantId>/acp/mcp"] } } }
```

Restart the assistant, sign in as a guest on the Trailhead Outfitters page that opens, and ask for "a set of two insulated water bottles under $85 with returns". Pay with the test card `4035501000000008`, or use `4646464646464644` to see a declined card.

The local storefront still works too: `npm run store`, then add `http://localhost:4320/mcp` to your assistant as an HTTP MCP server.

## Run it

```sh
npm run kit10         # in the terminal
npm run console       # or pick kit 10 in the web console
```

## Where the logic is

- `live.ts`: the shopper's assistant on Airwallex's MCP endpoint
- `run.ts`: chooses live or local, plus the local flow
- `src/merchant/acp.ts`: the merchant's pure rules: signature check, pricing, fulfillment rules, catalogue in GMC attributes
- `src/merchant/oauth.ts`: discovery, redirect policy, PKCE, RS256 tokens, JWKS
- `src/aws/merchant.ts`: the merchant's Lambda (Create Checkout, OAuth, webhook, pages)
- `src/merchant/merchant.test.ts`: tests for all of the above
