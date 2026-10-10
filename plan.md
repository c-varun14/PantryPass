# PantryPass: team plan

Two people, working in parallel, merging through pull requests. Deadline: Sunday 11 October 2026, 20:00 IST (target submission 17:30).

The API contract is the hand-off between us. If a route, field or error shape changes, change the contract table in `docs/api.md` first, in its own small PR, then the code.

## Ownership

### Varun: frontend and DevOps
- Static UI (plain HTML/CSS/JS, no build step): Lot, Receiver action, Exceptions and history screens.
- Role sign-in for donor, receiver and coordinator against Cognito.
- Hosting (S3 + CloudFront), `config.js` generation, CORS on the HTTP API, `infra/70_hosting.sh`, `infra/99_cleanup.sh`.
- Wiring new Lambda routes into the API (`infra/60_api.sh`).
- README, architecture diagram, writeup, demo video.

### Dhanalakshmi: backend
1. **Go Lambda for the new routes** (`backend/go/`):
   - `POST /lots/{id}/disposition` (returned / disposed)
   - `POST /lots/{id}/resolve-dispute` (coordinator)
   - `GET /lots` (list for the signed-in role)
   - Runtime `provided.al2023`, binary named `bootstrap`, deployed by a new `infra/41_lambda_go.sh`.
   - Must keep the same rules as the Python API: Verified Permissions decides, conditional writes, `idem_key` + `expected_version`, quantity invariant `received = distributed + returned + disposed + remaining`, error body shape from the contract.
2. **Review fixes in `backend/api.py`:**
   1. `POST /retry-callbacks` has no authorization check.
   2. The `force_bad_callback` test hook is in the live accept route.
   3. Idempotency keys are not bound to their action.
   4. `close` is blocked after cutoff even when `remaining == 0`.
   5. The donor chooses the cutoff in the create request.
3. **Tests:** extend `tests/run_gates.sh` with a negative test for every fix and every new route.
4. **Stretch, only if everything else is done:** port the existing routes to Go.

## Working agreements
- Branch per task (`feat/go-disposition`, `fix/retry-callbacks-auth`, `feat/ui-lot-screen`), small PRs into `main`, reviewed by the other person before merge.
- Commit small and often, with imperative messages in the existing style ("Add X").
- No secrets, passwords or `.env.generated` contents in the repo or in screenshots.
- Dependencies (including the Go toolchain and AWS SDK modules) are agreed between us before they are added.

## First steps
1. Varun: push the repo, add Dhanalakshmi as a collaborator, open issues for each task above.
2. Dhanalakshmi: install Go, clone, run `tests/run_gates.sh` once to confirm her AWS access works.
3. Both: agree `docs/api.md` (copy of the contract table) as the first PR, so neither side waits.

## Schedule
| Time | Varun | Dhanalakshmi |
|---|---|---|
| Sat evening to ~01:00 | UI skeleton, sign-in, Lot screen | Review fixes, start Go routes |
| Sun 07:30-09:30 | Hosting, point UI at live API, CORS | Finish Go routes, re-run full tests |
| Sun 09:30-11:00 | Receiver and Exceptions screens, rehearsal as three roles | Support rehearsal, bug fixes |
| Sun 11:00-13:30 | Polish, README, writeup | Review claims against the README |
| Sun 13:30-16:00 | Record video | Check video against the claims |
| Sun 16:00-17:30 | Upload and submit | Verify repo and team registration |
| Sun 17:30-20:00 | Buffer, no new features | Buffer |

## Cut list (in order)
1. Real handoff trial.
2. Dispute-resolution UI (keep the route and tests).
3. Go port of existing routes.
4. Anything not in the video.

Never cut: the donor denial, the durable wait, the quantity invariant, the exception path, the video.
