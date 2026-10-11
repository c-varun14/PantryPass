# PantryPass API contract

This file is the hand-off between frontend and backend. If a route, field or error shape changes, change this file first, in its own small PR, then the code.

## Conventions

- Base URL: the HTTP API URL (ap-south-1).
- Header: `Authorization: Bearer <Cognito ID token>`.
- The caller's role comes from the signed `cognito:groups` claim. A request body never changes it.
- Mutating routes take `idem_key` and `expected_version`. A repeated `idem_key` for the same action does not change stock; a stale `expected_version` is rejected with 409.
- Every request is authorized by Verified Permissions before it touches data.

## Routes

| Route | Who | Body fields | Success | Notable errors |
|---|---|---|---|---|
| `POST /lots` | donor | `food` (1-60 chars), `unit` (kg, litres, plates, packets, boxes, trays, pieces), `offered`; optional `receiver_sub` (omit it: the lot is an open offer) | 201 + lot (`open_offer`, no `receiver_sub` while unclaimed) | 400 bad unit/food/offered, 403 `VP_DENY` |
| `POST /lots/{id}/accept` | assigned receiver, or **any receiver** for an open offer (the claim; first one wins) | `idem_key`, `expected_version` | 200 + stage ACCEPTED | 403, 409 stage/version |
| `POST /lots/{id}/handoff` | donor of the lot | `idem_key`, `expected_version`, `donor_handoff`, optional `photo_key` | 200 + HANDOFF_DECLARED | 403, 409 |
| `POST /lots/{id}/receipt` | assigned receiver | `idem_key`, `expected_version`, `received`, optional `pickup_code`, optional `photo_key` | 200 + RECEIVED, `count_dispute` flag | 403, 409 |
| `POST /lots/{id}/distribution` | assigned receiver | `idem_key`, `expected_version`, `distributed` | 200 + new totals | 403, 409 over-report/cutoff |
| `POST /lots/{id}/close` | assigned receiver | `idem_key`, `expected_version` | 200 + ACCOUNTED_FOR | 409 outstanding stock/dispute |
| `GET /lots/{id}` | donor or receiver of the lot | none | lot + events | 403, 404 |
| `POST /lots/{id}/disposition` (new) | assigned receiver | `idem_key`, `expected_version`, `returned` and/or `disposed` | 200 + new totals | 403, 409 exceeds remaining |
| `POST /lots/{id}/resolve-dispute` (new) | coordinator | `idem_key`, `expected_version`, `reconciled_received` | 200 + new event | 403, 409 |
| `POST /lots/{id}/photo-upload` (new) | donor (`kind: handoff`) or receiver (`kind: receipt`) of the lot | `kind`, `content_type` (image/jpeg, png or webp) | 200 + `{key, upload: {url, fields}, max_bytes, expires_in}`; POST the form to S3 with `file` last | 400, 403 `VP_DENY`, 409 wrong stage, 503 storage not configured |
| `GET /lots/{id}/photo?key=` (new) | donor, receiver or coordinator | none | 200 + `{url, expires_in}` (5-minute signed URL) | 403, 404 key not recorded on this lot |
| `GET /open-offers` (new) | receiver or coordinator | none | `{lots: [...]}` unclaimed offers still inside their response window, newest first | 403 |
| `GET /fund` (new) | any signed-in role | none | `{demo, period, pool: {mode, collected_inr, contributors}, pool_inr, cap_pct, total_points, donors, simulated_peers, note, you, allocations, top_donors, donations, rules}`; `pool_inr` is the money actually collected this month (paid pool contributions) in `razorpay` mode, and the configured demo number in demo mode, where simulated money never counts; `you` (with `eligible`, `verified_lots`, `partners`, `needs`) only for donors, `allocations` only for the coordinator, `top_donors` for everyone (each with `supporters` and `supported_inr`); `donations` is `{enabled, min_inr, max_inr, mode, pool_enabled}` | 401 |
| `GET /payout-profile` (new) | donor | none | `{configured, holder_name, account (masked), ifsc, upi (masked), updated, payments: [{amount_inr, status, mode, utr, ts}]}` | 403, 503 not configured |
| `PUT /payout-profile` (new) | donor | `holder_name`, `account_number`, `ifsc`, optional `upi` | 200 + the masked profile; the account number is encrypted with KMS before it is stored | 400 bad field, 403, 503 |
| `GET /donations` (new) | any signed-in role | none | `{mode, given, received, received_inr}`; `given` is what the caller has donated; `received` (donors only) is what they were sent, as `amount_inr` with its `status` (`simulated` in demo mode) | 401, 503 not configured |
| `POST /donations` (new) | any signed-in role, to a top donor other than themselves | `donor_sub`, `amount_inr` (whole rupees, 10 to 50000), optional `note` (up to 80 characters: letters, numbers and basic punctuation) | 200 + `{order_id, mode, amount_inr, currency, donor_sub, kind: "donation"}`; `key_id` only in `razorpay` mode | 400 bad amount or note, 409 self or not a top donor, 502 gateway refused, 503 not configured |
| `POST /donations/confirm` (new) | the supporter who created the order (donation or pool) | `order_id`, `razorpay_payment_id`, `razorpay_signature` | 200 + `{order_id, status, amount_inr, mode, kind}`; `status` is `paid` (razorpay) or `simulated` (demo); `kind` is `donation` or `pool` | 400 signature did not verify, 404 no such order for this caller, 503 not configured |
| `POST /pool` (new) | any signed-in role | `amount_inr` (whole rupees, 10 to 50000), optional `note` | 200 + `{order_id, mode, amount_inr, currency, kind: "pool"}`; `key_id` only in `razorpay` mode; settled like a donation, by `POST /donations/confirm` or the webhook | 400 bad amount or note, 502 gateway refused, 503 not configured |
| `POST /razorpay/webhook` (new) | no JWT; Razorpay only | the raw Razorpay event; `X-Razorpay-Signature` header (HMAC-SHA256 of the raw body, webhook secret); `X-Razorpay-Event-Id` de-duplicates | 200; `payment.captured` and `order.paid` settle a donation or pool order; `payout.*` events update a payout (see Payouts) | 400 bad or missing signature (also when no keys are set) |
| `GET /payouts` (new) | coordinator | none | `{mode: "razorpayx" or "demo", period, pool_inr, note, ledger: {collected_inr, owed_inr, paid_inr}, payouts: [{donor_sub, points, estimated_inr, direct_inr, owed_inr, paid_inr, profile (masked), payments: [{amount_inr, status, mode, utr, ts}], can_pay}]}` | 403, 503 |
| `POST /payouts/run` (new) | coordinator; also runs from an EventBridge scheduled event | none | `{mode, paid: [{donor_sub, amount_inr, status}], skipped: [{donor_sub, reason}], more}`; at most 5 donors per run, `more` is true when others remain | 403, 503 |
| `GET /lots/{id}/verify` (new) | donor, receiver of the lot, or coordinator | none | `{ok, length, head, lot_head, legacy, broken_at, reason}` | 403, 404 |
| `GET /rewards` (new) | any signed-in role | none | `{points, level, next_level, next_level_at, badges, ledger, volume, streak_weeks, verified_lots, partners, community}` | 401 |
| `GET /lots` (new) | any signed-in role | none | list for that role | none |
| `POST /retry-callbacks` | coordinator/system (to be restricted) | optional `lot_id` | 200 + reconciled ids | 403 |

