"""PantryPass API Lambda (HTTP API, payload v2).

Trust boundary: the ONLY trusted caller identity is the Cognito JWT authorizer
claims (sub + cognito:groups). Role, resource ownership, stock totals and server
time are derived here. Nothing in the request body can change an authorization
decision or an inventory total.

Every mutating route, in order:
  1. load the authoritative lot (server state)
  2. Verified Permissions IsAuthorized with a server-built principal/action/resource,
     require ALLOW with zero errors (DENY -> 403 + attributed rejection event)
  3. validate stage, expected_version, idempotency key, quantity/cutoff on server time
  4. TransactWriteItems (lot update with version condition + event + idem marker)
  5. after commit, SendTaskSuccess for a relevant callback; on failure set
     callback_pending=true for retry via POST /retry-callbacks
"""

import json
import os
import time
import uuid

import boto3
from botocore.exceptions import ClientError

import trust

ddb = boto3.client("dynamodb")
sfn = boto3.client("stepfunctions")
vp = boto3.client("verifiedpermissions")

LOTS = os.environ["LOTS_TABLE"]
EVENTS = os.environ["EVENTS_TABLE"]
POLICY_STORE_ID = os.environ["POLICY_STORE_ID"]
STATE_MACHINE_ARN = os.environ["STATE_MACHINE_ARN"]

NS = "PantryPass"
# Server-set response deadline for the durable wait. Never read from a request body.
RESPONSE_DEADLINE_SECONDS = int(os.environ.get("RESPONSE_DEADLINE_SECONDS", "90"))
PICKUP_TTL_SECONDS = int(os.environ.get("PICKUP_TTL_SECONDS", "3600"))
# Attributes that never leave the server: the callback token and the pickup code material.
HIDDEN = {"task_token", "pickup_hash", "pickup_salt"}


# ---------------------------------------------------------------- small helpers

def s(item, key, default=None):
    v = item.get(key)
    return v.get("S", default) if isinstance(v, dict) else default


def num(item, key, default=None):
    v = item.get(key)
    if isinstance(v, dict) and "N" in v:
        try:
            return int(v["N"])
        except (TypeError, ValueError):
            return default
    return default


def flag(item, key, default=False):
    v = item.get(key)
    return v.get("BOOL", default) if isinstance(v, dict) else default


def bint(body, key):
    v = body.get(key)
    if v is None:
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def resp(status, body):
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json"},
        "body": json.dumps(body),
    }


def log(**kw):
    kw.setdefault("ts", int(time.time()))
    print(json.dumps(kw))


def public(item):
    """Convert a raw DynamoDB item to a plain dict, never exposing HIDDEN attributes."""
    out = {}
    for k, v in item.items():
        if k in HIDDEN:
            continue
        if not isinstance(v, dict):
            continue
        if "S" in v:
            out[k] = v["S"]
        elif "N" in v:
            out[k] = int(v["N"])
        elif "BOOL" in v:
            out[k] = v["BOOL"]
        elif "NULL" in v:
            out[k] = None
    return out


def role_from_claims(claims):
    g = claims.get("cognito:groups")
    if isinstance(g, list):
        groups = g
    else:
        groups = [x.strip() for x in str(g or "").strip("[]").split(",") if x.strip()]
    if "donor" in groups:
        return "donor"
    if "receiver" in groups:
        return "receiver"
    if "coordinator" in groups:
        return "coordinator"
    return "user"


def get_lot(lot_id):
    r = ddb.get_item(TableName=LOTS, Key={"lot_id": {"S": lot_id}}, ConsistentRead=True)
    return r.get("Item")


# ------------------------------------------------------------------- policy gate

def vp_entities(sub, role, lot):
    users = [{
        "identifier": {"entityType": NS + "::User", "entityId": sub},
        "attributes": {"role": {"string": role}},
    }]
    lot_entity = None
    if lot is not None:
        donor = s(lot, "donor_sub")
        recv = s(lot, "receiver_sub")
        for uid, r in ((donor, "donor"), (recv, "receiver")):
            if uid and uid != sub:
                users.append({
                    "identifier": {"entityType": NS + "::User", "entityId": uid},
                    "attributes": {"role": {"string": r}},
                })
        lot_entity = {
            "identifier": {"entityType": NS + "::Lot", "entityId": s(lot, "lot_id")},
            "attributes": {
                "donor": {"entityIdentifier": {"entityType": NS + "::User", "entityId": donor}},
                "receiver": {"entityIdentifier": {"entityType": NS + "::User", "entityId": recv}},
            },
        }
    return {"entityList": users + ([lot_entity] if lot_entity else [])}


