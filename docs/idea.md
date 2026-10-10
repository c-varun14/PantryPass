# PantryPass: the idea

## The problem

When surplus food moves from a donor to a receiving group, three different facts get blurred into one: the donor *offered* it, someone *picked it up*, and the receiver *received and distributed* it. In a chat thread or a spreadsheet, whoever updates last wins, and a coordinator ends up recording "10 packets distributed" because a donor tapped "done".

## The user and the moment

Meera coordinates surplus food for a small Bengaluru distribution group (a demo persona, not a real person or partner). A donor says ten sealed packets are on their way. A driver has supposedly collected them. The receiver has not confirmed a count. Meera cannot responsibly record anything as distributed yet, and she needs to know what still needs her attention.

## The idea

A lot moves through stages, and each stage can only be advanced by the right person:

1. The donor offers a lot.
2. The assigned receiver accepts or declines. If nobody answers by a deadline, it becomes an exception for the coordinator. The system never assumes the food arrived.
3. The donor declares how many they handed over; the receiver independently reports how many they received. If the counts differ, the lot is flagged as a dispute and stays open.
4. The receiver reports how many were distributed, returned or disposed of. Those can never add up to more than was received.
5. The lot is only marked **accounted for** when nothing is outstanding and nothing is disputed.

A donor cannot write the receiver's numbers. Two requests with the same key do not double-count. A late request is rejected using the server's clock.

## What it does not claim

It does not prove food was eaten, that food was safe, or that waste was avoided. It records who reported what, and keeps disagreements visible. Two people who agree on a false number would still pass. The aim is a trustworthy record of reports and a clear next action, not proof of the physical world.

## Why AWS

| Service | Job in this app |
|---|---|
| Step Functions (Standard) | Durable wait for the receiver, with a timeout that becomes an exception |
| Verified Permissions | Decides who may take each action on a particular lot |
| Cognito | Signed identities for donor, receiver and coordinator |
| DynamoDB | Conditional writes for versions, quantities and replay protection |
| Lambda + HTTP API | The checks that run before any state change |
| CloudWatch | Structured logs tying each request to a lot and a workflow execution |

## How the idea developed

- **8 October:** started the project and explored directions for the event. Several earlier ideas were set aside.
- **9 October:** compared candidate ideas against the judging criteria and the data and hardware actually available, and chose PantryPass. Narrowed it to a single donor, receiver and lot, and wrote down what it would and would not claim.
- **10 October:** built the backend and ran a test suite against it on AWS.
- **11 October:** UI, hosting, demo video and submission.