## Additions agreed for the frontend

- **Roles:** `donor`, `receiver`, `coordinator`. The Cognito pool gets a `coordinator` group; `role_from_claims` and the Cedar policies must recognise it (backend).
- **Coordinator read access:** `GET /lots/{id}` and `GET /lots` also allow `coordinator`.
- **`GET /lots` response:** `{"lots": [lot, ...]}`. Donor sees lots they created, receiver sees lots assigned to them, coordinator sees all. Sorted newest first.
- **`lot` fields the UI reads:** `lot_id`, `stage`, `version`, `donor_sub`, `receiver_sub`, `offered`, `donor_handoff`, `received`, `distributed`, `returned`, `disposed`, `remaining`, `count_dispute`, `callback_pending`, `response_deadline_epoch`, `cutoff_epoch`, `created_epoch`.
- **Stages:** `OFFERED`, `ACCEPTED`, `HANDOFF_DECLARED`, `RECEIVED`, `DISTRIBUTING`, `ACCOUNTED_FOR`, `EXCEPTION`.
- **Server time:** every response carries the standard `Date` header; the UI uses it to correct countdowns for clock skew.
- **CORS:** the HTTP API allows the CloudFront origin and `http://localhost:8080`, headers `authorization, content-type`, methods `GET, POST, OPTIONS`.
- **Cutoff:** the client no longer sends `cutoff_epoch` on `POST /lots`; the server sets it.