def vp_authorize(sub, role, action, lot_id, lot):
    r = vp.is_authorized(
        policyStoreId=POLICY_STORE_ID,
        principal={"entityType": NS + "::User", "entityId": sub},
        action={"actionType": NS + "::Action", "actionId": action},
        resource={"entityType": NS + "::Lot", "entityId": lot_id},
        entities=vp_entities(sub, role, lot),
    )
    return r.get("decision") == "ALLOW" and not r.get("errors")


def reject_event(lot_id, sub, action, request_id):
    try:
        now = int(time.time())
        ddb.put_item(TableName=EVENTS, Item={
            "lot_id": {"S": lot_id},
            "event_id": {"S": "%012d#%s" % (now, uuid.uuid4().hex[:8])},
            "actor": {"S": sub},
            "action": {"S": action},
            "decision": {"S": "DENY"},
            "source": {"S": "VerifiedPermissions"},
            "request_id": {"S": request_id},
            "ts": {"N": str(now)},
        })
    except ClientError as e:  # logging a rejection must never break the 403
        log(msg="reject_event_failed", error=str(e))


# --------------------------------------------------------- transaction plumbing

def lot_update(lot_id, version, expected_stage, sets=None, removes=None):
    sets = sets or {}
    removes = removes or []
    names = {"#version": "version", "#stage": "stage"}
    values = {":newversion": {"N": str(version + 1)}, ":v": {"N": str(version)}, ":st": {"S": expected_stage}}
    assignments = []
    for k in sets:
        names["#" + k] = k
        values[":" + k] = sets[k]
        assignments.append("#%s = :%s" % (k, k))
    assignments.append("#version = :newversion")
    expr = "SET " + ", ".join(assignments)
    if removes:
        for r in removes:
            names["#" + r] = r
        expr += " REMOVE " + ", ".join("#" + r for r in removes)
    return {"Update": {
        "TableName": LOTS,
        "Key": {"lot_id": {"S": lot_id}},
        "UpdateExpression": expr,
        "ConditionExpression": "#version = :v AND #stage = :st",
        "ExpressionAttributeNames": names,
        "ExpressionAttributeValues": values,
    }}


def chained_event(lot, lot_id, sub, action, decision, result, now, idem_key=None):
    """Build a hash-chained event Put plus the lot attributes that move chain_head.

    The lot update that carries these attributes is conditional on the lot version,
    and every chained write bumps the version, so two writers cannot fork the chain.
    lot is None for the first event of a lot.
    """
    prev = s(lot, "chain_head", trust.GENESIS) if lot else trust.GENESIS
    length = (num(lot, "chain_len", 0) if lot else 0) + 1
    event_id = "%012d#%s" % (now, uuid.uuid4().hex[:8])
    result_text = json.dumps(result)
    digest = trust.event_hash(prev, lot_id, event_id, sub, action, decision, result_text, now)
    it = {
        "lot_id": {"S": lot_id},
        "event_id": {"S": event_id},
        "actor": {"S": sub},
        "action": {"S": action},
        "decision": {"S": decision},
        "result": {"S": result_text},
        "ts": {"N": str(now)},
        "prev_hash": {"S": prev},
        "hash": {"S": digest},
    }
    if idem_key:
        it["idem_key"] = {"S": idem_key}
    sets = {"chain_head": {"S": digest}, "chain_len": {"N": str(length)}}
    return {"Put": {"TableName": EVENTS, "Item": it}}, sets


def idem_item(lot_id, idem_key, sub, action, response):
    return {"Put": {"TableName": EVENTS, "Item": {
        "lot_id": {"S": lot_id},
        "event_id": {"S": "IDEM#" + idem_key},
        "actor": {"S": sub},
        "action": {"S": action},
        "decision": {"S": "ALLOW"},
        "result": {"S": json.dumps(response)},
        "ts": {"N": str(int(time.time()))},
    }, "ConditionExpression": "attribute_not_exists(event_id)"}}


def idem_get(lot_id, idem_key):
    r = ddb.get_item(
        TableName=EVENTS,
        Key={"lot_id": {"S": lot_id}, "event_id": {"S": "IDEM#" + idem_key}},
        ConsistentRead=True,
    )
    return r.get("Item")


