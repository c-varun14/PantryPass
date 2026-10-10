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

## Error body

```json
{"error": "...", "action": "...", "actor": "...", "decision": "DENY", "request_id": "..."}
```

`decision` is `DENY` or another decision string returned by the policy check.

## Invariant

After receipt: `received = distributed + returned + disposed + remaining`.