## Trust record (pickup code and hash chain)

**Pickup code.** `POST /lots/{id}/handoff` also generates a 6-digit code on the server. The 200 response carries `pickup_code` (donor only, shown once) and `pickup_expires_epoch`. The lot stores only a salted hash and the expiry; neither the code nor the hash is ever returned by any route or written to an event. A replay of the same `idem_key` returns the stored result without `pickup_code`.

`POST /lots/{id}/receipt` accepts an optional `pickup_code`:
- valid and unexpired: the event and the lot get `confirmed_in_person: true`, and the code is destroyed (it cannot be reused);
- wrong or expired: 409 `{"error": "pickup code invalid" | "pickup code expired", "attempts_left": n}` and nothing else changes;
- after 5 wrong attempts: 409 `{"error": "pickup code attempt limit reached"}`. A receipt without a code still works and records `confirmed_in_person: false`.

**Hash chain.** Each state-changing event (`CreateLot`, `Accept`, `DeclareHandoff`, `Receipt`, `ReportDistribution`, `Disposition`, `ResolveDispute`, `Close`, `ResponseDeadlineMissed`) stores `prev_hash` and `hash`:

```
hash = sha256( "\n".join([prev_hash, lot_id, event_id, actor, action, decision, result, ts]) )
```

where each field is the exact string stored on the event (`result` is the stored JSON text, `ts` is the decimal epoch) and the first event has `prev_hash = ""`. `chain_head` and `chain_len` on the lot are updated inside the same conditional transaction as the event, so two writers cannot fork the chain. DENY events and `CallbackRetried` do not change lot state and are listed outside the chain.

`GET /lots/{id}/verify` walks the chain by following `prev_hash` links, recomputes every hash, and returns `{"ok": bool, "length": n, "head": "...", "lot_head": "...", "legacy": n, "broken_at": event_id|null, "reason": str|null}`. `legacy` counts state-changing events written before the chain existed. It detects an edited, removed or reordered event. It does not stop someone who can rewrite both the event table and the lot's `chain_head`; anchoring the head outside the database would be the next step.

## Impact

`GET /impact` (coordinator only): also returns `by_unit` and `mixed_units`; the top-level quantities are sums across units and must not be shown when `mixed_units` is true. `{"lots": n, "offered": n, "received": n, "distributed": n, "returned": n, "disposed": n, "accounted_for": n, "disputes_caught": n, "exceptions_raised": n, "confirmed_in_person": n}`. Counts are packets as reported by the people involved. They are not meals, kilograms or avoided waste.

## Rewards (trust points)

`GET /rewards` returns the caller's own recognition, derived on the server from the lot and its hash-chained events. It is recognition only (no prizes). Quantity counts only once it is verified (see "Verified quantity" below).

```json
{"points": 28, "level": "Helper", "next_level": "Steward", "next_level_at": 60,
 "badges": [{"id": "face_to_face", "name": "Face to face", "rule": "Confirm 5 handoffs in person", "earned": false, "progress": 1, "goal": 5}],
 "ledger": [{"lot_id": "lot-...", "reason": "Receipt confirmed in person", "points": 5, "event_hash": "..."}],
 "community": {"lots_accounted_for": 12}}
```

Levels: Seedling 0-19, Helper 20-59, Steward 60-149, Champion 150+. A lot earns points only if its event chain verifies (same check as `/verify`), and never when the donor and receiver are the same person. Nothing is ever deducted: a count dispute or an unanswered offer simply earns nothing.