def transact(items):
    try:
        ddb.transact_write_items(TransactItems=items)
        return None
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") != "TransactionCanceledException":
            raise
        return e.response.get("CancellationReasons", [])


def idem_action(items):
    for it in items:
        put = it.get("Put")
        if put and put["Item"].get("event_id", {}).get("S", "").startswith("IDEM#"):
            return put["Item"]["action"]["S"]
    return None


def commit(lot_id, idem_key, items, response):
    """Returns (response, None) on success/replay, or (None, 409) on a real conflict."""
    action = idem_action(items)
    if idem_key:
        ex = idem_get(lot_id, idem_key)
        if ex is not None and s(ex, "action") == action:
            return json.loads(ex["result"]["S"]), None
    if transact(items) is None:
        return response, None
    if idem_key:
        ex = idem_get(lot_id, idem_key)
        if ex is not None and s(ex, "action") == action:
            return json.loads(ex["result"]["S"]), None
    return None, 409


def callback_pending_set(lot_id, pending):
    ddb.update_item(
        TableName=LOTS,
        Key={"lot_id": {"S": lot_id}},
        UpdateExpression="SET callback_pending = :p",
        ExpressionAttributeValues={":p": {"BOOL": pending}},
    )


def send_success(lot_id, token, output):
    """SendTaskSuccess after the commit; on failure mark callback_pending for retry."""
    try:
        sfn.send_task_success(taskToken=token, output=json.dumps(output))
        callback_pending_set(lot_id, False)
        return True
    except ClientError as e:
        log(msg="send_task_success_failed", lot_id=lot_id, error=e.response.get("Error", {}).get("Code"))
        callback_pending_set(lot_id, True)
        return False


# ------------------------------------------------------------------ route logic

def h_create(sub, role, body, request_id):
    lot_id = "lot-" + uuid.uuid4().hex[:12]
    if not vp_authorize(sub, role, "CreateLot", lot_id, None):
        reject_event(lot_id, sub, "CreateLot", request_id)
        log(msg="request", request_id=request_id, actor=sub, action="CreateLot", lot_id=lot_id,
            decision="DENY", source="VerifiedPermissions", status=403)
        return resp(403, {"error": "VP_DENY", "action": "CreateLot", "actor": sub, "decision": "DENY", "request_id": request_id})

    receiver_sub = body.get("receiver_sub")
    offered = bint(body, "offered")
    if not receiver_sub or offered is None or offered <= 0:
        return resp(400, {"error": "receiver_sub and a positive offered are required"})
    now = int(time.time())
    # The server owns the cutoff; any cutoff_epoch in the request is ignored.
    cutoff = now + int(os.environ.get("CUTOFF_SECONDS", "3600"))

    created_result = {"offered": offered, "receiver_sub": receiver_sub, "cutoff_epoch": cutoff}
    created_event, chain_sets = chained_event(None, lot_id, sub, "CreateLot", "ALLOW", created_result, now)

    item = {
        "lot_id": {"S": lot_id},
        "donor_sub": {"S": sub},
        "receiver_sub": {"S": receiver_sub},
        "offered": {"N": str(offered)},
        "distributed": {"N": "0"},
        "returned": {"N": "0"},
        "disposed": {"N": "0"},
        "stage": {"S": "OFFERED"},
        "version": {"N": "1"},
        "cutoff_epoch": {"N": str(cutoff)},
        "response_deadline_epoch": {"N": str(now + RESPONSE_DEADLINE_SECONDS)},
        "created_epoch": {"N": str(now)},
        "callback_pending": {"BOOL": False},
    }
    item.update(chain_sets)
    # Lot and its first chained event commit together, so chain_len never points at a missing event.
    ddb.transact_write_items(TransactItems=[
        {"Put": {"TableName": LOTS, "Item": item, "ConditionExpression": "attribute_not_exists(lot_id)"}},
        created_event,
    ])

    ex = sfn.start_execution(
        stateMachineArn=STATE_MACHINE_ARN,
        name=lot_id,
        input=json.dumps({"lot_id": lot_id, "response_deadline_seconds": RESPONSE_DEADLINE_SECONDS}),
    )
    exec_arn = ex["executionArn"]
    ddb.update_item(
        TableName=LOTS,
        Key={"lot_id": {"S": lot_id}},
        UpdateExpression="SET exec_arn = :a",
        ExpressionAttributeValues={":a": {"S": exec_arn}},
    )
    item["exec_arn"] = {"S": exec_arn}

    result = {"lot": public(item), "decision": "ALLOW", "action": "CreateLot", "request_id": request_id}
    log(msg="request", request_id=request_id, actor=sub, action="CreateLot", lot_id=lot_id,
        version=1, exec_arn=exec_arn, decision="ALLOW", status=201)
    return resp(201, result)


