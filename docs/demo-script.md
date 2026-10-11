# PantryPass demo video: shot list (v7, 2:55)

Recorded against the live site by `demo/v7/capture.mjs` (Playwright, one continuous take) and voiced with Kokoro; the narration is in `docs/voiceover.md`. Every scene has a pinned perspective badge (top), a one-sentence caption (bottom) and, where it helps, one callout, so it also works with the sound off. Under 3:00.

The story is told for someone who has never seen the product: problem and idea, one lot end to end, why money belongs here, why this stack and not just Postgres, then the account and the close.

| Act | Scene (badge) | ~Time | On screen | Point it lands |
|---|---|---|---|---|
| 1 | Hook | 0:12 | "10 trays distributed. Nobody confirmed 10." then the PantryPass card | The problem, and the one idea: each person reports only their own part |
| 2 | DONOR Asha, then RECEIVER Ravi | 0:20 | Announce 10 trays to every receiver; Ravi claims the open offer | First to claim wins, nothing double booked |
| 2 | DONOR Asha | 0:08 | Declare handoff with a photo; one-time pickup code | The handover is confirmed in person |
| 2 | DONOR Asha | 0:11 | "Try it anyway" on Report distribution; refusal panel | The key rule, decided by Verified Permissions before data is touched |
| 2 | RECEIVER Ravi | 0:10 | Counts 8, photo, pickup code; "Counts don't match" | A mismatch surfaces by itself |
| 2 | COORDINATOR Meera | 0:08 | Exceptions; both photos; settle at 8 | Someone decides with evidence |
| 2 | RECEIVER Ravi | 0:08 | Report given out; close | Everything adds up |
| 2 | Verify | 0:11 | Record verified; a real edit in DynamoDB; Record does not match | History cannot be quietly rewritten |
| 3 | RECEIVER Ravi | 0:13 | Fund page: pool funded through Razorpay, top donor and verified volume | Why give: verified giving pays, a bigger verified amount earns more, up to a cap |
| 3 | RECEIVER Ravi, as a supporter | 0:10 | Support sheet: 500 rupees, "every rupee reaches the donor", Donate | Direct donations to top donors; PantryPass keeps nothing |
| 3 | COORDINATOR Meera (volunteer) | 0:14 | Payouts table (masked account), Run payouts, result and owed drops to zero | One click, Razorpay pays; she never sees an account number |
| 4 | AWS | 0:38 | One animated sequence in three chapters | Why not just Postgres: the rules live in services (Cognito, API Gateway, Verified Permissions; Step Functions, conditional writes, IAM deny; KMS, Secrets Manager); a server, not a person, pays donors |
| 5 | AWS account, close | 0:10 | Account card, then the logo and tagline | No cut taken: sponsors, open source and volunteers keep it running; trust you can inspect |

## Live phone moment (record in the morning, about 30 seconds)
Needs: `.secrets.local` filled in and `infra/75_channel.sh` re-run, the Meta webhook pointing at `<API_URL>/webhook/whatsapp` with the verify token from `pantrypass/channel`, three phones in `pantrypass-links`, a fresh WhatsApp access token.

| Step | Who sends | Exact message | What you should see |
|---|---|---|---|
| 1 | Donor phone | `HELP` | The command list |
| 2 | Receiver phone gets a message | (automatic) | "New offer #xxxxxx ... Reply ACCEPT" after the donor offers in the web app |
| 3 | Receiver phone | `ACCEPT` | "Done: Accept. Now ACCEPTED." |
| 4 | Donor phone | `HANDOFF 10` | "Pickup code: 123456 (shown once ...)" |
| 5 | Donor phone | `DISTRIBUTED 5` | "Not allowed: ... refused by Verified Permissions ... Nothing changed." plus a DENY row on the dashboard |
| 6 | Receiver phone | `RECEIVED 8 CODE 123456` | "Done ... Confirmed in person. Counts disagree ..." |
| 7 | Coordinator | resolve to 8 in the web app | Resolve event in the timeline |
| 8 | Receiver phone | `DISTRIBUTED 8`, then `CLOSE` | "Accounted for"; the donor gets the close message |
| 9 | Dashboard | Verify again | "Record verified" |

If WhatsApp isn't delivering by recording time, don't stage a fake chat. Use the honest card in scene 8.

## Honest limits (always on screen in scene 10)
- It records who reported what. It does not prove food was eaten or safe.
- Two people who agree on a false number would still pass.
- The hash chain catches any edited, removed or reordered event, and IAM stops our own code from editing history; anchoring chain heads in a write-once bucket is next.
- All lots, people and quantities are synthetic.
