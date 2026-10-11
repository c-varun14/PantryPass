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
| `GET /fund` (new) | any signed-in role | none | `{demo, period, pool_inr, cap_pct, total_points, donors, simulated_peers, note, you, allocations, top_donors, donations, rules}`; `you` (with `eligible`, `verified_lots`, `partners`, `needs`) only for donors, `allocations` only for the coordinator, `top_donors` for everyone (each with `supporters` and `supported_inr` once payout details are configured); `donations` is `{enabled, fee_pct, min_inr, max_inr, mode}` | 401 |
| `GET /payout-profile` (new) | donor | none | `{configured, holder_name, account (masked), ifsc, upi (masked), updated, payments}` | 403, 503 not configured |
| `PUT /payout-profile` (new) | donor | `holder_name`, `account_number`, `ifsc`, optional `upi` | 200 + the masked profile; the account number is encrypted with KMS before it is stored | 400 bad field, 403, 503 |
| `GET /donations` (new) | any signed-in role | none | `{mode, fee_pct, given, received, received_inr}`; `given` is what the caller has donated; `received` (donors only) is what they were sent, with `fee_inr` and `net_inr` | 401, 503 not configured |
| `POST /donations` (new) | any signed-in role, to a top donor other than themselves | `donor_sub`, `amount_inr` (whole rupees, 10 to 50000), optional `note` (up to 80 characters: letters, numbers and basic punctuation) | 200 + `{order_id, mode, amount_inr, fee_inr, net_inr, currency, donor_sub}`; `key_id` only in `razorpay` mode | 400 bad amount or note, 409 self or not a top donor, 502 gateway refused, 503 not configured |
| `POST /donations/confirm` (new) | the supporter who created the order | `order_id`, `razorpay_payment_id`, `razorpay_signature` | 200 + `{order_id, status, amount_inr, net_inr, mode}`; `status` is `paid` (razorpay) or `simulated` (demo) | 400 signature did not verify, 404 no such order for this caller, 503 not configured |
| `POST /razorpay/webhook` (new) | no JWT; Razorpay only | the raw Razorpay event; `X-Razorpay-Signature` header | 200; `payment.captured` and `order.paid` settle the order | 400 bad or missing signature (also when no keys are set) |
| `GET /payouts` (new) | coordinator | none | `{payouts: [{donor_sub, points, estimated_inr, direct_inr, owed_inr, profile (masked), paid_inr, payments}], note}` for donors who share the pool or have received direct donations; `direct_inr` is the net of paid direct donations, `owed_inr` is the pool share plus `direct_inr` less what was paid (never below 0) | 403, 503 |
| `GET /payouts/{sub}/details` (new) | coordinator | none | `{donor_sub, holder_name, ifsc, upi, account_number}`: the full details of ONE donor, to make a transfer; every reveal is logged with who and whom, never the number | 403, 404 |
| `POST /payouts/{sub}/transfer` (new) | coordinator | `amount_inr`, `reference` (bank or UPI reference) | 200 + recorded transfer; a statement by the coordinator, not part of the hash chain | 400, 403, 409 no details on file |
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

PantryPass **records** bank details and the transfers a coordinator makes; it does not move money. A donor adds a name, account number, IFSC and optional UPI id. The account number is encrypted with a KMS key (bound to the donor's id) before it is stored in a separate DynamoDB table, is never logged, and is returned masked (`XXXXXX9012`). Only a coordinator can reveal one donor's full details, to make the transfer in their own bank, and then records the transfer's reference. The donor sees those recorded transfers. The role checks for these routes are in the API (role from the signed token), not Cedar policies. Deploy with `infra/90_payouts.sh`.

## Direct donations

Any signed-in user can donate to a top donor (not to themselves). The browser asks `POST /donations` for an order and the server decides the amount, fee and recipient. The platform keeps `DONATION_FEE_PCT` (default 5, rounded down to whole rupees); the rest, `net_inr`, is owed to the donor.

- **Settled exactly once.** An order moves from `created` to `paid` (razorpay) or `simulated` (demo) with a conditional update, and only the request that wins it writes the donor's and supporter's records. A confirm and a webhook for the same payment therefore never double count. Confirming an order that is already settled returns its current status and changes nothing.
- **Confirm.** `POST /donations/confirm` accepts a real order only with a valid `razorpay_signature`: HMAC-SHA256 of `order_id|razorpay_payment_id`, keyed with the key secret.
- **Webhook.** `POST /razorpay/webhook` has no JWT. The HMAC-SHA256 of the raw body, keyed with the webhook secret and sent in `X-Razorpay-Signature`, is the credential. `payment.captured` and `order.paid` settle the order even if the browser closed first.
- **Simulated mode.** With no Razorpay keys the whole flow runs in a SIMULATED mode: `mode` is `demo` and orders settle as `simulated`. Nothing is charged, the UI labels it, and simulated money never counts in `direct_inr` or `owed_inr`. It does count in the `supporters` and `supported_inr` totals on `GET /fund`, which are labelled as demo figures.
- **Keys.** The server reads `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` from the environment, or the Secrets Manager secret named by `RAZORPAY_SECRET_ARN` (`pantrypass/razorpay`). The browser only ever gets the public key id. There is no SDK dependency: the calls are plain HTTPS to Razorpay's REST API.
- **Money movement.** The payment is taken by the platform's Razorpay account. PantryPass does not pay donors itself: a coordinator sends the donor's share by bank transfer to the details the donor provided, then records the reference with `POST /payouts/{sub}/transfer`.

Go-live steps:

1. Run `infra/90_payouts.sh` if it has not run yet, then `RAZORPAY_KEY_ID=... RAZORPAY_KEY_SECRET=... RAZORPAY_WEBHOOK_SECRET=... bash infra/95_donations.sh`. The script stores the keys in Secrets Manager, lets the API role read that one secret and redeploys the API.
2. In the Razorpay dashboard, add a webhook to `<API_URL>/razorpay/webhook` for `payment.captured` and `order.paid`, using the same webhook secret.
3. Allow the site's origin in the Razorpay dashboard for Checkout.

## Error body

```json
{"error": "...", "action": "...", "actor": "...", "decision": "DENY", "request_id": "..."}
```

`decision` is `DENY` or another decision string returned by the policy check.

## Invariant

After receipt: `received = distributed + returned + disposed + remaining`.