def guarded(lot_id, sub, role, action, body, expected_stages, request_id):
    """Common prefix for mutating routes: load -> VP -> idempotency -> stage/version.

    Returns (ctx, err). ctx is ("__replay__", stored_response) when the idem key was
    already committed, otherwise a (lot, stage, version, idem_key) tuple.
    """
    lot = get_lot(lot_id)
    if lot is None:
        return None, resp(404, {"error": "lot not found", "lot_id": lot_id})
    if not vp_authorize(sub, role, action, lot_id, lot):
        reject_event(lot_id, sub, action, request_id)
        log(msg="request", request_id=request_id, actor=sub, action=action, lot_id=lot_id,
            version=num(lot, "version"), exec_arn=s(lot, "exec_arn"),
            decision="DENY", source="VerifiedPermissions", status=403)
        return None, resp(403, {"error": "VP_DENY", "action": action, "actor": sub,
                                "lot_id": lot_id, "decision": "DENY", "request_id": request_id})
    idem_key = body.get("idem_key")
    if not idem_key:
        return None, resp(400, {"error": "idem_key is required"})
    # A committed idempotent request replays its stored result regardless of how the
    # lot has since moved on (e.g. a replayed receipt after stage RECEIVED).
    ex = idem_get(lot_id, idem_key)
    if ex is not None:
        if s(ex, "action") != action:
            return None, resp(409, {"error": "idem_key already used for a different action",
                                    "action": action, "lot_id": lot_id})
        return ("__replay__", json.loads(ex["result"]["S"])), None
    stage = s(lot, "stage")
    version = num(lot, "version")
    if stage not in expected_stages:
        return None, resp(409, {"error": "invalid stage", "stage": stage, "expected": expected_stages})
    ev = bint(body, "expected_version")
    if ev is None or ev != version:
        return None, resp(409, {"error": "stale or missing expected_version", "version": version})
    return (lot, stage, version, idem_key), None


def h_accept(lot_id, sub, role, body, request_id):
    g, err = guarded(lot_id, sub, role, "Accept", body, ["OFFERED"], request_id)
    if err:
        return err
    if g[0] == "__replay__":
        return resp(200, g[1])
    lot, stage, version, idem_key = g
    now = int(time.time())
    result = {"lot_id": lot_id, "action": "Accept", "stage": "ACCEPTED", "version": version + 1}
    ev, chain = chained_event(lot, lot_id, sub, "Accept", "ALLOW", result, now, idem_key)
    items = [
        lot_update(lot_id, version, stage, dict({"stage": {"S": "ACCEPTED"}, "accepted_epoch": {"N": str(now)}}, **chain)),
        ev,
        idem_item(lot_id, idem_key, sub, "Accept", result),
    ]
    out, conflict = commit(lot_id, idem_key, items, result)
    if conflict:
        return resp(409, {"error": "version conflict", "lot_id": lot_id})
    if out is not result:
        return resp(200, out)
    fresh = get_lot(lot_id)
    token = s(fresh, "task_token")
    if token:
        ok = send_success(lot_id, token, {"accepted": True, "lot_id": lot_id})
        callback_status = "sent" if ok else "pending"
    else:
        callback_pending_set(lot_id, True)
        callback_status = "pending"
    log(msg="request", request_id=request_id, actor=sub, action="Accept", lot_id=lot_id,
        version=version + 1, decision="ALLOW", status=200, callback=callback_status)
    body_out = dict(result)
    body_out["callback"] = callback_status
    return resp(200, body_out)


