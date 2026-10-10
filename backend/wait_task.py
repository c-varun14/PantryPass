"""Parks the Step Functions task token in the lot item, then returns.

The token is stored server-side only and is never returned by any API.
"""
import json
import os
import time

import boto3

ddb = boto3.client("dynamodb")
LOTS = os.environ.get("LOTS_TABLE", "pantrypass-lots")


def handler(event, context):
    lot_id = event["lot_id"]
    ddb.update_item(
        TableName=LOTS,
        Key={"lot_id": {"S": lot_id}},
        UpdateExpression="SET task_token = :t, wait_started = :n",
        ExpressionAttributeValues={":t": {"S": event["token"]}, ":n": {"N": str(int(time.time()))}},
    )
    print(json.dumps({"msg": "token_parked", "lot_id": lot_id}))
    return {"parked": True}
