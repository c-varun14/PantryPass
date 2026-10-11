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

import base64
import hashlib
import json
import os
import re
import time
import uuid

import boto3
from botocore.exceptions import ClientError

import payments
import payouts
import rewards
import trust

ddb = boto3.client("dynamodb")
sfn = boto3.client("stepfunctions")
vp = boto3.client("verifiedpermissions")

_S3 = None


def s3_client():
    """Created on first use. Regional virtual-hosted endpoint, so a presigned POST never bounces
    through a redirect (which would break CORS)."""
    global _S3
    if _S3 is None:
        from botocore.config import Config
        _S3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "ap-south-1"),
                           config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"}))
    return _S3

LOTS = os.environ["LOTS_TABLE"]
EVENTS = os.environ["EVENTS_TABLE"]
POLICY_STORE_ID = os.environ["POLICY_STORE_ID"]
STATE_MACHINE_ARN = os.environ["STATE_MACHINE_ARN"]
PHOTOS_BUCKET = os.environ.get("PHOTOS_BUCKET", "")
# Payout details: an encrypted bank-details table and the KMS key that protects account numbers.
PAYOUTS_TABLE = os.environ.get("PAYOUTS_TABLE", "")
KMS_KEY_ID = os.environ.get("KMS_KEY_ID", "")
_KMS = None
# Direct donations to top donors. With Razorpay keys (env, or a Secrets Manager secret) orders are real; with none
# the flow runs in a labelled simulated mode and no money moves. PantryPass keeps no money and takes no fee.
_SECRETS = None
_RZP = {"loaded": False, "cfg": None}
# Quantities are whole numbers of a unit the donor picks; food is free text.
UNITS = ("kg", "litres", "plates", "packets", "boxes", "trays", "pieces")
FOOD_MAX = 60
# Open offers have no receiver yet. Policy treats the stand-in user below as "nobody", so only the
# open-offer rule (any receiver may claim) can allow Accept on such a lot.
UNCLAIMED = "unclaimed"
FUND_POOL_INR = int(os.environ.get("FUND_POOL_INR", "25000"))
FUND_CAP_PCT = int(os.environ.get("FUND_CAP_PCT", "30"))
# Real money only goes to donors whose verified record is broad enough (see rewards.is_top_donor).
FUND_MIN_LOTS = int(os.environ.get("FUND_MIN_LOTS", str(rewards.TOP_MIN_LOTS)))
FUND_MIN_PARTNERS = int(os.environ.get("FUND_MIN_PARTNERS", str(rewards.TOP_MIN_PARTNERS)))
# Demo only: with a single real donor there is nothing to share, so a few clearly labelled SIMULATED peer
# donors join the pool. They are returned with simulated=true and never confused with real accounts.
# Set FUND_DEMO_PEERS to "[]" to turn them off.
_DEFAULT_PEERS = '[{"name": "Priya\'s kitchen", "points": 70}, {"name": "Green Leaf Cafe", "points": 55}, {"name": "St Mary\'s mess", "points": 40}]'
FUND_DEMO_PEERS = json.loads(os.environ.get("FUND_DEMO_PEERS", _DEFAULT_PEERS.replace("\\'", "'")))

NS = "PantryPass"
# Server-set response deadline for the durable wait. Never read from a request body.
RESPONSE_DEADLINE_SECONDS = int(os.environ.get("RESPONSE_DEADLINE_SECONDS", "90"))
PICKUP_TTL_SECONDS = int(os.environ.get("PICKUP_TTL_SECONDS", "3600"))
# Attributes that never leave the server: the callback token and the pickup code material.
HIDDEN = {"task_token", "pickup_hash", "pickup_salt"}

# Photo evidence: one optional photo at the handoff (donor) and one at the count (receiver).
PHOTO_MAX_BYTES = 5 * 1024 * 1024
PHOTO_TYPES = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}
PHOTO_KIND_ACTION = {"handoff": "DeclareHandoff", "receipt": "Receipt"}
PHOTO_KIND_STAGE = {"handoff": "ACCEPTED", "receipt": "HANDOFF_DECLARED"}
PHOTO_KEY_RE = re.compile(r"^lots/(lot-[0-9a-f]+)/(handoff|receipt)-([0-9a-f]{32})\.(jpg|png|webp)$")


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
        recv = s(lot, "receiver_sub") or UNCLAIMED
        for uid, r in ((donor, "donor"), (recv, "receiver")):
            if uid and uid != sub and uid != UNCLAIMED:
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


# ------------------------------------------------------------------ photo evidence

def photo_key_ok(lot_id, kind, key):
    """A key is valid only for its own lot and step: lots/<lot_id>/<kind>-<32 hex>.<ext>."""
    m = PHOTO_KEY_RE.match(key) if isinstance(key, str) else None
    return bool(m) and m.group(1) == lot_id and m.group(2) == kind


def looks_like_image(data):
    """Magic-byte check, so a renamed file is not stored as a photo."""
    return (data[:3] == b"\xff\xd8\xff" or data[:8] == b"\x89PNG\r\n\x1a\n"
            or (data[:4] == b"RIFF" and data[8:12] == b"WEBP"))


def photo_fingerprint(key):
    """Read the uploaded object (at most 5 MB) and return (sha256, bytes), or None if it is
    missing, empty, too large or not an image. The digest goes into the hash-chained event."""
    try:
        head = s3_client().head_object(Bucket=PHOTOS_BUCKET, Key=key)
        size = head.get("ContentLength", 0)
        if size <= 0 or size > PHOTO_MAX_BYTES:
            return None
        data = s3_client().get_object(Bucket=PHOTOS_BUCKET, Key=key)["Body"].read()
    except ClientError:
        return None
    if not data or len(data) > PHOTO_MAX_BYTES or not looks_like_image(data):
        return None
    return hashlib.sha256(data).hexdigest(), len(data)


def photo_for_commit(lot_id, kind, key):
    """Validate an optional photo_key at commit time. Returns (photo, err)."""
    if not PHOTOS_BUCKET:
        return None, resp(503, {"error": "photo storage is not configured"})
    if not photo_key_ok(lot_id, kind, key):
        return None, resp(409, {"error": "photo_key is not valid for this lot and step"})
    fp = photo_fingerprint(key)
    if fp is None:
        return None, resp(409, {"error": "photo was not uploaded, is empty, too large or not an image"})
    return {"key": key, "sha256": fp[0], "bytes": fp[1]}, None