def h_handoff(lot_id, sub, role, body, request_id):
    g, err = guarded(lot_id, sub, role, "DeclareHandoff", body, ["ACCEPTED"], request_id)
    if err:
        return err
    if g[0] == "__replay__":
        return resp(200, g[1])
    lot, stage, version, idem_key = g
    qty = bint(body, "donor_handoff")
    offered = num(lot, "offered")
    if qty is None or qty < 0 or qty > offered:
        return resp(409, {"error": "donor_handoff must be between 0 and offered", "offered": offered})
    now = int(time.time())
    # The code is returned once, in this response only. Only a salted hash is stored, and
    # the stored result (event + idempotency marker) never contains the code itself.
    code, salt, digest = trust.new_pickup_code()
    expires = now + PICKUP_TTL_SECONDS
    result = {"lot_id": lot_id, "action": "DeclareHandoff", "donor_handoff": qty,
              "stage": "HANDOFF_DECLARED", "version": version + 1, "pickup_expires_epoch": expires}
    ev, chain = chained_event(lot, lot_id, sub, "DeclareHandoff", "ALLOW", result, now, idem_key)
    items = [
        lot_update(lot_id, version, stage, dict({
            "stage": {"S": "HANDOFF_DECLARED"}, "donor_handoff": {"N": str(qty)},
            "pickup_salt": {"S": salt}, "pickup_hash": {"S": digest},
            "pickup_expires_epoch": {"N": str(expires)}, "pickup_attempts": {"N": "0"},
        }, **chain)),
        ev,
        idem_item(lot_id, idem_key, sub, "DeclareHandoff", result),
    ]
    out, conflict = commit(lot_id, idem_key, items, result)
    if conflict:
        return resp(409, {"error": "version conflict", "lot_id": lot_id})
    log(msg="request", request_id=request_id, actor=sub, action="DeclareHandoff", lot_id=lot_id,
        version=version + 1, decision="ALLOW", status=200)
    if out is result:
        out = dict(result, pickup_code=code)
    return resp(200, out)


def check_pickup_code(lot_id, lot, code, now):
    """Returns (confirmed_in_person, error_response). No code supplied -> (False, None).

    A wrong code costs one attempt (stored on the lot without touching its version, so
    the receiver's expected_version stays valid); after MAX_PICKUP_ATTEMPTS the code is
    locked. An expired code is refused without costing an attempt.
    """
    if code is None or (isinstance(code, str) and not code.strip()):
        return False, None
    if isinstance(code, bool) or not isinstance(code, (str, int)):
        return False, resp(409, {"error": "pickup code invalid", "attempts_left": None})
    code = ("%06d" % code) if isinstance(code, int) else code.strip()
    salt, digest = s(lot, "pickup_salt"), s(lot, "pickup_hash")
    if not digest:
        return False, resp(409, {"error": "no pickup code is active for this lot"})
    attempts = num(lot, "pickup_attempts", 0)
    if attempts >= trust.MAX_PICKUP_ATTEMPTS:
        return False, resp(409, {"error": "pickup code attempt limit reached", "attempts_left": 0})
    expires = num(lot, "pickup_expires_epoch")
    if expires is None or now >= expires:
        return False, resp(409, {"error": "pickup code expired", "pickup_expires_epoch": expires})
    if trust.pickup_matches(salt, digest, code):
        return True, None
    try:
        ddb.update_item(
            TableName=LOTS, Key={"lot_id": {"S": lot_id}},
            UpdateExpression="ADD pickup_attempts :one",
            ConditionExpression="attribute_not_exists(pickup_attempts) OR pickup_attempts < :max",
            ExpressionAttributeValues={":one": {"N": "1"}, ":max": {"N": str(trust.MAX_PICKUP_ATTEMPTS)}},
        )
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            raise
        return False, resp(409, {"error": "pickup code attempt limit reached", "attempts_left": 0})
    left = max(trust.MAX_PICKUP_ATTEMPTS - attempts - 1, 0)
    return False, resp(409, {"error": "pickup code invalid", "attempts_left": left})


