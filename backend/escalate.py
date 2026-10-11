"""Timeout branch: unanswered pickup becomes a coordinator exception.

Deliberately does NOT touch distributed/disposed/returned quantities.
"""
import json
import os
import time
import uuid

import boto3
from botocore.exceptions import ClientError

import trust

ddb = boto3.client("dynamodb")
LOTS = os.environ.get("LOTS_TABLE", "pantrypass-lots")
EVENTS = os.environ.get("EVENTS_TABLE", "pantrypass-events")


def handler(event, context):
    lot_id = event["lot_id"]
    now = int(time.time())
    lot = ddb.get_item(TableName=LOTS, Key={"lot_id": {"S": lot_id}}, ConsistentRead=True).get("Item")
    if not lot:
        raise ValueError("lot not found: " + lot_id)
    version = int(lot["version"]["N"])
    prev = lot.get("chain_head", {}).get("S", trust.GENESIS)
    length = int(lot.get("chain_len", {}).get("N", "0")) + 1
    event_id = f"{now:012d}#{uuid.uuid4().hex[:8]}"
    note = "Unanswered pickup; assigned to coordinator. No distribution or disposal inferred."
    result = json.dumps({"note": note})
    digest = trust.event_hash(prev, lot_id, event_id, "system", "ResponseDeadlineMissed", "ESCALATED", result, now)
    try:
        ddb.transact_write_items(TransactItems=[
            {"Update": {
                "TableName": LOTS,
                "Key": {"lot_id": {"S": lot_id}},
                "UpdateExpression": "SET stage = :s, version = :nv, chain_head = :h, chain_len = :n REMOVE task_token",
                "ConditionExpression": "attribute_exists(lot_id) AND stage = :offered AND version = :v",
                "ExpressionAttributeValues": {
                    ":s": {"S": "EXCEPTION"}, ":nv": {"N": str(version + 1)}, ":v": {"N": str(version)},
                    ":offered": {"S": "OFFERED"}, ":h": {"S": digest}, ":n": {"N": str(length)},
                },
            }},
            {"Put": {"TableName": EVENTS, "Item": {
                "lot_id": {"S": lot_id},
                "event_id": {"S": event_id},
                "action": {"S": "ResponseDeadlineMissed"},
                "actor": {"S": "system"},
                "decision": {"S": "ESCALATED"},
                "note": {"S": note},
                "result": {"S": result},
                "ts": {"N": str(now)},
                "prev_hash": {"S": prev},
                "hash": {"S": digest},
            }}},
        ])
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") == "TransactionCanceledException":
            # accepted (or otherwise moved on) between the deadline and now: nothing to escalate
            print(json.dumps({"msg": "escalation_skipped", "lot_id": lot_id}))
            return {"escalated": False}
        raise
    print(json.dumps({"msg": "escalated", "lot_id": lot_id}))
    return {"escalated": True}