def h_photo_upload(lot_id, sub, role, body, request_id):
    """Hand out a short-lived, size-limited S3 upload for ONE photo. Same policy decision as the
    step it belongs to: only the donor may add the handoff photo, only the receiver the count photo."""
    kind, ctype = body.get("kind"), body.get("content_type")
    if kind not in PHOTO_KIND_ACTION:
        return resp(400, {"error": "kind must be handoff or receipt"})
    if ctype not in PHOTO_TYPES:
        return resp(400, {"error": "content_type must be image/jpeg, image/png or image/webp"})
    if not PHOTOS_BUCKET:
        return resp(503, {"error": "photo storage is not configured"})
    lot = get_lot(lot_id)
    if lot is None:
        return resp(404, {"error": "lot not found", "lot_id": lot_id})
    action = PHOTO_KIND_ACTION[kind]
    if not vp_authorize(sub, role, action, lot_id, lot):
        log(msg="request", request_id=request_id, actor=sub, action="PhotoUpload", lot_id=lot_id,
            decision="DENY", source="VerifiedPermissions", status=403)
        return resp(403, {"error": "VP_DENY", "action": action, "actor": sub, "lot_id": lot_id,
                          "decision": "DENY", "request_id": request_id})
    if s(lot, "stage") != PHOTO_KIND_STAGE[kind]:
        return resp(409, {"error": "a photo can only be added while that step is open",
                          "stage": s(lot, "stage"), "expected": PHOTO_KIND_STAGE[kind]})
    key = "lots/%s/%s-%s.%s" % (lot_id, kind, uuid.uuid4().hex, PHOTO_TYPES[ctype])
    post = s3_client().generate_presigned_post(
        Bucket=PHOTOS_BUCKET, Key=key, Fields={"Content-Type": ctype},
        Conditions=[{"Content-Type": ctype}, ["content-length-range", 1, PHOTO_MAX_BYTES]], ExpiresIn=300)
    log(msg="request", request_id=request_id, actor=sub, action="PhotoUpload", lot_id=lot_id,
        decision="ALLOW", status=200)
    return resp(200, {"key": key, "upload": post, "max_bytes": PHOTO_MAX_BYTES, "expires_in": 300})


def h_photo(lot_id, sub, role, query, request_id):
    """Short-lived signed view URL for a photo recorded on this lot. Participants and the coordinator only."""
    lot = get_lot(lot_id)
    if lot is None:
        return resp(404, {"error": "lot not found", "lot_id": lot_id})
    if role != "coordinator" and sub not in (s(lot, "donor_sub"), s(lot, "receiver_sub")):
        return resp(403, {"error": "not a participant of this lot", "actor": sub, "lot_id": lot_id})
    key = (query or {}).get("key")
    recorded = {s(lot, "handoff_photo_key"), s(lot, "receipt_photo_key")} - {None}
    if not PHOTOS_BUCKET or not key or key not in recorded:
        return resp(404, {"error": "no such photo on this lot"})
    url = s3_client().generate_presigned_url("get_object", Params={"Bucket": PHOTOS_BUCKET, "Key": key}, ExpiresIn=300)
    return resp(200, {"url": url, "expires_in": 300})


# ------------------------------------------------------------------ route logic

