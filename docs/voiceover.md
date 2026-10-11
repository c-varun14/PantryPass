# Voiceover script (v7, 2:56)

Generated with Kokoro (`demo/v7/make_audio.py`, voice `af_heart`, speed 1.0) from `demo/v7/narration.json`. The word AWS is written with a phoneme override, `[AWS](/ˌeɪ ˈdʌbəlju ˈɛs/)`, because the default reading drops the leading "A"; the text below shows it as plain AWS.

**Shape:** one story in five acts, so someone who has never seen the product can follow it. (1) The problem and the one idea: each person reports only their own part. (2) One lot, end to end, on the live app: announce, claim, handover with a photo and a code, the refusal, the 10 versus 8 mismatch, the coordinator's settlement, and a real edit that turns Verify red. (3) Why money belongs here: incentives only work when the counts cannot be gamed, so the fund, direct donations (Razorpay, simulated until keys are connected) and bank payouts all hang off the verified record. (4) Why this stack and not just Postgres: Postgres could store the lots, but cannot make the rules hold if our own code has a bug, so the rules live in AWS services (Cognito and API Gateway, Verified Permissions, Step Functions, DynamoDB conditional writes, an IAM deny on edits, KMS and Secrets Manager); serverless also fits a food bank's budget. (5) The account card and the close. Tagline: "Trust you can inspect, not code you have to believe."

**Hook: the problem and the idea (11 s)**
Surplus food moves on trust and WhatsApp. Ten trays sent, and nobody can say how many arrived. PantryPass keeps each person to their own part, so the count can't be wrong.

**Announce and claim (13 s)**
Three people use it. Asha, a donor, announces ten trays of rice and dal to every receiver at once. Ravi, a receiver, claims it. The first to claim wins, so nothing is double booked.

**Handover with a photo and a pickup code (7 s)**
At the handover, Asha photographs the trays and gets a one-time pickup code to give Ravi in person.

**The key rule: the refusal (11 s)**
Now the key rule. Asha tries to mark it distributed. Refused: only the receiver can say that, and AWS enforces it before any data is touched.

**The count, and the mismatch (8 s)**
Ravi counts eight, not ten. He photographs what arrived and types the pickup code. The mismatch is flagged, and no one can hide it.

**The coordinator settles it (6 s)**
Meera, the coordinator, sees both photos, ten trays then eight, and settles the count at eight.

**Close (5 s)**
Ravi gives out the eight trays and closes the lot. Everything adds up.

**Verify, and a real edit that turns it red (10 s)**
And nobody can quietly rewrite it. Every event is chained to the one before. Change a single one behind the app's back, and Verify turns red.

**Why give: the fund (10 s)**
Why give? Verified giving pays. Sponsors fund a monthly pool shared by trust points, and a bigger verified amount earns more, up to a cap.

**Support a top donor (Razorpay, simulated) (12 s)**
Donors with a proven record become top donors. Anyone can support them directly through Razorpay checkout, simulated until keys connect. PantryPass keeps five percent.

**Bank details and the coordinator payout (15 s)**
Donors add bank details, kept encrypted and shown only masked. Meera sees what each donor is owed, reveals an account only to pay, and records the transfer. Sponsors get a tamper-evident record of what was really received.

**Why not just Postgres? The rules live in services (16 s)**
Why not just Postgres? It could store the lots, but not make the rules hold if our own code has a bug. So the rules live in AWS services: Cognito proves who you are, API Gateway checks it, Verified Permissions decides each action.

**The wait, concurrency and history (12 s)**
Step Functions holds the wait, and escalates if nobody claims. Conditional writes stop two people changing a lot at once. IAM stops even our own code editing history.

**The money: KMS and Secrets Manager (9 s)**
Bank details are sealed by KMS, the gateway key sits in Secrets Manager, and it is all serverless: nothing to patch.

**Close (7 s)**
PantryPass. Trust you can inspect, not code you have to believe. Powered by AWS, in Mumbai.
