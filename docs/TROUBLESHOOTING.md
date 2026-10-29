# Troubleshooting

Start with `npm run check`. It logs in, lists global accounts and balances, and names what is missing.

## Login and access

| What you see | Cause | Fix |
|---|---|---|
| `401 credentials_invalid` | Client ID or API key is wrong (screenshots often confuse `I`/`l` and `O`/`0`) | Copy both values with the copy buttons in **Account → Developer → API keys** into `.env` |
| Card payments fail with `authorization_failed` / `internal_error` ("Please try again later"), or `failed to process transaction` from the card simulator | Airwallex's sandbox card processing is temporarily down (it affects every account, not your setup). The client reads the payment back, so nothing is charged twice | Wait and re-run the kit. `RAILS=live npm run kit4` is a quick check of whether card payments are back |
| `403 Forbidden` on login | The key has an IP allowlist, or the firewall is blocking repeated failed logins | Remove the IP allowlist from the key; wait a while after many failed attempts |
| Calls fail with `forbidden` or missing permission | The scoped key lacks a resource | Give the key read and write access to balances, global accounts, FX, beneficiaries, transfers, issuing, payments, files and simulation |
| Business stays **In review** | A business you added has a custom name | Name it exactly `New Business Sandbox` or `Sandbox Business`; those are approved automatically |
| `ENOTFOUND api.sandbox.airwallex.com` | No network route, or you are behind a proxy | On Node 22+, run with `NODE_USE_ENV_PROXY=1` and your proxy variables set |

## Features not enabled on the account

These are switches on Airwallex's side. The kits run on emulators in the meantime and label every emulated run.

| Message from Airwallex | Affects | Ask devhelp@airwallex.com for |
|---|---|---|
| `Invalid issuance details` or `not allowed to set "DEBIT" card type` | Kits 2, 5 (cards) | Card issuing for the account |
| `configuration_error: Invalid request against merchant configuration` | Kits 4, 9, 10 (payments) | Card acceptance / payment intents |
| `This account is not enabled for native API access` (on `/confirm`) | Kits 4, 9, 10 (card confirmation) | Native API access for payments, or use Airwallex's hosted page / Drop-in element so card details never touch your server |
| `This account cannot onboard business accounts` | Kits 5–8 | Connected accounts **and** platform payments |
| `unconfigured_client_fee` (FX) or `fee_unknown` (transfers) on a connected account | Kits 6, 7 | Fee pricing for FX and payouts inside connected accounts. Meanwhile the kits route these through the platform account, live |

| Metal: `mandate bind` → `would fail: Execution reverted for an unknown reason` | Kit 11 (spending limits) | Fixed in `@metalntwx/metal-agent` 0.3.3. Run `npm install` to get it |
| Metal: `was made by another factory … create a new account with this version` | `npm run metal:check` | Accounts made by metal-agent before 0.3.3 came from an older factory. Delete `.metal/mandate-account.txt` and run again; the check creates a new account |

To check whether a feature is live, run a kit with `RAILS=live`.

## Metal testnet (kits 11 and 12)

| What you see | Fix |
|---|---|
| Kit 12: `Metal clearing: the clearing service … is not reachable` | Your network blocks `clearing-testnet.metalntwx.com` | Allow `*.metalntwx.com`. Until then kit 12 runs clearing on the emulator and labels the run |
| Kit 12 waits about ten minutes for job C's withdrawal | Normal on live clearing: Metal releases a withdrawal after two 5-minute challenge windows | Wait, or run `METAL=emulated npm run kit12` for a 30-second run |
| `no METAL_RPC_URL set` | Create an endpoint at https://console-testnet.metalntwx.com (billing accepts an Airwallex sandbox test card) and add `METAL_RPC_URL` to `.env` |
| `ENOTFOUND` from the faucet or facilitator | Behind a proxy on Node 22+, run with `NODE_USE_ENV_PROXY=1` |
| Faucet refuses | Ten grants per IP per UTC day, one client per minute; retry later or fund from the console's Faucet page | It fails fast instead of falling back to the emulator.

## Connected accounts (kits 5–8)

| What you see | Meaning |
|---|---|
| `field_required` on `/accounts/{id}/submit` (`description_of_goods_or_services`, `identifications.primary`) | Submitting a business needs a description and an ID document for each business person. `src/core/platform.ts` sends both; the ID is a clearly labelled specimen PDF uploaded through the files API |
| `403 Account not ready!` or `401` right after activation | A just-activated account can refuse for a few seconds. `onboardAndFund` retries with the same `request_id` |

## During a run

| What you see | Meaning |
|---|---|
| `duplicate_request_id` | Expected in kit 3's restart step: Airwallex refused to pay twice. Anywhere else, a request id was reused for a different operation. |
| `fee variance` warning in kit 1 | Airwallex charged a different SWIFT fee than the policy assumes. The run continues; update `swiftFee` in `kits/01-adaptive-treasury/policy.ts` if it persists. |
| A transition answered `500` but the run continues | The sandbox sometimes applies a transition and still returns 500. The agent re-reads the transfer and only retries if it did not move. |
| `429` / slow runs | The sandbox rate limit (10 requests per second per endpoint). The client spaces and retries calls; avoid running several kits at once. |
| Kit 9 or 10: `Executable doesn't exist` | Chromium for Playwright is not installed. Run `npm run setup:browser`. |
| Console says **Console server offline** | `npm run console` is not running, or it stopped. Restart it and reload the page. |
| Console: **Kit NN is still running** | One run at a time. Wait for it to finish, or answer its pending approval. |

## Logs

Every run writes `runs/kitNN-<time>.jsonl` with each API call, response, decision and approval (card data and tokens redacted). Escalations, trace requests and decision records are written next to it as JSON files.