def h_receipt(lot_id, sub, role, body, request_id):
    g, err = guarded(lot_id, sub, role, "Receipt", body, ["HANDOFF_DECLARED"], request_id)
    if err:
        return err
    if g[0] == "__replay__":
        return resp(200, g[1])
    lot, stage, version, idem_key = g
    received = bint(body, "received")
    if received is None or received < 0:
        return resp(409, {"error": "received must be a non-negative integer"})
    donor_handoff = num(lot, "donor_handoff")
    dispute = donor_handoff is not None and received != donor_handoff
    now = int(time.time())
    confirmed, code_err = check_pickup_code(lot_id, lot, body.get("pickup_code"), now)
    if code_err:
        return code_err
    result = {"lot_id": lot_id, "action": "Receipt", "received": received, "remaining": received,
              "distributed": 0, "returned": 0, "disposed": 0, "count_dispute": dispute,
              "confirmed_in_person": confirmed, "stage": "RECEIVED", "version": version + 1}
    ev, chain = chained_event(lot, lot_id, sub, "Receipt", "ALLOW", result, now, idem_key)
    items = [
        lot_update(lot_id, version, stage, dict({
            "stage": {"S": "RECEIVED"}, "received": {"N": str(received)},
            "remaining": {"N": str(received)}, "distributed": {"N": "0"},
            "returned": {"N": "0"}, "disposed": {"N": "0"},
            "count_dispute": {"BOOL": dispute}, "received_epoch": {"N": str(now)},
            "confirmed_in_person": {"BOOL": confirmed},
        }, **chain), removes=["pickup_salt", "pickup_hash"]),
        ev,
        idem_item(lot_id, idem_key, sub, "Receipt", result),
    ]
    out, conflict = commit(lot_id, idem_key, items, result)
    if conflict:
        return resp(409, {"error": "version conflict", "lot_id": lot_id})
    log(msg="request", request_id=request_id, actor=sub, action="Receipt", lot_id=lot_id,
        version=version + 1, decision="ALLOW", status=200)
    return resp(200, out)


def h_distribution(lot_id, sub, role, body, request_id):
    g, err = guarded(lot_id, sub, role, "ReportDistribution", body, ["RECEIVED", "DISTRIBUTING"], request_id)
    if err:
        return err
    if g[0] == "__replay__":
        return resp(200, g[1])
    lot, stage, version, idem_key = g
    now = int(time.time())
    cutoff = num(lot, "cutoff_epoch")
    if cutoff is None or now >= cutoff:
        return resp(409, {"error": "cutoff passed; new distribution blocked by server time",
                          "cutoff_epoch": cutoff, "server_now": now})
    qty = bint(body, "distributed")
    remaining = num(lot, "remaining", 0)
    if qty is None or qty <= 0:
        return resp(409, {"error": "distributed increment must be a positive integer"})
    if qty > remaining:
        return resp(409, {"error": "distributed exceeds remaining received stock",
                          "requested": qty, "remaining": remaining})
    new_dist = num(lot, "distributed", 0) + qty
    new_remaining = remaining - qty
    received = num(lot, "received", 0)
    returned = num(lot, "returned", 0)
    disposed = num(lot, "disposed", 0)
    assert received == new_dist + returned + disposed + new_remaining, "invariant violated"
    result = {"lot_id": lot_id, "action": "ReportDistribution", "distributed": new_dist,
              "remaining": new_remaining, "received": received, "stage": "DISTRIBUTING",
              "version": version + 1}
    ev, chain = chained_event(lot, lot_id, sub, "ReportDistribution", "ALLOW", result, now, idem_key)
    items = [
        lot_update(lot_id, version, stage, dict({
            "stage": {"S": "DISTRIBUTING"}, "distributed": {"N": str(new_dist)},
            "remaining": {"N": str(new_remaining)},
        }, **chain)),
        ev,
        idem_item(lot_id, idem_key, sub, "ReportDistribution", result),
    ]
    out, conflict = commit(lot_id, idem_key, items, result)
    if conflict:
        return resp(409, {"error": "version conflict", "lot_id": lot_id})
    log(msg="request", request_id=request_id, actor=sub, action="ReportDistribution", lot_id=lot_id,
        version=version + 1, decision="ALLOW", status=200)
    return resp(200, out)


def h_close(lot_id, sub, role, body, request_id):
    g, err = guarded(lot_id, sub, role, "Close", body, ["RECEIVED", "DISTRIBUTING"], request_id)
    if err:
        return err
    if g[0] == "__replay__":
        return resp(200, g[1])
    lot, stage, version, idem_key = g
    remaining = num(lot, "remaining", 0)
    if remaining != 0:
        return resp(409, {"error": "cannot close: outstanding stock remains", "remaining": remaining})
    if flag(lot, "count_dispute"):
        return resp(409, {"error": "cannot close: unresolved count dispute"})
    now = int(time.time())
    cutoff = num(lot, "cutoff_epoch")
    # remaining == 0 and no dispute are already guaranteed above, so a fully
    # accounted lot may close after the cutoff; the cutoff only gates open stock.
    if remaining != 0 and cutoff is not None and now >= cutoff:
        return resp(409, {"error": "cutoff passed; close blocked by server time", "cutoff_epoch": cutoff})
    result = {"lot_id": lot_id, "action": "Close", "stage": "ACCOUNTED_FOR", "version": version + 1}
    ev, chain = chained_event(lot, lot_id, sub, "Close", "ALLOW", result, now, idem_key)
    items = [
        lot_update(lot_id, version, stage, dict({"stage": {"S": "ACCOUNTED_FOR"}}, **chain)),
        ev,
        idem_item(lot_id, idem_key, sub, "Close", result),
    ]
    out, conflict = commit(lot_id, idem_key, items, result)
    if conflict:
        return resp(409, {"error": "version conflict", "lot_id": lot_id})
    log(msg="request", request_id=request_id, actor=sub, action="Close", lot_id=lot_id,
        version=version + 1, decision="ALLOW", status=200)
    return resp(200, out)