| Who | Reason | Points |
|---|---|---|
| Receiver of the lot | Accepted before the response deadline | +3 |
| Receiver | Receipt confirmed in person (pickup code) | +5 |
| Receiver | Reported count matched the donor's at receipt | +5 |
| Receiver | Lot closed as accounted for | +10 |
| Donor of the lot | Lot accounted for with counts that matched at receipt | +10 |
| Donor | Handoff confirmed in person by the receiver | +5 |
| Coordinator | Resolved a count dispute (per resolve event) | +3 |

### Verified quantity (donors)

A donor also earns a **volume bonus** on a lot, but only when the whole record backs the number: the chain verifies, the donor and receiver differ, the lot is accounted for, and the receiver's count matched the donor's. The quantity used is the receiver's confirmed `received`, taken from the hash-chained Receipt event.

- Bonus = `min(12, floor(2 * log2(1 + quantity)))`: 1 earns 2, 10 earns 6, 100 or more earns 12. A bigger lot earns more, but a lot can never earn more than 12, so inflating one is not worth it.
- Repeat handoffs between the same donor and receiver shrink: the 1st lot earns the full bonus, the 2nd half, the 3rd and later none (the verified volume still counts).
- Units are never added together. `volume` is `[{unit, quantity, lots}]`, biggest first.
- `streak_weeks` counts consecutive weeks (ending this week or last) with at least one verified donation. Badges `big_mover` (100 verified units in one unit of measure) and `steady_giver` (3-week streak) use these.
- A "top donor" has at least 3 verified lots handed to at least 2 different receivers (`verified_lots`, `partners`). Only top donors are listed in `top_donors` and share the fund.

Each `ledger` entry names the event that earned it (`event_hash`), so it can be checked against the chain.

## Payouts

PantryPass keeps no money and takes no platform fee. Donors are paid by RazorpayX Payouts, and the server sends each payout itself.

Accounting is per period, the calendar month in India time: what a donor is owed is that month's pool share plus that month's direct donations, less what has already been paid or is on its way for that same month, so last month's payouts never reduce this month's. Payout rows are never rewritten, only given a new status. `PERIOD_OVERRIDE` (a Lambda environment variable, for demos and tests only) starts a fresh period without touching any stored data.

A donor adds a name, account number, IFSC and optional UPI id. The account number is encrypted with a KMS key bound to the donor's id before it is stored in a separate DynamoDB table, is never logged, and is returned masked (`XXXXXX9012`). **The coordinator never sees an account number.** The API Lambda decrypts it from KMS and sends it straight to Razorpay, and no route returns it. The coordinator (a volunteer; Meera in the demo) runs payouts with `POST /payouts/run`, or an EventBridge schedule named `pantrypass-payouts` does it (set up by `infra/95_donations.sh`). The role checks are in the API (role from the signed token), not Cedar policies. Deploy the table with `infra/90_payouts.sh`.

**Run rules**

- A run pays every donor with bank details whose owed amount is at least 100 rupees, at most 5 donors per run. `more` is true when others remain; run again to continue.
- `owed_inr` is the pool share plus direct donations received, less what was paid, never below 0.
- Mode is `IMPS` up to 5 lakh rupees, otherwise `NEFT`. The payout is `POST /v1/payouts` to Razorpay with a composite fund account, purpose `payout` and narration "PantryPass payout".
- **Ordinal, then send.** Each payout row is created first with a conditional write on its ordinal, so one owed amount cannot create two rows. Only then is the payout sent, with an idempotency key in the `X-Payout-Idempotency` header. A retry re-sends the same key, so Razorpay does not pay twice.
- A failed call leaves the amount owed. A payout that ends as failed, rejected, reversed or cancelled leaves it owed too.

**Statuses:** `initiating` (row written, not yet sent), `queued`, `processing`, `processed`, `reversed`, `failed`, `rejected`, `cancelled`, and `simulated` (demo mode without RazorpayX keys; nothing is sent). `processed`, `reversed`, `failed`, `rejected`, `cancelled` and `simulated` are terminal: later webhook events for that payout are ignored.

