"""DynamoDB Stream consumer for the events table: tells the right person about the
events that need them. It only reads and sends text; it never changes lot state.

offer -> receiver | handoff declared -> receiver (+ code reminder to donor) |
exception -> coordinators | count dispute -> coordinators | close -> donor
"""

import json
import os

import boto3

import chatio
import chatlogic as cl

ddb = boto3.client("dynamodb")
LOTS = os.environ.get("LOTS_TABLE", "pantrypass-lots")
LINKS = os.environ.get("LINKS_TABLE", "pantrypass-links")


def sv(img, k, d=""):
    v = img.get(k)
    return v.get("S", d) if isinstance(v, dict) else d


def phones_for_sub(sub):
    r = ddb.scan(TableName=LINKS, FilterExpression="sub = :s", ExpressionAttributeValues={":s": {"S": sub}})
    return [i["phone"]["S"] for i in r.get("Items", []) if "phone" in i]


def coordinator_phones():
    r = ddb.scan(TableName=LINKS, FilterExpression="#r = :c",
                 ExpressionAttributeNames={"#r": "role"}, ExpressionAttributeValues={":c": {"S": "coordinator"}})
    return [i["phone"]["S"] for i in r.get("Items", []) if "phone" in i]


def messages_for(img, lot):
    """[(phones, text)] for one new event image."""
    action, lot_id = sv(img, "action"), sv(img, "lot_id")
    if sv(img, "decision") not in ("ALLOW", "ESCALATED") or sv(img, "event_id").startswith("IDEM#"):
        return []
    try:
        res = json.loads(sv(img, "result", "{}") or "{}")
    except ValueError:
        res = {}
    tag = "#" + cl.short_id(lot_id)
    donor, receiver = sv(lot, "donor_sub"), sv(lot, "receiver_sub")
    if action == "CreateLot":
        return [(phones_for_sub(receiver), "New offer %s: %s packets. Reply ACCEPT %s to take it." % (tag, res.get("offered"), tag))]
    if action == "DeclareHandoff":
        return [
            (phones_for_sub(receiver), "Donor says %s packets were handed over for %s. When they arrive reply RECEIVED n (add CODE 123456 if the donor gives you a pickup code)." % (res.get("donor_handoff"), tag)),
            (phones_for_sub(donor), "Handoff recorded for %s. Give the pickup code you were shown to the receiver in person." % tag),
        ]
    if action == "ResponseDeadlineMissed":
        return [(coordinator_phones(), "Exception %s: no answer before the deadline. Nothing is assumed delivered. Please follow up." % tag)]
    if action == "Receipt" and res.get("count_dispute"):
        return [(coordinator_phones(), "Count dispute %s: donor said %s, receiver counted %s. It needs resolving in the web app." % (tag, lot.get("donor_handoff", {}).get("N", "?"), res.get("received")))]
    if action == "Close":
        return [(phones_for_sub(donor), "Lot %s is accounted for: every received packet is distributed, returned or disposed." % tag)]
    return []


def handler(event, context):
    sent = 0
    for rec in event.get("Records", []):
        if rec.get("eventName") != "INSERT":
            continue
        img = rec.get("dynamodb", {}).get("NewImage", {})
        lot_id = sv(img, "lot_id")
        lot = ddb.get_item(TableName=LOTS, Key={"lot_id": {"S": lot_id}}).get("Item") or {}
        for phones, text in messages_for(img, lot):
            for ph in phones:
                if chatio.send_text(ph, text):
                    sent += 1
    print(json.dumps({"msg": "notified", "sent": sent}))
    return {"sent": sent}
