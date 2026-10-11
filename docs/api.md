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
| `POST /lots` | donor | `receiver_sub`, `offered` | 201 + lot | 403 `VP_DENY` |
| `POST /lots/{id}/accept` | assigned receiver | `idem_key`, `expected_version` | 200 + stage ACCEPTED | 403, 409 stage/version |
| `POST /lots/{id}/handoff` | donor of the lot | `idem_key`, `expected_version`, `donor_handoff` | 200 + HANDOFF_DECLARED | 403, 409 |
| `POST /lots/{id}/receipt` | assigned receiver | `idem_key`, `expected_version`, `received` | 200 + RECEIVED, `count_dispute` flag | 403, 409 |
| `POST /lots/{id}/distribution` | assigned receiver | `idem_key`, `expected_version`, `distributed` | 200 + new totals | 403, 409 over-report/cutoff |
| `POST /lots/{id}/close` | assigned receiver | `idem_key`, `expected_version` | 200 + ACCOUNTED_FOR | 409 outstanding stock/dispute |
| `GET /lots/{id}` | donor or receiver of the lot | none | lot + events | 403, 404 |
| `POST /lots/{id}/disposition` (new) | assigned receiver | `idem_key`, `expected_version`, `returned` and/or `disposed` | 200 + new totals | 403, 409 exceeds remaining |
| `POST /lots/{id}/resolve-dispute` (new) | coordinator | `idem_key`, `expected_version`, `reconciled_received` | 200 + new event | 403, 409 |
| `GET /lots/{id}/verify` (new) | donor, receiver of the lot, or coordinator | none | `{ok, length, head, lot_head, legacy, broken_at, reason}` | 403, 404 |
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

`GET /impact` (coordinator only): `{"lots": n, "offered": n, "received": n, "distributed": n, "returned": n, "disposed": n, "accounted_for": n, "disputes_caught": n, "exceptions_raised": n, "confirmed_in_person": n}`. Counts are packets as reported by the people involved. They are not meals, kilograms or avoided waste.

## Error body

```json
{"error": "...", "action": "...", "actor": "...", "decision": "DENY", "request_id": "..."}
```

`decision` is `DENY` or another decision string returned by the policy check.

## Invariant

After receipt: `received = distributed + returned + disposed + remaining`.
