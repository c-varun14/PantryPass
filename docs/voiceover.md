# Voiceover script (read over the silent video)

Read at a calm pace. Times are targets per scene; the captions on screen carry the same meaning if you skip a line. About 480 words.

**1 · Problem (0:20)**
A donor says ten packets are on the way. Someone taps "done". The sheet says ten distributed. But nobody ever confirmed ten. Offered, handed over, and actually received are three different facts, and most tools blur them into one number.

**2 · What it is (0:15)**
PantryPass keeps them apart. Each person reports only their own part, and anything unconfirmed stays visibly open.

**3 · Donor, Asha (0:25)**
Asha is the donor. She offers ten packets to a named receiver. When she hands them over she declares it, and gets a one-time pickup code to give the receiver in person.

**4 · The refusal (0:10)**
Now Asha tries to mark it distributed. Refused. That decision is made by Verified Permissions, before any data is touched, using the role in her signed token, and the attempt is logged.

**5 · Receiver, Ravi (0:30)**
Ravi is the receiver. He accepts, counts eight, not ten, and types the code. The lot is marked in person, and because the counts differ, it is flagged. Only the receiver's number moves the stock.

**6 · Coordinator, Meera (0:35)**
Meera is the coordinator. One offer was never answered, so it became an exception on its own. A durable Step Functions wait handled that; nobody had to chase. She also sees the count that doesn't match, confirms eight with both sides, and the history stays.

**7 · Closing the loop (0:35)**
Ravi reports eight distributed and closes. Received equals distributed plus returned plus disposed plus remaining, and the lot is accounted for. Anyone can press Verify: every event is hash-chained, so editing the past turns it red. Ravi earns trust points for confirmed handoffs, never for quantity.

**8 · WhatsApp (0:20)**
The same rules run over WhatsApp, because that's where people already are. A donor texting "distributed five" gets the same refusal. [If not shown live: this is built and tested with signed test messages.]

**9 · How it's built on AWS (0:40)**
Amazon Cognito signs people in, and API Gateway checks the token at the door. Verified Permissions makes the allow-or-deny decision. Lambda, in Python and Go, runs the logic. DynamoDB stores lots and events with conditional writes, idempotency, and the hash chain. Step Functions waits for the receiver, and on timeout raises the exception. A DynamoDB stream drives WhatsApp notifications. S3 and CloudFront serve the site, Secrets Manager holds the keys, and CloudWatch and X-Ray show what's happening.

**10 · Limits and close (0:20)**
PantryPass records who reported what. It doesn't prove food was eaten or safe, or that waste was avoided. The next step is one real operator and one real lot.
