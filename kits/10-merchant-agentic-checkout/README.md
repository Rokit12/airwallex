# Kit 10 · Merchant-Enabled Agentic Checkout

**Track:** Agentic Commerce

A merchant sells through Claude. Its 120-product catalogue and checkout are exposed as MCP tools: `search_products`, `get_product`, `create_checkout`, `get_checkout`.

## What happens

1. **Search.** Claude searches and refines with the merchant's tools and reads the current price.
2. **Confirm.** The shopper confirms merchant, product, quantity, delivery and total. The checkout is created with an idempotency key; a repeated call returns the same checkout.
3. **Pay.** The shopper enters a card on the hosted payment page. Card details never pass through Claude.
4. **Exception.** The first card is declined (Airwallex's documented test card at USD 80.51). The agent reads the checkout, sees no order and no charge, and sends the shopper back to the same checkout rather than creating a new one.
5. **Result.** The second card succeeds; the merchant returns an order number and the payment outcome.

## Live or emulated

Test storefront MCP server and hosted payment page. Payments are live Airwallex payment intents, confirmed with documented test cards (a declined card comes back as Airwallex's own `issuer_declined`). On an account without native API access for payments, card confirmation falls back to the card emulator. Airwallex's own merchant MCP endpoint replaces the store's once merchant-side Agentic Commerce is enabled.

## Shop from Claude yourself

The guide asks for the merchant's MCP endpoint to be configured in Claude locally. Start the storefront and add its endpoint:

```sh
npm run store                # storefront on :4320, MCP endpoint at /mcp
claude mcp add-json trailhead-store '{"type":"http","url":"http://localhost:4320/mcp"}'
```

Then ask Claude to find and buy a product. It searches the catalogue with `search_products` (it doesn't crawl the site), confirms the terms with you, and gives you the hosted payment link for your card. Use `4035501000000008` to pay, or the declined test card to see the exception. When Airwallex grants merchant-side Agentic Commerce access, upload the catalogue in the format Airwallex provides and point Claude at Airwallex's merchant-specific MCP endpoint instead.

## Run it

```sh
npm run kit10         # in the terminal
npm run console       # or pick kit 10 in the web console
```

## Where the logic is

No separate policy module: the flow's safety rules (confirm before pay, idempotent checkout, check before retry) are in `run.ts` and the store (`src/commerce/`).

- `run.ts`: the demo flow; storefront in `src/commerce/`
