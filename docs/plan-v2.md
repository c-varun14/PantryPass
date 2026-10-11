# PantryPass v2 plan: a count that stays right, explained clearly (UI, video, rewards, AWS story)

## Context
Feedback on the first draft: the pitch is weak, the UI is average and a first-time user cannot tell what the app is for, the demo never says whose perspective is on screen, nothing explains what runs on AWS, and the README/demo over-emphasise the donor refusal. The user will record the voiceover themselves, so **the video must be understandable with the sound off**: captions, perspective badges, scene titles, on-screen callouts. No TTS (flite and Kokoro are both dropped). Chosen by the user: **full visual redesign**, **rewards = verified behaviour only, server-derived and auditable**. Deadline: submit target Sun 11 Oct 17:30 IST, hard 20:00.

Standing constraints: no new repo dependencies (plain JS/CSS, system fonts, inline SVG); **no Claude attribution** in commits/PRs; run `scripts/as.sh varun|lakshmi` before every commit (UI/docs/demo/infra = c-varun14, backend/tests = dhanalakshmi-D04); never commit `demo/`, `MORNING.md`, `.secrets.local`, `docs/overnight-plan.md`; delete nothing (the ~30 old unanswered lots stay; the UI collapses old ones); `gh pr merge` is blocked by the classifier, so PRs stack on `fix/signin-submit` (#13).

## 0. The emphasis correction (applies to README, pitch, script, UI copy, video)
The donor refusal is a **10-second proof, not the product**. A role check is one `if`; a judge will say so. The product is **a count that stays right**: surplus-food handoffs run on trust and WhatsApp messages, nobody can say afterwards how many packets arrived, where they went or what was thrown away, and PantryPass is the record that answers that and can't be quietly corrected by the wrong person.

Sentence to land everywhere: **"The count can't be wrong because the person who benefits from saying 'done' isn't allowed to say it."**

Why it is not just a database feature (to state plainly in README, About page and script):
- The check runs in **Verified Permissions (Cedar)** *before any data is touched*; a database column cannot say "this user may not do this action on this lot". The role comes from the signed Cognito token, never from the client. Every refusal is also written as a **DENY event**, so the audit trail shows the attempt. This is the part where "AWS is doing the enforcing".
- The refusal is only the visible part. What makes the count trustworthy: conditional writes (two people can't change a lot at once); idempotency keys (double-tap or retry never double-counts); `received = distributed + returned + disposed + remaining` enforced on every write; an unanswered pickup becomes an exception through a **durable Step Functions wait** (nobody has to remember to chase it); the **pickup code** and **hash-chained record** show the handoff happened in person and history wasn't edited; and a **WhatsApp channel** under the same guards, because that's where people already are.
- Honest framing of strength: depth that survives questions (ask a judge to double-tap, retry, or leave a pickup unanswered and it stays correct), a real problem with a clear story, a live deployed demo, and the chat channel. Not promising a win; not claiming WhatsApp is live until it is.

**README opening is rewritten**: problem first (the unreliable-count gap), then "what PantryPass guarantees", with the refusal as one proof among several. The Meera paragraph says "the count stays right", not "the donor is refused". "What works today" is reordered the same way. Same treatment for the first lines of `docs/idea.md` if they lead with the refusal.

## 1. Pitch and demo script (me, not delegated): `docs/pitch.md` (new), `docs/demo-script.md` (rewritten), plus `docs/voiceover.md` (new, for the user to read)
Arc, ~3:30 (ordering follows the correction: problem first, refusal short, depth longest):
| Scene | View label on screen | Time | What the viewer should understand (captioned) |
|---|---|---|---|
| 1 Problem | Title card, no user | 0:20 | Donor says "10 packets", someone taps done, the sheet says 10 distributed, nobody confirmed. Three different facts: offered / handed over / actually received. |
| 2 What it is | Title card | 0:15 | "A shared record where each person can only report their own part, and anything unconfirmed stays visibly open." |
| 3 Donor offers + hands over | DONOR · Asha | 0:25 | Offer to a named receiver; handoff gives a one-time pickup code. |
| 4 The refusal | DONOR · Asha | 0:10 | Donor tries "Report distribution": refused. Callout: "Decided by Verified Permissions before any data was touched. Role from the signed token. Logged as DENY." |
| 5 Receiver counts | RECEIVER · Ravi | 0:30 | Accepts, reports 8 (not 10) with the code: "In person" badge, "Counts don't match" banner. Callout: only the receiver's number moves the stock. |
| 6 Nobody chased it | COORDINATOR · Meera | 0:35 | An offer nobody answered became an Exception on its own (durable Step Functions wait). The count mismatch is listed. Meera resolves it to 8; history stays. |
| 7 Closing and proof | RECEIVER, then ANYONE | 0:35 | Distributes 8, closes; "Accounted for"; the 4-number equation shown; **Record verified** (hash chain), Verify again. Callout: "Edit any past event and this turns red." Trust points awarded (see 2b). |
| 8 Same rules over WhatsApp | PHONE | 0:20 | Live clip recorded by the user (needs Meta credentials); if not available a card says "built and tested with signed test messages, not shown live". Donor texting `DISTRIBUTED 5` gets the same refusal. |
| 9 How it's built on AWS | Architecture screen | 0:40 | Services light up one by one with a one-line job each (see below). |
| 10 Honest limits + close | Title card | 0:20 | Records who reported what; doesn't prove food was eaten/safe, or avoided waste; two people agreeing on a false number would pass; next step: one real operator, one real lot. |

**AWS explanation (scene 9 and the in-app About page, same diagram):** Cognito + API Gateway (who you are; JWT checked at the door) → Verified Permissions/Cedar (the policy decision) → Lambda (Python for the flow, Go for list/disposition/dispute) → DynamoDB (lots + events: conditional writes, idempotency markers, hash-chained events; links table for chat identities) → Step Functions Standard (durable wait for the receiver; timeout calls the escalate Lambda) → DynamoDB Streams + notifier Lambda → WhatsApp Cloud API (messages) ← webhook Lambda (HMAC-verified, identity only from the links table) → S3 + CloudFront (the site) → Secrets Manager (WhatsApp secrets) → CloudWatch dashboard, metric filters, X-Ray (what we can see). One sentence each, with a "what would break without it" line.

`docs/voiceover.md`: the narration text per scene, written to be spoken, with target seconds per scene so the user can read along while watching; captions in the video carry the same meaning silently.

## 2. UI full redesign (IA and design decisions by me; slices to Haiku 5.5 agents; I review every diff and screenshot)
Files: `web/index.html`, `web/css/{tokens,base,components}.css`, `web/js/main.js`, `js/ui.js`, `js/logic.js`, `js/views/{signin,lots,lot,exceptions,history}.js`, new `js/views/{welcome,about}.js`, `tests/logic.test.mjs`. Reuse store/mock/api, role switcher, `nextAction()`, `exceptionKinds`, quantity bar, sheets/toasts, pickup-code card, Record-verified badge.
- **Visual system**: new tokens (deep green primary, warm neutrals, per-role accent: donor amber / receiver blue / coordinator violet), bigger type scale with tabular numerals for counts, roomier spacing, softer cards, inline-SVG icons, dark mode kept, mobile-first with a real desktop two-pane.
- **Welcome screen (signed out)**: states the purpose in one sentence, the "count that stays right" idea, a 3-step how-it-works, who-does-what for the three roles, "Try the demo" persona cards (Asha donor, Ravi receiver, Meera coordinator), link to About. Purpose + roles + steps must be above the fold at 390×844.
- **Persistent role banner on every screen**: "You are Ravi · Receiver. Your job: confirm what arrived and report what went out." This is also what makes perspective obvious in the video.
- **Lot page**: 6-step tracker (Offered → Accepted → Handed over → Received → Distributed → Accounted for), "What happens next / what you can do now" in plain words, counts labelled Offered / Handed over / Received / Distributed with a one-line hint, "the numbers add up" equation, jargon removed ("Count dispute" → "Counts don't match").
- **Empty states** that say what to do next. **Exceptions**: grouped by kind, newest first, older collapsed under "Show N older" (this also fixes the demo clutter without deleting data).
- **About page `#/about`**: what it is, what it guarantees, what it doesn't claim, and the AWS architecture diagram + "what runs where" table (used on screen in video scene 9).
- Tests: keep the 87 node tests green, add tests for tracker mapping, banner text, copy helpers, exceptions collapse, rewards card. Visual QA: Playwright screenshots at 390×844 and 1280×800, light and dark, for welcome, each role home, lot at each stage, exceptions, about; viewed and iterated.

## 2b. Rewards ("Trust points"): verified behaviour only, derived server-side
Recognition only (points, levels, badges), never prizes or money, never based on quantity.
- Points per lot from the lot + its hash-chained events. Receiver: accepted before the deadline +3; receipt confirmed in person +5; reported count matched donor's +5; lot closed fully accounted for +10. Donor: lot accounted for with matching counts +10; handoff confirmed in person +5. Coordinator: resolved a count dispute +3; exception followed up to Accounted for +3.
- No deductions: an honest mismatch or an unanswered offer simply earns nothing, so nobody is paid to inflate a number. No leaderboard; own card plus a community total of lots accounted for.
- Levels Seedling → Helper → Steward; badges (First clean handoff, Face to face ×5, Quick responder ×3, Closer ×3, Tie-breaker ×3), each with a visible rule.
- Backend (dhanalakshmi-D04): pure `backend/rewards.py` (`compute_rewards(sub, role, lots, events_by_lot)` → `{points, level, next_level_at, badges, ledger:[{lot_id, reason, points, event_hash}]}`), route `GET /rewards` in `backend/api.py` (caller's own data only), wired in `infra/60_api.sh`; `docs/api.md` updated first in its own small PR; `tests/test_rewards.py` (every rule, no quantity-only points, tampered chain earns nothing, never negative); live check appended to `tests/live_trust.py` (run only after video capture).
- UI: "Your trust points" card on each home (level, progress, badges with rules, "Why do I have these points?" ledger linking to Record verified), CSS-only celebration toast honouring `prefers-reduced-motion`, mock API in step, footnote "Points reflect confirmed handoffs, not how much food. Recognition only."

## 3. Video v2: self-explanatory without sound (`demo/`, git-ignored)
- Silent master `demo/pantrypass-web-v2.mp4` (1280×720, H.264) with **burned-in captions** (one plain sentence per beat), a **perspective badge** pinned top-left on every scene ("DONOR · Asha", "RECEIVER · Ravi", "COORDINATOR · Meera", "PHONE"), **scene title cards** ("Scene 5 · The receiver counts what really arrived"), and **callout boxes** that point at the thing that matters (deny panel, In person badge, Counts don't match banner, exception row, Record verified). Pace is slow enough to read (≥2.5 s per caption plus reading time), scene lengths follow the table in §1 so the user can read `docs/voiceover.md` over it.
- Capture: Playwright 1.61 (from `~/.npm/_npx/e41f203b7505f1fb/node_modules`), headless Chromium, desktop 1280×720 so the role banner, tracker and two-pane layout are legible; one scripted run on the live CloudFront URL with real sign-ins, real refusal, real exception (create the unanswered lot ~100 s before it is shown). Overlays are injected by the capture script only (not part of the app). Scene 9 navigates to `#/about` and highlights each service as its caption appears. Scene 8 uses the user's phone clip if supplied, else the honest card.
- Mux with ffmpeg; also export a version with a silent AAC track so the user's voiceover can be dropped in. Old draft kept.
- Pre-steps: re-run `infra/25_demo_passwords.sh` (`DEMO_PASSWORD` from `.secrets.local`, never printed on screen); don't run gate/live scripts during capture (they reset passwords).

## 4. Delivery and order (time-boxed to fit the 17:30 target)
1. **Me, first (≈40 min):** README opening + `docs/idea.md` intro rewrite, `docs/pitch.md`, `docs/demo-script.md`, `docs/voiceover.md`, copy a version of this plan to `docs/plan-v2.md` (the md file the user asked for).
2. **Backend rewards** (Lakshmi identity) in parallel with UI: API contract PR first, then `rewards.py` + route + tests, deploy with `40_lambda.sh` and `60_api.sh`.
3. **UI redesign** on branch `feat/ux-redesign` off `fix/signin-submit`: small commits (tokens/base → welcome+about → role banner+lot page → lists/exceptions → rewards card → tests), screenshots reviewed between slices; publish via `infra/70_hosting.sh` (+ CloudFront invalidation if stale copies persist).
4. **Capture and mux video**, extract and review frames per scene.
5. Update `MORNING.md`; open PRs (stacked: #14 contract, #15 rewards, #16 UI/docs); final report with exactly what was and wasn't verified.

## Verification
- `node --test tests/logic.test.mjs`; `python3 -m unittest discover -s tests -p 'test_*.py'` (existing 105 + rewards); `go test ./...` in `backend/go` (unchanged).
- Screenshots reviewed for every key screen (light/dark, 390 and 1280). First-time-user check: the signed-out page answers "what is this, who is it for, what do I do" without scrolling on 390×844.
- Live: sign in as all three roles on CloudFront; `GET /rewards` returns a ledger whose event hashes match `/verify`; after the capture run `python3 tests/live_trust.py` then `infra/25_demo_passwords.sh`.
- Video: `ffprobe` (duration ≈3:30, video stream, silent audio track), a frame at each scene start shows badge + caption, scene 9 shows every AWS service named in `docs/voiceover.md`, nothing in `git status` from `demo/`. Watched with sound off: every scene must still make sense.
