# PantryPass demo script (3 minutes)

Target length: 3:00. All lots, names and quantities are synthetic demo data. Meera is a demo persona. No real donor, receiver, partner or food is shown or implied.

## Pre-recording prep

- [ ] Create the extra lot 2 minutes before recording, as the donor, for the receiver, and leave it in OFFERED so the 90s deadline runs out on camera (or pre-create it earlier and let the deadline pass before recording)
- [ ] Passwords for the three demo accounts come from the submission notes; do not show them on screen
- [ ] Use a clean browser profile with no saved sign-ins, extensions or notifications
- [ ] First half (opening to coordinator resolve) in a mobile viewport (375px wide, device toolbar on)
- [ ] Second half (close and limits) on desktop width (1280px)
- [ ] Close other tabs, hide bookmarks bar, set zoom to 100%
- [ ] Dry run once end to end and time it; cut anything over 3:00
- [ ] Confirm the hosted URL loads and the Refused panel appears before recording

## Shot list and narration

| Time | Screen / role | What to click | Narration line |
|---|---|---|---|
| 0:00-0:20 | Title card, then a chat thread with a spreadsheet (mock) | Slow pan over the chat and sheet | "Meera coordinates surplus food for a small distribution group. A donor says ten packets are on the way. Someone taps 'done', and the sheet now says ten distributed. Nobody actually confirmed that." |
| 0:20-0:35 | Sign-in, role cards | Tap **Donor** and sign in with the demo donor username | "PantryPass splits the three facts: offered, handed over, and received and distributed. Only the receiver can say what was distributed." |
| 0:35-0:55 | Donor home | Tap **New lot**, pick the demo receiver, keep quantity 10, tap **Offer lot** | "The donor offers ten packets to a named receiver. The donor does not get to write the receiver's numbers." |
| 0:55-1:10 | Donor, lot page (handoff declared) | Tap **Declare handoff**, enter 10, submit. The **Pickup code** card appears; hold on it. Scroll to **Report distribution** | "The donor declares a handoff and gets a one-time pickup code to give the receiver in person. Now the donor tries to mark it distributed." |
| 1:10-1:25 | Donor, hero card | Tap **Try it anyway** | "Verified Permissions refuses it. Nothing changed." (Pause on the deny panel and the DENY row in the timeline.) |
| 1:25-1:40 | Receiver, sign-in and home | Switch role via **Choose a different role**, sign in as the receiver, tap the lot under **Needs you**, tap **Accept lot** | "The receiver accepts. If nobody answers before the deadline, the lot becomes an exception. The system never assumes the food arrived." |
| 1:40-1:55 | Receiver, Report what arrived | Enter 8 (not 10) and the pickup code the donor showed, submit | "The receiver counts what actually arrived: eight, not ten, and types the code from the donor's phone. The lot is marked in person, and because the counts differ it is disputed." |
| 1:55-2:05 | Receiver, lot page | Show the **Counts disagree** banner and the compare boxes | "Disagreements stay visible. The lot cannot close while they differ." |
| 2:05-2:20 | Coordinator, Exceptions | Switch to coordinator, open **Exceptions**. Show the pre-created lot under **Unanswered pickup** (its 90s deadline has passed) and the dispute under **Count dispute** | "The pre-created lot was never answered. After ninety seconds it became an exception. No distribution is assumed." |
| 2:20-2:30 | Coordinator, Resolve dispute | Tap **Resolve dispute**, set the reconciled count to 8, save | "Meera confirms the real count with both sides and records 8. The timeline keeps the history." |
| 2:30-2:40 | Receiver, lot page | Report distribution 8, then tap **Confirm and close** | "The receiver reports distribution. Nothing is outstanding, and nothing is disputed." |
| 2:40-2:45 | Receiver, timeline | Show the **Accounted for** row and the **Record verified** badge; tap **Verify again** | "Only now is the lot marked accounted for, and every event is hash-chained, so the record can be re-checked at any time." |
| 2:45-2:52 | Coordinator, Impact card | Show the **Impact** card | "Counts of packets as reported by the people involved. Not meals, not kilograms, not avoided waste." |
| 2:52-3:05 | Title card with limits | Hold on the limits text | "PantryPass records who reported what, and keeps disagreements visible. It does not prove food was eaten, that food was safe, or that waste was avoided." |

## Live phone moment (record in the morning, about 30 seconds)

Needs: `.secrets.local` filled in and `infra/75_channel.sh` re-run, the Meta webhook pointing at `<API_URL>/webhook/whatsapp` with the verify token from `pantrypass/channel`, the three phones in `pantrypass-links`, and a fresh (non-expired) WhatsApp access token. Screen-record the phone on the left and the coordinator dashboard on the right.

| Step | Who sends | Exact message | What you should see |
|---|---|---|---|
| 1 | Donor phone | `HELP` | The command list. |
| 2 | Receiver phone gets a message | (automatic) | "New offer #xxxxxx ... Reply ACCEPT" after the donor offers a lot in the web app. |
| 3 | Receiver phone | `ACCEPT` | "Done: Accept. Now ACCEPTED." |
| 4 | Donor phone | `HANDOFF 10` | "Pickup code: 123456 (shown once ...)". |
| 5 | Donor phone | `DISTRIBUTED 5` | "Not allowed: ... refused by Verified Permissions for your role. Nothing changed." and a DENY row on the dashboard timeline. Never cut this. |
| 6 | Receiver phone | `RECEIVED 8 CODE 123456` | "Done ... Confirmed in person. Counts disagree ..." The coordinator phone gets a dispute message. |
| 7 | Coordinator | resolve in the web app (reconciled count 8) | Timeline shows the resolve event. |
| 8 | Receiver phone | `DISTRIBUTED 8`, then `CLOSE` | "Done: Close. Now ACCOUNTED_FOR." The donor gets the close message. |
| 9 | Dashboard | tap **Verify again** | "Record verified". |

If WhatsApp is not delivering by recording time, do not stage a fake chat. Use the web draft and state that the chat channel is built and tested (signature check, identity from the links table, same Verified Permissions guard) but not shown live.

## Honest limits (say these, do not skip)

- It records who reported what. It does not prove food was eaten or safe.
- Two people who agree on a false number would still pass.
- All lots, people and quantities in this demo are synthetic.
- The hash chain makes edits to a lot's history detectable. It does not stop someone who can rewrite both the events table and the lot's chain head.
- The web draft video uses text-to-speech narration; record a human voice over it if you prefer.

## Recording notes

- If a step runs long, cut the donor hero (keep the refusal, it is never cut).
- Never cut: the donor denial, the durable wait, the quantity invariant, the exception path, the closing line about limits.
