# PantryPass demo video: shot list and on-screen captions (about 3:30)

The video must make sense **with the sound off**. Every scene has a pinned perspective badge (top-left), a one-sentence caption (bottom), and a callout on the thing that matters. The presenter records a voiceover from `docs/voiceover.md`. All lots, names and quantities are synthetic; Asha, Ravi and Meera are demo personas.

Emphasis: the problem and the trustworthy count lead. The donor refusal is a ten-second beat, not the story.

| # | Scene (badge) | Time | On screen | Caption (burned in) | Callout |
|---|---|---|---|---|---|
| 1 | Title card (no user) | 0:20 | Chat bubbles + a sheet: "10 on the way" → "Done" → "10 distributed" | "Offered, handed over and actually received are three different facts. Most tools blur them into one." | "Nobody confirmed 10." |
| 2 | Title card | 0:15 | PantryPass welcome screen | "PantryPass: each person reports only their own part. Anything unconfirmed stays visibly open." | |
| 3 | DONOR · Asha | 0:25 | Offer 10 packets to Ravi; declare handoff 10; pickup-code card | "Asha offers 10 packets to a named receiver, then declares the handoff and gets a one-time pickup code." | Pickup code card: "Give this to the receiver in person" |
| 4 | DONOR · Asha | 0:10 | "Try it anyway" on Report distribution; refusal panel; DENY row | "Asha tries to mark it distributed. Refused." | "Decided by Verified Permissions before any data was touched. Role from the signed token. Logged as DENY." |
| 5 | RECEIVER · Ravi | 0:30 | Accept; Report received: 8 with the code; In-person badge; "Counts don't match" | "Ravi accepts, counts 8 (not 10), and types Asha's code." | "Only the receiver's number moves the stock." / "In person" badge / mismatch banner |
| 6 | COORDINATOR · Meera | 0:35 | Exceptions: unanswered offer + counts don't match; resolve to 8 | "Nobody answered one offer, so it became an exception on its own. The mismatch is listed. Meera confirms 8; history stays." | "Durable Step Functions wait: nobody had to chase." |
| 7 | RECEIVER · Ravi, then anyone | 0:35 | Distribute 8; close; tracker reaches "Accounted for"; equation 8 = 8 + 0 + 0 + 0; Record verified; Verify again; trust points | "Everything is distributed, nothing is outstanding or disputed, so the lot closes." | "Edit any past event and this turns red." / "received = distributed + returned + disposed + remaining" |
| 8 | PHONE | 0:20 | User's WhatsApp clip (HELP, ACCEPT, `DISTRIBUTED 5` refused) or the honest card | "The same rules over WhatsApp." / "Built and tested with signed test messages; not shown live." | |
| 9 | ARCHITECTURE | 0:40 | `#/about` diagram, services highlighted in order | One caption per service (see `docs/voiceover.md`) | Highlight follows the caption |
| 10 | Title card | 0:20 | Limits | "It records who reported what. It does not prove food was eaten or safe, or that waste was avoided." | "Next: one real operator, one real lot." |

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
- The hash chain detects edited history; it does not stop someone who can rewrite both the events table and the chain head.
- All lots, people and quantities are synthetic.
