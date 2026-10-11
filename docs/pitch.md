# PantryPass pitch

## One line
A shared record of surplus-food handoffs where **the count can't be wrong, because the person who benefits from saying "done" isn't allowed to say it.**

## The problem (20 seconds)
Surplus food moves by trust and WhatsApp messages. A donor says "ten trays of food are on the way". Someone taps "done". The spreadsheet says ten distributed. Afterwards nobody can say how many packets arrived, where they went, or what was thrown away. Offered, handed over and actually received are three different facts that get blurred into one number, and whoever updated last wins.

## What it is (15 seconds)
PantryPass keeps those facts apart. Each person reports only their own part, and anything unconfirmed stays visibly open. A coordinator can see at a glance what is confirmed, what is disputed and what nobody answered.

## Why it holds up (the part to spend time on)
The donor refusal is a ten-second proof, not the product. A role check is one `if`; the interesting part is what keeps a count trustworthy:

1. **AWS enforces it, not the app.** Verified Permissions (Cedar) decides every action *before any data is touched*. The role comes from the signed Cognito token, never from the client. A refused attempt is logged as a DENY event, so the audit trail shows it.
2. **No double counting.** Conditional writes stop two people changing a lot at once; idempotency keys make a double-tap or a retry harmless.
3. **The numbers always add up.** `received = distributed + returned + disposed + remaining` is checked on every write.
4. **Nobody has to chase.** An unanswered pickup turns into an exception on its own, through a durable Step Functions wait.
5. **In person, and unedited.** A one-time pickup code confirms the handoff; a hash-chained event record shows the history wasn't changed ("Record verified").
6. **Where people already are.** The same rules run over WhatsApp: a donor texting `DISTRIBUTED 5` gets the same refusal as on the web.

Ask a judge to double-tap, retry, or leave a pickup unanswered: the count stays correct.

## Business model (why donors keep donating, and who pays)
Food donors do the hard part for free, so the app pays them back in recognition and in money:

- **Who pays:** sponsors (company CSR budgets, local businesses) and community donors who top up a monthly pool.
- **Who earns:** food donors, in proportion to their trust points. Points only come from verified, receiver-confirmed handoffs (matching counts, in-person pickup, lot accounted for), and the verified amount adds a capped bonus (a bigger lot earns more, but only up to a limit, and repeats between the same two people earn less), so inflating a lot is not worth it. Only donors with a broad verified record (3 lots, 2 different receivers) share the pool, and payouts go to bank details the donor provides. One donor can take at most 30% of the pool, and a lot whose record fails Verify earns nothing.
- **Second revenue line (direct donations):** the platform takes a fee (5% by default) on money a supporter gives directly to a verified top donor, and the rest goes to that donor. Donors are only eligible after 3 verified lots to 2 different receivers, so the money follows a tamper-evident record, not a claim.
- **What sponsors get:** a tamper-evident record of what was really received and distributed. That is exactly the evidence CSR and ESG reports lack today.
- **Honest status:** in this demo the pool is a configured number and a few clearly labelled simulated peers join it so the sharing is visible. No money moves and no sponsor is signed. Direct donations are simulated until Razorpay keys are set.

## What we do not claim
It records who reported what. It does not prove food was eaten or safe, or that waste was avoided. Two people who agree on a false number would still pass. The hash chain makes edits detectable; it does not stop someone who can rewrite both the events table and the chain head. Impact numbers are packets as reported, not meals or kilograms. The WhatsApp channel is built and tested with signed test messages; a live round trip needs Meta credentials.

## Next step
One real operator and one real lot.