**Webhook events** at `POST /razorpay/webhook` (no JWT; `X-Razorpay-Signature` is the HMAC-SHA256 of the raw body with the webhook secret; a repeated `X-Razorpay-Event-Id` is ignored): `payment.captured`, `order.paid`, `payout.processed`, `payout.reversed`, `payout.failed`, `payout.rejected`, `payout.queued`, `payout.initiated`, `payout.pending`, `payout.updated`. The `payout.*` events move a payout through the statuses above.

## Direct donations and the pool

Payments pass through Razorpay. PantryPass takes no cut and holds no money: the full amount of a donation goes to the donor's payout, and the pool is shared among eligible donors. Razorpay's own gateway and payout charges are Razorpay's, not PantryPass's, and are not yet covered by anyone; sponsors are expected to cover them. **This is an open item.**

- **Donations.** Any signed-in user can donate to a top donor (not to themselves). `POST /donations` returns `{order_id, mode, amount_inr, currency, donor_sub, kind: "donation"}`. The server decides the amount and recipient; the browser never sends a fee.
- **Pool.** Any signed-in role can add to the monthly pool with `POST /pool` (`kind: "pool"`). In `razorpay` mode `GET /fund` `pool_inr` is the money actually collected this month (the sum of paid pool contributions). In demo mode `pool_inr` is the configured demo number, and simulated money never counts.
- **Checkout.** The browser opens Razorpay Checkout with the order and `key_id`, then confirms. Donations and pool contributions use the same order flow.
- **Settled exactly once.** An order moves from `created` to `paid` (razorpay) or `simulated` (demo) with a conditional update. Only the request that wins it writes the records, so a confirm and a webhook for the same payment never double count. Confirming an order that is already settled returns its current status and changes nothing.
- **Confirm.** `POST /donations/confirm` accepts a real order only with a valid `razorpay_signature`: HMAC-SHA256 of `order_id|razorpay_payment_id`, keyed with the key secret.
- **Webhook.** `payment.captured` and `order.paid` settle the order even if the browser closed first. The webhook is authenticated by its signature, not a JWT.
- **Simulated mode.** With no Razorpay keys the flow runs in SIMULATED mode: `mode` is `demo`, orders settle as `simulated`, nothing is charged, the UI labels it, and simulated money never counts in `owed_inr`, `paid_inr` or the collected pool.
- **Keys.** The secret `pantrypass/razorpay` is JSON: `{key_id, key_secret, webhook_secret, payout_account_number}`. `payout_account_number` is the RazorpayX account number; the env var `RAZORPAYX_ACCOUNT_NUMBER` is also accepted. The server reads the secret through `RAZORPAY_SECRET_ARN`, or from the env vars `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET`. The browser only gets the public key id. There is no SDK: the calls are plain HTTPS to Razorpay's REST API.
- **Sustainability.** The work is sustained by sponsors' funds (company CSR budgets, local businesses), open-source contributors, and volunteer coordinators who run the payouts. Razorpay is only the payment rail.

**Go-live steps** (the full checklist is in the header of `infra/95_donations.sh`):

1. In Razorpay, create live API keys, enable RazorpayX on the same account and fund it. Payouts come from that balance.
2. Add a webhook to `<API_URL>/razorpay/webhook` with a webhook secret, subscribed to `payment.captured`, `order.paid`, `payout.processed`, `payout.reversed`, `payout.failed` (required for the Payout APIs) and `payout.rejected`.
3. Allow the site's origin in the Razorpay dashboard so Checkout can load on it.
4. Store the keys and account with `RAZORPAY_KEY_ID=... RAZORPAY_KEY_SECRET=... RAZORPAY_WEBHOOK_SECRET=... RAZORPAYX_ACCOUNT_NUMBER=... bash infra/95_donations.sh`. The script stores the secret, lets the API role read that one secret and redeploys the API.
5. Optional: add `PAYOUT_SCHEDULE="cron(0 4 1 * ? *)"` to the same command to pay donors on a schedule. Without it, the coordinator runs `POST /payouts/run`.

## Error body

```json
{"error": "...", "action": "...", "actor": "...", "decision": "DENY", "request_id": "..."}
```

`decision` is `DENY` or another decision string returned by the policy check.

## Invariant

After receipt: `received = distributed + returned + disposed + remaining`.