def h_get(lot_id, sub, role, request_id):
    lot = get_lot(lot_id)
    if lot is None:
        return resp(404, {"error": "lot not found", "lot_id": lot_id})
    if role != "coordinator" and sub not in (s(lot, "donor_sub"), s(lot, "receiver_sub")):
        return resp(403, {"error": "not a participant of this lot", "actor": sub, "lot_id": lot_id})
    q = ddb.query(TableName=EVENTS, KeyConditionExpression="lot_id = :l",
                  ExpressionAttributeValues={":l": {"S": lot_id}})
    events = [public(e) for e in q.get("Items", []) if not s(e, "event_id", "").startswith("IDEM#")]
    log(msg="request", request_id=request_id, actor=sub, action="GetLot", lot_id=lot_id,
        version=num(lot, "version"), exec_arn=s(lot, "exec_arn"), decision="ALLOW", status=200)
    return resp(200, {"lot": public(lot), "events": events})


def all_events(lot_id):
    events, start = [], None
    while True:
        kw = dict(TableName=EVENTS, KeyConditionExpression="lot_id = :l", ConsistentRead=True,
                  ExpressionAttributeValues={":l": {"S": lot_id}})
        if start:
            kw["ExclusiveStartKey"] = start
        q = ddb.query(**kw)
        events += [e for e in q.get("Items", []) if not s(e, "event_id", "").startswith("IDEM#")]
        start = q.get("LastEvaluatedKey")
        if not start:
            return events


def h_verify(lot_id, sub, role, request_id):
    lot = get_lot(lot_id)
    if lot is None:
        return resp(404, {"error": "lot not found", "lot_id": lot_id})
    if role != "coordinator" and sub not in (s(lot, "donor_sub"), s(lot, "receiver_sub")):
        return resp(403, {"error": "not a participant of this lot", "actor": sub, "lot_id": lot_id})
    events = [public(e) for e in all_events(lot_id)]
    out = trust.verify_chain(events, s(lot, "chain_head"), num(lot, "chain_len", 0))
    log(msg="request", request_id=request_id, actor=sub, action="VerifyLot", lot_id=lot_id,
        decision="ALLOW", status=200, verified=out["ok"])
    return resp(200, out)


def scan_all(**kw):
    items, start = [], None
    while True:
        if start:
            kw["ExclusiveStartKey"] = start
        r = ddb.scan(**kw)
        items += r.get("Items", [])
        start = r.get("LastEvaluatedKey")
        if not start:
            return items


def h_impact(sub, role, request_id):
    if role != "coordinator":
        return resp(403, {"error": "coordinator only", "actor": sub, "request_id": request_id})
    lots = scan_all(TableName=LOTS)
    resolved = scan_all(TableName=EVENTS, FilterExpression="#a = :r",
                        ExpressionAttributeNames={"#a": "action"},
                        ExpressionAttributeValues={":r": {"S": "ResolveDispute"}})
    missed = scan_all(TableName=EVENTS, FilterExpression="#a = :m",
                      ExpressionAttributeNames={"#a": "action"},
                      ExpressionAttributeValues={":m": {"S": "ResponseDeadlineMissed"}})
    total = lambda k: sum(num(l, k, 0) for l in lots)
    out = {
        "lots": len(lots),
        "offered": total("offered"),
        "received": total("received"),
        "distributed": total("distributed"),
        "returned": total("returned"),
        "disposed": total("disposed"),
        "accounted_for": sum(1 for l in lots if s(l, "stage") == "ACCOUNTED_FOR"),
        "disputes_caught": len(resolved) + sum(1 for l in lots if flag(l, "count_dispute")),
        "exceptions_raised": len(missed),
        "confirmed_in_person": sum(1 for l in lots if flag(l, "confirmed_in_person")),
    }
    log(msg="request", request_id=request_id, actor=sub, action="Impact", decision="ALLOW", status=200)
    return resp(200, out)