def h_create(sub, role, body, request_id):
    lot_id = "lot-" + uuid.uuid4().hex[:12]
    if not vp_authorize(sub, role, "CreateLot", lot_id, None):
        reject_event(lot_id, sub, "CreateLot", request_id)
        log(msg="request", request_id=request_id, actor=sub, action="CreateLot", lot_id=lot_id,
            decision="DENY", source="VerifiedPermissions", status=403)
        return resp(403, {"error": "VP_DENY", "action": "CreateLot", "actor": sub, "decision": "DENY", "request_id": request_id})

    receiver_sub = body.get("receiver_sub") or None      # no receiver = announced to every receiver
    offered = bint(body, "offered")
    if offered is None or offered <= 0:
        return resp(400, {"error": "offered must be a positive whole number"})
    food = body.get("food")
    food = " ".join(food.split()) if isinstance(food, str) else ""
    food = food or "Surplus food"
    if len(food) > FOOD_MAX:
        return resp(400, {"error": "food must be at most %d characters" % FOOD_MAX})
    unit = body.get("unit") or "packets"
    if unit not in UNITS:
        return resp(400, {"error": "unit must be one of: " + ", ".join(UNITS)})
    now = int(time.time())
    # The server owns the cutoff; any cutoff_epoch in the request is ignored.
    cutoff = now + int(os.environ.get("CUTOFF_SECONDS", "3600"))

    created_result = {"offered": offered, "food": food, "unit": unit, "cutoff_epoch": cutoff}
    if receiver_sub:
        created_result["receiver_sub"] = receiver_sub
    created_event, chain_sets = chained_event(None, lot_id, sub, "CreateLot", "ALLOW", created_result, now)

    item = {
        "lot_id": {"S": lot_id},
        "donor_sub": {"S": sub},
        "offered": {"N": str(offered)},
        "food": {"S": food},
        "unit": {"S": unit},
        "open_offer": {"BOOL": not receiver_sub},
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
    if receiver_sub:
        item["receiver_sub"] = {"S": receiver_sub}
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
    sets = {"stage": {"S": "ACCEPTED"}, "accepted_epoch": {"N": str(now)}}
    if not s(lot, "receiver_sub"):
        # Claiming an open offer: the first receiver to commit wins (the version condition below
        # rejects every later claimant), and from here on the lot is theirs alone.
        result.update(claimed=True, receiver_sub=sub)
        sets.update(receiver_sub={"S": sub}, open_offer={"BOOL": False})
    ev, chain = chained_event(lot, lot_id, sub, "Accept", "ALLOW", result, now, idem_key)
    items = [
        lot_update(lot_id, version, stage, dict(sets, **chain)),
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
    photo = None
    if body.get("photo_key"):
        photo, perr = photo_for_commit(lot_id, "handoff", body.get("photo_key"))
        if perr:
            return perr
    now = int(time.time())
    # The code is returned once, in this response only. Only a salted hash is stored, and
    # the stored result (event + idempotency marker) never contains the code itself.
    code, salt, digest = trust.new_pickup_code()
    expires = now + PICKUP_TTL_SECONDS
    result = {"lot_id": lot_id, "action": "DeclareHandoff", "donor_handoff": qty,
              "stage": "HANDOFF_DECLARED", "version": version + 1, "pickup_expires_epoch": expires}
    photo_sets = {}
    if photo:
        result.update(photo_key=photo["key"], photo_sha256=photo["sha256"], photo_bytes=photo["bytes"])
        photo_sets = {"handoff_photo_key": {"S": photo["key"]}, "handoff_photo_sha256": {"S": photo["sha256"]},
                      "handoff_photo_bytes": {"N": str(photo["bytes"])}}
    ev, chain = chained_event(lot, lot_id, sub, "DeclareHandoff", "ALLOW", result, now, idem_key)
    items = [
        lot_update(lot_id, version, stage, dict({
            "stage": {"S": "HANDOFF_DECLARED"}, "donor_handoff": {"N": str(qty)},
            "pickup_salt": {"S": salt}, "pickup_hash": {"S": digest},
            "pickup_expires_epoch": {"N": str(expires)}, "pickup_attempts": {"N": "0"},
        }, **chain, **photo_sets)),
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
    photo = None
    if body.get("photo_key"):
        photo, perr = photo_for_commit(lot_id, "receipt", body.get("photo_key"))
        if perr:
            return perr
    now = int(time.time())
    confirmed, code_err = check_pickup_code(lot_id, lot, body.get("pickup_code"), now)
    if code_err:
        return code_err
    result = {"lot_id": lot_id, "action": "Receipt", "received": received, "remaining": received,
              "distributed": 0, "returned": 0, "disposed": 0, "count_dispute": dispute,
              "confirmed_in_person": confirmed, "stage": "RECEIVED", "version": version + 1}
    photo_sets = {}
    if photo:
        result.update(photo_key=photo["key"], photo_sha256=photo["sha256"], photo_bytes=photo["bytes"])
        photo_sets = {"receipt_photo_key": {"S": photo["key"]}, "receipt_photo_sha256": {"S": photo["sha256"]},
                      "receipt_photo_bytes": {"N": str(photo["bytes"])}}
    ev, chain = chained_event(lot, lot_id, sub, "Receipt", "ALLOW", result, now, idem_key)
    items = [
        lot_update(lot_id, version, stage, dict({
            "stage": {"S": "RECEIVED"}, "received": {"N": str(received)},
            "remaining": {"N": str(received)}, "distributed": {"N": "0"},
            "returned": {"N": "0"}, "disposed": {"N": "0"},
            "count_dispute": {"BOOL": dispute}, "received_epoch": {"N": str(now)},
            "confirmed_in_person": {"BOOL": confirmed},
        }, **chain, **photo_sets), removes=["pickup_salt", "pickup_hash"]),
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
    open_to_all = role == "receiver" and flag(lot, "open_offer") and s(lot, "stage") == "OFFERED"
    if role != "coordinator" and not open_to_all and sub not in (s(lot, "donor_sub"), s(lot, "receiver_sub")):
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
    # Quantities in different units must never be added together, so every figure is also kept per unit.
    by_unit = {}
    for l in lots:
        row = by_unit.setdefault(s(l, "unit", "packets"), {"lots": 0, "offered": 0, "received": 0, "distributed": 0, "returned": 0, "disposed": 0})
        row["lots"] += 1
        for k in ("offered", "received", "distributed", "returned", "disposed"):
            row[k] += num(l, k, 0)
    out = {
        "by_unit": by_unit,
        "mixed_units": len(by_unit) > 1,
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


MAX_REWARD_LOTS = 200


def h_rewards(sub, role, request_id):
    """The caller's own trust points. Never reads or returns anyone else's."""
    all_lots = scan_all(TableName=LOTS)
    by_id = {s(l, "lot_id"): l for l in all_lots}
    if role == "coordinator":
        resolved = scan_all(TableName=EVENTS, FilterExpression="#a = :r AND actor = :s",
                            ExpressionAttributeNames={"#a": "action"},
                            ExpressionAttributeValues={":r": {"S": "ResolveDispute"}, ":s": {"S": sub}})
        mine = [by_id[s(e, "lot_id")] for e in resolved if s(e, "lot_id") in by_id]
        mine = list({s(l, "lot_id"): l for l in mine}.values())
    else:
        mine = [l for l in all_lots if sub in (s(l, "donor_sub"), s(l, "receiver_sub"))]
    mine.sort(key=lambda l: num(l, "created_epoch", 0), reverse=True)
    mine = mine[:MAX_REWARD_LOTS]
    plain = [public(l) for l in mine]
    events = {s(l, "lot_id"): [public(e) for e in all_events(s(l, "lot_id"))] for l in mine}
    accounted = sum(1 for l in all_lots if s(l, "stage") == "ACCOUNTED_FOR")
    out = rewards.compute_rewards(sub, role, plain, events, accounted)
    log(msg="request", request_id=request_id, actor=sub, action="Rewards", decision="ALLOW", status=200,
        points=out["points"])
    return resp(200, out)


def h_open_offers(sub, role, request_id):
    """Open offers still waiting for a receiver, newest first. Receivers and coordinators only."""
    if role not in ("receiver", "coordinator"):
        return resp(403, {"error": "only receivers and coordinators can browse open offers", "actor": sub})
    now = int(time.time())
    lots = [l for l in scan_all(TableName=LOTS)
            if flag(l, "open_offer") and s(l, "stage") == "OFFERED" and num(l, "response_deadline_epoch", 0) > now]
    lots.sort(key=lambda l: num(l, "created_epoch", 0), reverse=True)
    log(msg="request", request_id=request_id, actor=sub, action="OpenOffers", decision="ALLOW", status=200, count=len(lots))
    return resp(200, {"lots": [public(l) for l in lots[:50]]})


_FUND_CACHE = {"at": 0, "stats": {}}


def donor_stats():
    """{donor_sub: {points, volume, streak_weeks, verified_lots, partners, level}}, from the same hash-chained
    rules as GET /rewards. Cached for a minute."""
    if time.time() - _FUND_CACHE["at"] < 60 and _FUND_CACHE["stats"]:
        return _FUND_CACHE["stats"]
    all_lots = scan_all(TableName=LOTS)
    accounted = sum(1 for l in all_lots if s(l, "stage") == "ACCOUNTED_FOR")
    by_donor = {}
    for l in all_lots:
        if s(l, "donor_sub"):
            by_donor.setdefault(s(l, "donor_sub"), []).append(l)
    stats = {}
    for donor, lots in by_donor.items():
        lots.sort(key=lambda l: num(l, "created_epoch", 0), reverse=True)
        lots = lots[:MAX_REWARD_LOTS]
        events = {s(l, "lot_id"): [public(e) for e in all_events(s(l, "lot_id"))] for l in lots}
        r = rewards.compute_rewards(donor, "donor", [public(l) for l in lots], events, accounted)
        stats[donor] = {k: r[k] for k in ("points", "level", "volume", "streak_weeks", "verified_lots", "partners")}
    _FUND_CACHE.update(at=time.time(), stats=stats)
    return stats


def donor_points():
    return {d: v["points"] for d, v in donor_stats().items()}


def eligible(st):
    return rewards.is_top_donor(st, FUND_MIN_LOTS, FUND_MIN_PARTNERS)


def fund_shares():
    """(stats, shares). Only donors with a broad verified record share the pool; simulated demo peers join them."""
    stats = donor_stats()
    real = {d: v["points"] for d, v in stats.items() if eligible(v)}
    peers = {} if gateway() else {"sim:" + p["name"]: int(p["points"]) for p in FUND_DEMO_PEERS}   # never when money is real
    shares = rewards.compute_fund(dict(real, **peers), pool_amount(), FUND_CAP_PCT)
    return stats, shares, peers


def h_fund(sub, role, request_id):
    """The donor incentive pool. A simulation until a coordinator pays out: the pool is a configured number.
    Shares follow trust points (which include a capped, verified-quantity bonus) among donors with a broad
    verified record, and no donor may take more than the cap."""
    stats, shares, peers = fund_shares()
    total = sum(v["points"] for v in shares.values())
    you = None
    if role == "donor":
        mine = shares.get(sub, {"points": 0, "share_pct": 0.0, "estimated_inr": 0, "capped": False})
        st = stats.get(sub, {})
        you = dict(mine, role="donor", points=st.get("points", mine["points"]), eligible=eligible(st) if st else False,
                   verified_lots=st.get("verified_lots", 0), partners=st.get("partners", 0),
                   needs={"lots": FUND_MIN_LOTS, "partners": FUND_MIN_PARTNERS})
    allocations = []
    if role == "coordinator":
        for d, v in sorted(shares.items(), key=lambda kv: -kv[1]["points"]):
            row = dict(v)
            if d.startswith("sim:"):
                row.update(name=d[4:], simulated=True)
            else:
                row.update(donor_sub=d, simulated=False)
            allocations.append(row)
    top = sorted(({"donor_sub": d, "points": v["points"], "level": v["level"], "volume": v["volume"],
                   "streak_weeks": v["streak_weeks"], "verified_lots": v["verified_lots"], "partners": v["partners"]}
                  for d, v in stats.items() if eligible(v)), key=lambda r: (-sum(x["quantity"] for x in r["volume"]), -r["points"]))[:10]
    if payouts_ready():
        for row in top:
            row.update(support_totals(row["donor_sub"]))
    log(msg="request", request_id=request_id, actor=sub, action="Fund", decision="ALLOW", status=200, donors=len(shares))
    return resp(200, {
        "demo": not gateway(), "period": period_label() if gateway() else "Demo month", "pool_inr": pool_amount(), "cap_pct": FUND_CAP_PCT,
        "pool": dict(pool_stats(), mode="razorpay" if gateway() else "demo"),
        "total_points": total, "donors": len(shares), "simulated_peers": len(peers),
        "you": you, "allocations": allocations, "top_donors": top,
        "donations": {"enabled": payouts_ready(), "min_inr": payments.MIN_INR, "max_inr": payments.MAX_INR,
                      "mode": "razorpay" if gateway() else "demo", "pool_enabled": payouts_ready()},
        "note": (("Demo pool. %d simulated peer donors are included so the sharing and the cap are visible. "
                  "No money moves in this demo." % len(peers)) if peers else "Demo pool. No money moves in this demo.")
                if not gateway() else "Money sponsors paid this month. PantryPass keeps none of it.",
        "rules": [
            "Points come from verified, receiver-confirmed handoffs: matching counts, handoffs confirmed in person, lots accounted for.",
            "The amount counts only once verified: a bonus that grows with the confirmed quantity, capped per lot, and shrinking for repeat handoffs between the same two people.",
            "A lot whose record fails Verify earns nothing.",
            "To share the pool you need %d verified lots handed to at least %d different receivers." % (FUND_MIN_LOTS, FUND_MIN_PARTNERS),
            "No donor can take more than %d%% of the pool." % FUND_CAP_PCT,
            "The pool is shared in proportion to points. PantryPass keeps nothing: Razorpay pays your share to the bank details you provide.",
        ],
    })


# ------------------------------------------------------------------ payout details, donations and payouts
# PantryPass keeps no money and takes no fee. Supporters and sponsors pay in through Razorpay Checkout; every rupee is
# owed on to donors and is paid out with RazorpayX. The coordinator never sees an account number: the server decrypts
# it (KMS) and sends it straight to Razorpay.

MAX_PAYOUTS_PER_RUN = 5        # an API Gateway call must finish in 30 s; run again for the rest
STUCK_AFTER_SECONDS = 30       # an "initiating" payout older than this is asked about again, with the same idempotency key


def kms_client():
    global _KMS
    if _KMS is None:
        _KMS = boto3.client("kms")
    return _KMS


def payouts_ready():
    return bool(PAYOUTS_TABLE and KMS_KEY_ID)


def seal(sub, account_number):
    r = kms_client().encrypt(KeyId=KMS_KEY_ID, Plaintext=account_number.encode(), EncryptionContext={"sub": sub})
    return base64.b64encode(r["CiphertextBlob"]).decode()


def unseal(sub, blob):
    r = kms_client().decrypt(CiphertextBlob=base64.b64decode(blob), KeyId=KMS_KEY_ID, EncryptionContext={"sub": sub})
    return r["Plaintext"].decode()


def get_profile(sub):
    return ddb.get_item(TableName=PAYOUTS_TABLE, Key={"sub": {"S": sub}, "sk": {"S": "profile"}}).get("Item")


def _rows(pk, prefix):
    q = ddb.query(TableName=PAYOUTS_TABLE, KeyConditionExpression="#p = :p AND begins_with(sk, :k)",
                  ExpressionAttributeNames={"#p": "sub"},
                  ExpressionAttributeValues={":p": {"S": pk}, ":k": {"S": prefix}})
    return [public(i) for i in q.get("Items", [])]


def payout_rows(donor_sub):
    """Every payout to a donor, newest first."""
    rows = [{"amount_inr": r.get("amount_inr", 0), "status": r.get("status"), "mode": r.get("mode"),
             "utr": r.get("utr") or None, "ts": r.get("ts"), "sk": r["sk"], "payout_id": r.get("payout_id"),
             "period": row_period(r)} for r in _rows(donor_sub, "out#")]
    rows.sort(key=lambda r: r.get("ts") or 0, reverse=True)
    return rows


def paid_amount(rows):
    """Money already on its way (or paid) for the CURRENT period. Last month's payouts never reduce this month's owed."""
    cur = period_key()
    return sum(r["amount_inr"] for r in rows if r["status"] in payments.PAYOUT_COUNTED and r["period"] == cur)


def public_payments(rows):
    return [{k: r[k] for k in ("amount_inr", "status", "mode", "utr", "ts")} for r in rows[:20]]


def h_payout_profile(sub, role, request_id):
    """The signed-in donor's own payout details, masked, and the payouts made to them."""
    if role != "donor":
        return resp(403, {"error": "only donors have payout details", "actor": sub})
    if not payouts_ready():
        return resp(503, {"error": "payout details are not configured"})
    item = get_profile(sub)
    out = payouts.public_profile(public(item) if item else None)
    out["payments"] = public_payments(payout_rows(sub))
    log(msg="request", request_id=request_id, actor=sub, action="PayoutProfile", decision="ALLOW", status=200)
    return resp(200, out)


def h_payout_save(sub, role, body, request_id):
    """Save or replace the donor's bank details. The account number is encrypted with KMS before it is stored
    and is never logged or returned again in full."""
    if role != "donor":
        return resp(403, {"error": "only donors can add payout details", "actor": sub})
    if not payouts_ready():
        return resp(503, {"error": "payout details are not configured"})
    prof, err = payouts.clean_profile(body)
    if err:
        return resp(400, {"error": err})
    now = int(time.time())
    ddb.put_item(TableName=PAYOUTS_TABLE, Item={
        "sub": {"S": sub}, "sk": {"S": "profile"}, "holder_name": {"S": prof["holder_name"]},
        "ifsc": {"S": prof["ifsc"]}, "upi": {"S": prof["upi"]}, "account_last4": {"S": prof["account_number"][-4:]},
        "account_enc": {"S": seal(sub, prof["account_number"])}, "updated": {"N": str(now)}})
    log(msg="request", request_id=request_id, actor=sub, action="PayoutProfileSave", decision="ALLOW", status=200)
    out = payouts.public_profile(public(get_profile(sub)))
    out["payments"] = public_payments(payout_rows(sub))
    return resp(200, out)


# ---- the gateway and the pool ----

def gateway():
    """Razorpay credentials {key_id, key_secret, webhook_secret, payout_account} from the environment or a Secrets
    Manager secret, or None when neither is set (simulated mode). payout_account is the RazorpayX account number."""
    if _RZP["loaded"]:
        return _RZP["cfg"]
    cfg = None
    if os.environ.get("RAZORPAY_KEY_ID") and os.environ.get("RAZORPAY_KEY_SECRET"):
        cfg = {"key_id": os.environ["RAZORPAY_KEY_ID"], "key_secret": os.environ["RAZORPAY_KEY_SECRET"],
               "webhook_secret": os.environ.get("RAZORPAY_WEBHOOK_SECRET", ""),
               "payout_account": os.environ.get("RAZORPAYX_ACCOUNT_NUMBER", "")}
    elif os.environ.get("RAZORPAY_SECRET_ARN"):
        global _SECRETS
        if _SECRETS is None:
            _SECRETS = boto3.client("secretsmanager")
        try:
            raw = json.loads(_SECRETS.get_secret_value(SecretId=os.environ["RAZORPAY_SECRET_ARN"])["SecretString"])
            if raw.get("key_id") and raw.get("key_secret"):
                cfg = {"key_id": raw["key_id"], "key_secret": raw["key_secret"], "webhook_secret": raw.get("webhook_secret", ""),
                       "payout_account": raw.get("payout_account_number", "")}
        except (ClientError, ValueError, KeyError):
            cfg = None
    _RZP.update(loaded=True, cfg=cfg)
    return cfg


def payout_gateway():
    cfg = gateway()
    return cfg if cfg and cfg.get("payout_account") else None


MONTHS = ("January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December")


def month_key(ts):
    t = time.gmtime(ts + 19800)                              # India time
    return "%04d-%02d" % (t.tm_year, t.tm_mon)


def period_key(ts=None):
    """The accounting period money belongs to: the calendar month (India time). PERIOD_OVERRIDE starts a fresh period
    on demand, for demos and tests, without touching any stored data."""
    return os.environ.get("PERIOD_OVERRIDE") or month_key(ts or time.time())


def row_period(r):
    """The period a stored row belongs to (rows written before periods existed fall back to the month of their date)."""
    return r.get("period") or month_key(r.get("ts") or time.time())


def period_label():
    t = time.gmtime(time.time() + 19800)
    return "%s %d" % (MONTHS[t.tm_mon - 1], t.tm_year)


def pool_stats():
    """What sponsors have put into this month's pool through Checkout (real, paid orders only)."""
    if not payouts_ready():
        return {"collected_inr": 0, "contributors": 0}
    rows = [r for r in _rows("pool#" + period_key(), "con#") if r.get("status") == "paid"]
    return {"collected_inr": sum(r.get("amount_inr", 0) for r in rows), "contributors": len({r.get("supporter_sub") for r in rows})}


def pool_amount():
    """The money the donors share. Real collected money when Razorpay is configured, else the configured demo number."""
    return pool_stats()["collected_inr"] if gateway() else FUND_POOL_INR


# ---- donations and pool top-ups (money in) ----

def donations_received(donor_sub):
    rows = _rows(donor_sub, "don#")
    rows.sort(key=lambda r: r.get("ts", 0), reverse=True)
    return [{"amount_inr": r.get("amount_inr", 0), "note": r.get("note", ""), "status": r.get("status"),
             "mode": r.get("mode"), "ts": r.get("ts"), "period": row_period(r)} for r in rows[:50]]


def donations_given(supporter_sub):
    rows = _rows("give#" + supporter_sub, "don#")
    rows.sort(key=lambda r: r.get("ts", 0), reverse=True)
    return [{"donor_sub": r.get("donor_sub") or None, "kind": r.get("kind", "donation"), "amount_inr": r.get("amount_inr", 0),
             "note": r.get("note", ""), "status": r.get("status"), "mode": r.get("mode"), "ts": r.get("ts")} for r in rows[:50]]


def support_totals(donor_sub):
    rows = [r for r in _rows(donor_sub, "don#") if r.get("status") in ("paid", "simulated")]
    return {"supporters": len({r.get("supporter_sub") or r.get("order_id") for r in rows}),
            "supported_inr": sum(r.get("amount_inr", 0) for r in rows)}


def start_order(sub, kind, donor_sub, don, request_id):
    """Create the order a supporter or sponsor pays. The amount and recipient are decided here; the browser only gets
    an order to pay. Razorpay order when keys are set, else a simulated one."""
    cfg = gateway()
    now = int(time.time())
    if cfg:
        order, oerr = payments.create_order(cfg["key_id"], cfg["key_secret"], don["amount_inr"], "pp-" + uuid.uuid4().hex[:12],
                                            {"kind": kind, "donor": (donor_sub or "")[:40], "supporter": sub[:40]})
        if oerr:
            log(msg="gateway_error", request_id=request_id, actor=sub, error=oerr)
            return resp(502, {"error": oerr})
        order_id, mode = order["id"], "razorpay"
    else:
        order_id, mode = "order_demo_" + uuid.uuid4().hex[:14], "demo"
    item = {"sub": {"S": "order#" + order_id}, "sk": {"S": "order"}, "kind": {"S": kind}, "supporter_sub": {"S": sub},
            "amount_inr": {"N": str(don["amount_inr"])}, "note": {"S": don["note"]}, "mode": {"S": mode},
            "status": {"S": "created"}, "ts": {"N": str(now)}}
    if donor_sub:
        item["donor_sub"] = {"S": donor_sub}
    ddb.put_item(TableName=PAYOUTS_TABLE, Item=item)
    log(msg="request", request_id=request_id, actor=sub, action="Donate" if kind == "donation" else "Contribute",
        decision="ALLOW", status=200, mode=mode, amount_inr=don["amount_inr"])
    out = {"order_id": order_id, "mode": mode, "amount_inr": don["amount_inr"], "currency": "INR", "kind": kind}
    if donor_sub:
        out["donor_sub"] = donor_sub
    if cfg:
        out["key_id"] = cfg["key_id"]      # the public key id, safe for the browser; the secret never leaves the server
    return resp(200, out)


def h_donate(sub, role, body, request_id):
    """Start a donation to a top donor. Every rupee is owed on to that donor."""
    if not payouts_ready():
        return resp(503, {"error": "donations are not configured"})
    don, err = payments.clean_donation(body)
    if err:
        return resp(400, {"error": err})
    if don["donor_sub"] == sub:
        return resp(409, {"error": "you cannot donate to yourself"})
    st = donor_stats().get(don["donor_sub"])
    if not st or not eligible(st):
        return resp(409, {"error": "this donor is not a top donor yet, so they cannot receive donations"})
    return start_order(sub, "donation", don["donor_sub"], don, request_id)


def h_pool(sub, role, body, request_id):
    """Start a sponsor top-up of the shared pool. Every rupee goes into the pool, shared among donors by points."""
    if not payouts_ready():
        return resp(503, {"error": "donations are not configured"})
    don, err = payments.clean_pool(body)
    if err:
        return resp(400, {"error": err})
    return start_order(sub, "pool", None, don, request_id)


def settle_order(order_id, payment_id, new_status):
    """Move an order from created to paid/simulated exactly once and write the records. Returns the order as a plain
    dict, or None if there is no such order. Safe to call from both the browser confirm and the webhook."""
    key = {"sub": {"S": "order#" + order_id}, "sk": {"S": "order"}}
    item = ddb.get_item(TableName=PAYOUTS_TABLE, Key=key).get("Item")
    if not item:
        return None
    order = public(item)
    if order["status"] != "created":
        return order
    try:
        ddb.update_item(TableName=PAYOUTS_TABLE, Key=key, UpdateExpression="SET #st = :n, payment_id = :p",
                        ConditionExpression="#st = :c", ExpressionAttributeNames={"#st": "status"},
                        ExpressionAttributeValues={":n": {"S": new_status}, ":p": {"S": payment_id}, ":c": {"S": "created"}})
    except ClientError as e:
        if e.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
            raise
        return public(ddb.get_item(TableName=PAYOUTS_TABLE, Key=key)["Item"])     # another request settled it first
    now = int(time.time())
    kind = order.get("kind", "donation")
    rec = {"amount_inr": {"N": str(order["amount_inr"])}, "note": {"S": order.get("note", "")}, "mode": {"S": order["mode"]},
           "status": {"S": new_status}, "kind": {"S": kind}, "order_id": {"S": order_id},
           "supporter_sub": {"S": order["supporter_sub"]}, "ts": {"N": str(now)}, "period": {"S": period_key(now)}}
    sk = "don#%012d#%s" % (now, order_id[-8:])
    if kind == "pool":
        ddb.put_item(TableName=PAYOUTS_TABLE, Item=dict(rec, sub={"S": "pool#" + period_key(now)}, sk={"S": "con#" + sk[4:]}))
    else:
        rec["donor_sub"] = {"S": order["donor_sub"]}
        ddb.put_item(TableName=PAYOUTS_TABLE, Item=dict(rec, sub={"S": order["donor_sub"]}, sk={"S": sk}))
    ddb.put_item(TableName=PAYOUTS_TABLE, Item=dict(rec, sub={"S": "give#" + order["supporter_sub"]}, sk={"S": sk}))
    return dict(order, status=new_status)


def h_donate_confirm(sub, role, body, request_id):
    """The browser reports the payment. Real orders are accepted only with a valid Razorpay signature; simulated
    orders are marked simulated and never count as money."""
    if not payouts_ready():
        return resp(503, {"error": "donations are not configured"})
    order_id = str(body.get("order_id") or "")
    payment_id = str(body.get("razorpay_payment_id") or "")
    item = ddb.get_item(TableName=PAYOUTS_TABLE, Key={"sub": {"S": "order#" + order_id}, "sk": {"S": "order"}}).get("Item")
    order = public(item) if item else None
    if not order or order.get("supporter_sub") != sub:
        return resp(404, {"error": "no such donation order"})
    kind = order.get("kind", "donation")
    if order["status"] != "created":
        return resp(200, {"order_id": order_id, "status": order["status"], "amount_inr": order["amount_inr"], "kind": kind, "mode": order["mode"]})
    if order["mode"] == "razorpay":
        cfg = gateway()
        if not cfg or not payments.verify_checkout(order_id, payment_id, body.get("razorpay_signature"), cfg["key_secret"]):
            log(msg="request", request_id=request_id, actor=sub, action="DonateConfirm", decision="DENY", status=400, reason="bad_signature")
            return resp(400, {"error": "the payment signature did not verify"})
        status = "paid"
    else:
        status = "simulated"
    done = settle_order(order_id, payment_id or "pay_demo", status)
    log(msg="request", request_id=request_id, actor=sub, action="DonateConfirm", decision="ALLOW", status=200, mode=order["mode"], result=status)
    return resp(200, {"order_id": order_id, "status": done["status"], "amount_inr": done["amount_inr"], "kind": kind, "mode": done["mode"]})


def h_donations(sub, role, request_id):
    """What the caller has given (donations and pool top-ups) and, for a donor, what has been given to them."""
    if not payouts_ready():
        return resp(503, {"error": "donations are not configured"})
    recv = donations_received(sub) if role == "donor" else []
    log(msg="request", request_id=request_id, actor=sub, action="Donations", decision="ALLOW", status=200)
    return resp(200, {"mode": "razorpay" if gateway() else "demo", "given": donations_given(sub), "received": recv,
                      "received_inr": sum(r["amount_inr"] for r in recv if r["status"] == "paid")})


# ---- payouts (money out) ----

def payout_candidates():
    """Everyone who may be owed money, with the arithmetic: pool share + direct donations - what is already on its way."""
    stats, shares, _ = fund_shares()
    donors = {d for d in shares if not d.startswith("sim:")} | {d for d, v in stats.items() if eligible(v)}
    out = []
    for d in donors:
        pool = shares.get(d, {}).get("estimated_inr", 0)
        direct = sum(r["amount_inr"] for r in donations_received(d) if r["status"] == "paid" and r["period"] == period_key())
        rows = payout_rows(d)
        paid = paid_amount(rows)
        out.append({"donor": d, "points": shares.get(d, {}).get("points", 0), "pool": pool, "direct": direct, "rows": rows,
                    "paid": paid, "owed": max(pool + direct - paid, 0), "profile": get_profile(d)})
    out.sort(key=lambda c: -c["owed"])
    return out


def h_payout_list(sub, role, request_id):
    """Coordinator: who is owed what, the status of every payout, and whether bank details are on file. Masked only."""
    if role != "coordinator":
        return resp(403, {"error": "coordinator only", "actor": sub})
    if not payouts_ready():
        return resp(503, {"error": "payout details are not configured"})
    cands = payout_candidates()
    rows = []
    for c in cands:
        if c["pool"] <= 0 and c["direct"] <= 0 and c["paid"] <= 0:
            continue
        rows.append({"donor_sub": c["donor"], "points": c["points"], "estimated_inr": c["pool"], "direct_inr": c["direct"],
                     "owed_inr": c["owed"], "paid_inr": c["paid"],
                     "profile": payouts.public_profile(public(c["profile"]) if c["profile"] else None),
                     "payments": public_payments(c["rows"])[:5],
                     "can_pay": bool(c["profile"]) and c["owed"] >= payments.MIN_PAYOUT_INR})
    pool = pool_amount()
    ledger = {"collected_inr": pool + sum(r["direct_inr"] for r in rows), "owed_inr": sum(r["owed_inr"] for r in rows),
              "paid_inr": sum(r["paid_inr"] for r in rows)}
    log(msg="request", request_id=request_id, actor=sub, action="PayoutList", decision="ALLOW", status=200, rows=len(rows))
    return resp(200, {"mode": "razorpayx" if payout_gateway() else "demo", "period": period_label() if gateway() else "Demo month",
                      "pool_inr": pool, "payouts": rows, "ledger": ledger,
                      "note": "PantryPass keeps nothing. Payouts go to donors through Razorpay; you never see an account number."})


def _payout_ids(donor, ordinal, amount):
    ref = hashlib.sha256(("%s|%d" % (donor, ordinal)).encode()).hexdigest()[:32]
    idem = hashlib.sha256(("%s|%d|%d" % (donor, ordinal, amount)).encode()).hexdigest()[:36]
    return ref, idem


def _apply_result(donor, sk, status, payout_id=None, utr=None, error=None):
    sets, vals = ["#st = :s", "updated = :t"], {":s": {"S": status}, ":t": {"N": str(int(time.time())) }}
    if payout_id:
        sets.append("payout_id = :p"); vals[":p"] = {"S": payout_id}
    if utr:
        sets.append("utr = :u"); vals[":u"] = {"S": utr}
    if error:
        sets.append("error = :e"); vals[":e"] = {"S": error[:200]}
    ddb.update_item(TableName=PAYOUTS_TABLE, Key={"sub": {"S": donor}, "sk": {"S": sk}}, UpdateExpression="SET " + ", ".join(sets),
                    ExpressionAttributeNames={"#st": "status"}, ExpressionAttributeValues=vals)


def _send(pg, donor, profile_item, sk, ordinal, amount):
    """Ask RazorpayX to pay `amount` rupees to the donor's account and record the answer on the payout row.
    The same (donor, ordinal, amount) always produces the same idempotency key, so asking twice cannot pay twice."""
    ref, idem = _payout_ids(donor, ordinal, amount)
    prof = public(profile_item)
    out, kind, text = payments.create_payout(pg["key_id"], pg["key_secret"], pg["payout_account"],
        {"amount_inr": amount, "idem": idem, "reference_id": ref, "donor_ref": donor, "holder_name": prof.get("holder_name"),
         "ifsc": prof.get("ifsc"), "bank_account": unseal(donor, prof["account_enc"])})
    if out:
        st = out.get("status") if out.get("status") in payments.PAYOUT_STATUSES else "processing"
        _apply_result(donor, sk, st, payout_id=out.get("id"), utr=out.get("utr"))
        return st, None
    if kind == "definite":
        _apply_result(donor, sk, "failed", error=text)
        return "failed", text
    return "initiating", text


def run_payouts(actor):
    """Pay every donor who has bank details and is owed at least the minimum, at most MAX_PAYOUTS_PER_RUN per run.
    Each payout row is created first with a conditional write (two runs cannot take the same ordinal), then sent with an
    idempotency key; a row that never got an answer is asked about again before anything new is sent."""
    pg = payout_gateway()
    paid, skipped, more = [], [], False
    cands = payout_candidates()
    now = int(time.time())
    if pg:                                           # first settle anything that never got an answer
        for c in cands:
            for r in c["rows"]:
                if r["status"] == "initiating" and now - (r["ts"] or now) > STUCK_AFTER_SECONDS and c["profile"]:
                    _send(pg, c["donor"], c["profile"], r["sk"], int(r["sk"].split("#")[1]), r["amount_inr"])
        cands = payout_candidates()
    for c in cands:
        if c["owed"] <= 0:
            continue
        if not c["profile"]:
            skipped.append({"donor_sub": c["donor"], "reason": "no bank details"})
            continue
        if c["owed"] < payments.MIN_PAYOUT_INR:
            skipped.append({"donor_sub": c["donor"], "reason": "below the Rs %d minimum" % payments.MIN_PAYOUT_INR})
            continue
        if len(paid) >= MAX_PAYOUTS_PER_RUN:
            more = True
            continue
        ordinal = len([r for r in c["rows"] if r["sk"].startswith("out#")]) + 1
        sk = "out#%06d" % ordinal
        ref, idem = _payout_ids(c["donor"], ordinal, c["owed"])
        try:
            ddb.put_item(TableName=PAYOUTS_TABLE, ConditionExpression="attribute_not_exists(sk)", Item={
                "sub": {"S": c["donor"]}, "sk": {"S": sk}, "amount_inr": {"N": str(c["owed"])},
                "status": {"S": "initiating" if pg else "simulated"}, "mode": {"S": "razorpay" if pg else "simulated"},
                "reference_id": {"S": ref}, "idem": {"S": idem}, "actor": {"S": actor}, "ts": {"N": str(now)}, "updated": {"N": str(now)},
                "period": {"S": period_key(now)}})
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") != "ConditionalCheckFailedException":
                raise
            skipped.append({"donor_sub": c["donor"], "reason": "a payout is already being sent"})
            continue
        if not pg:
            paid.append({"donor_sub": c["donor"], "amount_inr": c["owed"], "status": "simulated"})
            continue
        ddb.put_item(TableName=PAYOUTS_TABLE, Item={"sub": {"S": "payref#" + ref}, "sk": {"S": "ref"},
                                                    "donor_sub": {"S": c["donor"]}, "out_sk": {"S": sk}})
        st, err = _send(pg, c["donor"], c["profile"], sk, ordinal, c["owed"])
        if st == "failed":
            skipped.append({"donor_sub": c["donor"], "reason": err or "the payout was refused"})
        else:
            paid.append({"donor_sub": c["donor"], "amount_inr": c["owed"], "status": st})
    log(msg="payout_run", actor=actor, mode="razorpayx" if pg else "demo", paid=len(paid), skipped=len(skipped))
    return {"mode": "razorpayx" if pg else "demo", "paid": paid, "skipped": skipped, "more": more}


def h_payout_run(sub, role, request_id):
    if role != "coordinator":
        return resp(403, {"error": "coordinator only", "actor": sub})
    if not payouts_ready():
        return resp(503, {"error": "payout details are not configured"})
    return resp(200, run_payouts(sub))


def apply_payout_event(entity):
    """A RazorpayX payout changed state. Found by the reference_id we sent; ignored once the payout is terminal."""
    status, ref = entity.get("status"), entity.get("reference_id")
    if status not in payments.PAYOUT_STATUSES or not ref:
        return
    link = ddb.get_item(TableName=PAYOUTS_TABLE, Key={"sub": {"S": "payref#" + ref}, "sk": {"S": "ref"}}).get("Item")
    if not link:
        return
    donor, sk = s(link, "donor_sub"), s(link, "out_sk")
    row = ddb.get_item(TableName=PAYOUTS_TABLE, Key={"sub": {"S": donor}, "sk": {"S": sk}}).get("Item")
    if not row or s(row, "status") in payments.PAYOUT_TERMINAL:
        return
    err = (entity.get("status_details") or {}).get("description") if status in ("reversed", "failed", "rejected", "cancelled") else None
    _apply_result(donor, sk, status, payout_id=entity.get("id"), utr=entity.get("utr"), error=err)


def h_razorpay_webhook(raw_body, headers):
    """Razorpay tells us a payment was captured or a payout changed state. Signed with the webhook secret; delivered at
    least once, so each event id is processed once."""
    cfg = gateway()
    hdrs = headers or {}
    if not cfg or not payments.verify_webhook(raw_body, hdrs.get("x-razorpay-signature", ""), cfg.get("webhook_secret", "")):
        log(msg="bad_signature", source="razorpay")
        return resp(400, {"error": "bad signature"})
    eid = hdrs.get("x-razorpay-event-id")
    if eid and ddb.get_item(TableName=PAYOUTS_TABLE, Key={"sub": {"S": "evt#" + eid}, "sk": {"S": "evt"}}).get("Item"):
        return resp(200, {"duplicate": True})
    try:
        ev = json.loads(raw_body)
        name = ev.get("event", "")
        if name in ("payment.captured", "order.paid"):
            pay = ev["payload"]["payment"]["entity"]
            settle_order(pay["order_id"], pay["id"], "paid")
        elif name.startswith("payout."):
            apply_payout_event(ev["payload"]["payout"]["entity"])
    except (ValueError, KeyError, TypeError):
        return resp(200, {"ignored": True})
    if eid:
        ddb.put_item(TableName=PAYOUTS_TABLE, Item={"sub": {"S": "evt#" + eid}, "sk": {"S": "evt"}, "ts": {"N": str(int(time.time()))}})
    return resp(200, {"ok": True})


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

    if event.get("source") == "aws.events":                              # the optional EventBridge schedule: run payouts
        return resp(200, run_payouts("schedule")) if payouts_ready() else resp(503, {"error": "payouts are not configured"})

    if method == "POST" and path.rstrip("/") == "/razorpay/webhook":      # unauthenticated route: the HMAC is the credential
        raw = event.get("body") or ""
        if event.get("isBase64Encoded"):
            raw = base64.b64decode(raw)
        hdrs = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
        return h_razorpay_webhook(raw, hdrs)

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
        if method == "GET" and parts == ["open-offers"]:
            return h_open_offers(sub, role, request_id)
        if method == "GET" and parts == ["fund"]:
            return h_fund(sub, role, request_id)
        if parts == ["donations"] and method == "GET":
            return h_donations(sub, role, request_id)
        if parts == ["donations"] and method == "POST":
            return h_donate(sub, role, body, request_id)
        if parts == ["donations", "confirm"] and method == "POST":
            return h_donate_confirm(sub, role, body, request_id)
        if parts == ["pool"] and method == "POST":
            return h_pool(sub, role, body, request_id)
        if parts == ["payouts", "run"] and method == "POST":
            return h_payout_run(sub, role, request_id)
        if parts == ["payout-profile"] and method == "GET":
            return h_payout_profile(sub, role, request_id)
        if parts == ["payout-profile"] and method == "PUT":
            return h_payout_save(sub, role, body, request_id)
        if method == "GET" and parts == ["payouts"]:
            return h_payout_list(sub, role, request_id)
        if method == "GET" and parts == ["rewards"]:
            return h_rewards(sub, role, request_id)
        if method == "GET" and parts == ["impact"]:
            return h_impact(sub, role, request_id)
        if method == "GET" and len(parts) == 3 and parts[0] == "lots" and parts[2] == "verify":
            return h_verify(parts[1], sub, role, request_id)
        if method == "GET" and len(parts) == 3 and parts[0] == "lots" and parts[2] == "photo":
            return h_photo(parts[1], sub, role, event.get("queryStringParameters"), request_id)
        if method == "GET" and len(parts) == 2 and parts[0] == "lots":
            return h_get(parts[1], sub, role, request_id)
        if method == "POST" and len(parts) == 3 and parts[0] == "lots":
            lot_id, action = parts[1], parts[2]
            if action == "photo-upload":
                return h_photo_upload(lot_id, sub, role, body, request_id)
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
