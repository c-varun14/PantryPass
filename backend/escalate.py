"""Timeout branch: unanswered pickup becomes a coordinator exception.

Deliberately does NOT touch distributed/disposed/returned quantities.
"""
import json
import os
import time
import uuid

import boto3

ddb = boto3.client("dynamodb")
LOTS = os.environ.get("LOTS_TABLE", "pantrypass-lots")
EVENTS = os.environ.get("EVENTS_TABLE", "pantrypass-events")


def handler(event, context):
    lot_id = event["lot_id"]
    now = int(time.time())
    ddb.update_item(
        TableName=LOTS,
        Key={"lot_id": {"S": lot_id}},
        UpdateExpression="SET stage = :s, version = version + :one REMOVE task_token",
        ConditionExpression="attribute_exists(lot_id) AND stage = :offered",
        ExpressionAttributeValues={
            ":s": {"S": "EXCEPTION"},
            ":one": {"N": "1"},
            ":offered": {"S": "OFFERED"},
        },
    )
    ddb.put_item(
        TableName=EVENTS,
        Item={
            "lot_id": {"S": lot_id},
            "event_id": {"S": f"{now:012d}#{uuid.uuid4().hex[:8]}"},
            "action": {"S": "ResponseDeadlineMissed"},
            "actor": {"S": "system"},
            "decision": {"S": "ESCALATED"},
            "note": {"S": "Unanswered pickup; assigned to coordinator. No distribution or disposal inferred."},
            "ts": {"N": str(now)},
        },
    )
    print(json.dumps({"msg": "escalated", "lot_id": lot_id}))
    return {"escalated": True}