def h_retry(lot_id, sub, role, body, request_id):
    # No lot is the resource here, so authorize against a placeholder like CreateLot.
    if not vp_authorize(sub, role, "RetryCallbacks", "retry-" + uuid.uuid4().hex[:8], None):
        reject_event("retry-callbacks", sub, "RetryCallbacks", request_id)
        log(msg="request", request_id=request_id, actor=sub, action="RetryCallbacks",
            decision="DENY", source="VerifiedPermissions", status=403)
        return resp(403, {"error": "VP_DENY", "action": "RetryCallbacks", "actor": sub,
                          "decision": "DENY", "request_id": request_id})
    targets = []
    if lot_id:
        lot = get_lot(lot_id)
        if lot:
            targets.append(lot)
    else:
        scan = ddb.scan(TableName=LOTS, FilterExpression="callback_pending = :t",
                        ExpressionAttributeValues={":t": {"BOOL": True}})
        targets = scan.get("Items", [])
    reconciled = []
    for lot in targets:
        lid = s(lot, "lot_id")
        if not flag(lot, "callback_pending"):
            continue
        token = s(lot, "task_token")
        if not token:
            continue
        if send_success(lid, token, {"accepted": True, "lot_id": lid}):
            reconciled.append(lid)
            now = int(time.time())
            ddb.put_item(TableName=EVENTS, Item={
                "lot_id": {"S": lid},
                "event_id": {"S": "%012d#%s" % (now, uuid.uuid4().hex[:8])},
                "actor": {"S": "system"},
                "action": {"S": "CallbackRetried"},
                "decision": {"S": "ALLOW"},
                "ts": {"N": str(now)},
            })
    log(msg="request", request_id=request_id, actor=sub, action="RetryCallbacks",
        decision="ALLOW", status=200, reconciled=reconciled)
    return resp(200, {"reconciled": reconciled})


# ------------------------------------------------------------------- dispatcher

def handler(event, context):
    ctx = event.get("requestContext", {})
    http = ctx.get("http", {})
    method = http.get("method", "")
    path = event.get("rawPath") or http.get("path", "") or ""
    request_id = ctx.get("requestId", "")
    claims = ((ctx.get("authorizer") or {}).get("jwt") or {}).get("claims") or {}
    sub = claims.get("sub")
    role = role_from_claims(claims)

    if not sub:
        return resp(401, {"error": "missing verified subject claim", "request_id": request_id})

    try:
        body = json.loads(event.get("body") or "{}") if isinstance(event.get("body"), str) else (event.get("body") or {})
        if not isinstance(body, dict):
            body = {}
    except ValueError:
        return resp(400, {"error": "body is not JSON", "request_id": request_id})

    parts = [p for p in path.split("/") if p]
    try:
        if method == "POST" and parts == ["lots"]:
            return h_create(sub, role, body, request_id)
        if method == "POST" and parts == ["retry-callbacks"]:
            return h_retry(body.get("lot_id"), sub, role, body, request_id)
        if method == "GET" and parts == ["impact"]:
            return h_impact(sub, role, request_id)
        if method == "GET" and len(parts) == 3 and parts[0] == "lots" and parts[2] == "verify":
            return h_verify(parts[1], sub, role, request_id)
        if method == "GET" and len(parts) == 2 and parts[0] == "lots":
            return h_get(parts[1], sub, role, request_id)
        if method == "POST" and len(parts) == 3 and parts[0] == "lots":
            lot_id, action = parts[1], parts[2]
            if action == "accept":
                return h_accept(lot_id, sub, role, body, request_id)
            if action == "handoff":
                return h_handoff(lot_id, sub, role, body, request_id)
            if action == "receipt":
                return h_receipt(lot_id, sub, role, body, request_id)
            if action == "distribution":
                return h_distribution(lot_id, sub, role, body, request_id)
            if action == "close":
                return h_close(lot_id, sub, role, body, request_id)
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code")
        detail = e.response.get("Error", {}).get("Message")
        log(msg="aws_error", request_id=request_id, actor=sub, path=path, error=code, detail=detail)
        return resp(500, {"error": "aws_error", "code": code, "detail": detail, "request_id": request_id})

    return resp(404, {"error": "no route", "method": method, "path": path, "request_id": request_id})
