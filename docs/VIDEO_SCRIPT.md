# Video walkthrough (target 4:40, limit 5:00)

The hackathon asks for a walkthrough under five minutes. It shows two kits live in full, then the defining moment of four more.

## Before recording

- `npm run console` running; browser at http://localhost:4310 with the window around 1400 px wide.
- In the shell that starts the console, set `DEMO_PACE=900` so each step stays on screen long enough to read.
- Leave `APPROVE` unset, so you press **Approve** on camera. Approving is part of the story.
- Do one practice run of kits 3 and 1 first, so the sandbox is warm.
- For kits 5, 6, 9 and 10, either run them live or open the replay page (`preview/agent-console.html`) in a second tab.

---

### 0:00–0:25 · The problem
On the console's empty state:
> "Agents are starting to move money. What matters is what they do when something changes: a late deposit, a bank return, a price rise. We built ten agents on Airwallex's sandbox for one US business. In every one, tested code owns the money rules, Claude reads the documents, and any approval is tied to the exact terms a person saw."

### 0:25–1:45 · Kit 3, Payment Ops Incident Commander (run live)
Click **Kit 03**, then **Run agent**.
- **Email card:** "The supplier says the invoice never arrived, and asks us to pay a new account. That's a classic fraud pattern."
- **TRACE decision:** "The original is still in flight, so resending could pay twice. The agent asks for a bank trace and flags the bank change."
- **Bank return:** "The bank returns it: incorrect routing. Airwallex cancels the transfer and drops the reason seconds later, so the agent kept it from the event."
- **Approval card:** "I confirm I called the supplier on the number on file. The approval is a hash of exactly these terms." Press **Approve these terms**.
- **Restart:** "The agent re-runs. Our lock refuses, and Airwallex rejects the reused request id. Paid exactly once."

### 1:45–2:45 · Kit 1, Adaptive Treasury Controller (run live)
Click **Kit 01**, then **Run agent**.
- **Plan table:** "Five bills, three currencies, and only $18,000 above the floor. Freight first, buying only the euros we're short. The new agency goes to a person."
- **Customer email:** "Part of a receivable slips a week. Confidence drops, the FX limit halves, and the same conversions now need me."
- **Deposit:** "Six thousand lands. One decision changes, and nothing else is recalculated."
- **Approval card:** point at the quote id and rate. Press **Approve**. "Real FX, a SWIFT payout and an ACH payout, all paid, and the reserve holds."

### 2:45–4:05 · Five more agents, one moment each
- **Kit 05 (bridge table):** "Bridge capital covers one late customer. The one with a bank pre-notice gets it; the other's card payment declines exactly as predicted."
- **Kit 06 (pooled-check warning):** "Summing every employer's balance says 'enough'. Per employer, Beacon is short, so it asks for a platform advance instead of using another employer's money."
- **Kit 09 (rejected list, then re-ask):** "It rejects a better-rated 3-person tent because the shopper asked for 2-person. When the price rises after approval, it asks again, and a timed-out payment is checked before any retry."
- **Kit 10 (decline, same checkout):** "The first card is declined. The agent sees no order and no charge, and sends the shopper back to the same checkout. One order, one charge."
- **Kit 02 (card declines table):** "This one is fully live on Airwallex: a virtual card locked to one vendor, one currency and the approved amount. Coffee, euros and an upsell are all declined by Airwallex itself."
- Point at the **Platform rail emulated** / **Card rail emulated** chip: "Features Airwallex hasn't enabled on our account run on emulators built from the documented behaviour, and switch to live automatically."

### 4:05–4:30 · Why it's safe
Switch to a terminal and run `npm test`:
> "Forty-seven tests pin every decision you just saw. Every API call, decision and approval is in an audit log with card data redacted."

### 4:30–4:40 · Close
> "Code decides, Claude reads and explains, and people approve exact terms. The repo has a five-minute setup to run it against your own sandbox."
