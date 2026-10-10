"""Chat adapter Lambda behind GET/POST /webhook/whatsapp (no JWT authorizer).

Security model:
  * POST is accepted only if X-Hub-Signature-256 matches HMAC-SHA256(app secret, raw body).
  * The caller's identity (Cognito sub + role) comes ONLY from the pantrypass-links table,
    keyed by the sender's phone number. Nothing in the message text can change it.
  * The command becomes an API-Gateway-style event with those claims and goes through the
    same api.handler (or the Go Lambda) as the web app, so Verified Permissions, conditional
    writes, idempotency and the quantity invariant apply unchanged.
  * The WhatsApp message id is the idem_key, so a re-delivered webhook cannot double count.
"""

import base64
import hmac
import json
import os
import time

import boto3

import api
import chatio
import chatlogic as cl

ddb = boto3.client("dynamodb")
lam = boto3.client("lambda")
LINKS = os.environ.get("LINKS_TABLE", "pantrypass-links")
GO_FUNCTION = os.environ.get("GO_FUNCTION", "pantrypass-api-go")
PENDING_CODE_SECONDS = 1800


def reply_http(status, text="ok"):
    return {"statusCode": status, "headers": {"content-type": "text/plain"}, "body": text}


def header(event, name):
    for k, v in (event.get("headers") or {}).items():
        if k.lower() == name:
            return v
    return None


def get_link(phone):
    r = ddb.get_item(TableName=LINKS, Key={"phone": {"S": phone}}, ConsistentRead=True)
    return r.get("Item")


def my_lots(sub, role):
    kw = {"TableName": api.LOTS}
    if role == "donor":
        kw.update(FilterExpression="donor_sub = :u", ExpressionAttributeValues={":u": {"S": sub}})
    elif role == "receiver":
        kw.update(FilterExpression="receiver_sub = :u", ExpressionAttributeValues={":u": {"S": sub}})
    elif role != "coordinator":
        return []
    return [api.public(i) for i in api.scan_all(**kw)]


def api_event(method, path, body, sub, role, request_id):
    return {
        "version": "2.0",
        "rawPath": path,
        "requestContext": {
            "requestId": request_id,
            "http": {"method": method, "path": path},
            "authorizer": {"jwt": {"claims": {"sub": sub, "cognito:groups": "[%s]" % role}}},
        },
        "body": json.dumps(body),
    }


def dispatch(ev, path):
    if cl.is_go_route(path):
        r = lam.invoke(FunctionName=GO_FUNCTION, Payload=json.dumps(ev).encode("utf-8"))
        out = json.loads(r["Payload"].read() or b"{}")
    else:
        out = api.handler(ev, None)
    try:
        body = json.loads(out.get("body") or "{}")
    except ValueError:
        body = {}
    return out.get("statusCode", 500), body


def handle_text(phone, message_id, text):
    """Returns the reply text. Pure of Meta specifics, so tests can drive it directly."""
    link = get_link(phone)
    if not link:
        return ("This number is not linked to a PantryPass account, so I can't act on messages from it. "
                "Ask your coordinator to link it.")
    sub = link["sub"]["S"]
    role = link.get("role", {}).get("S", "user")

    p = cl.parse_command(text)
    if "error" in p:
        return "%s.\n%s" % (p["error"].capitalize() if p["error"] != "unknown command" else "I didn't understand that", cl.HELP)
    if p["cmd"] == "HELP":
        return cl.HELP
    if p["cmd"] == "CODE":
        ddb.update_item(TableName=LINKS, Key={"phone": {"S": phone}},
                        UpdateExpression="SET pending_code = :c, pending_code_ts = :t",
                        ExpressionAttributeValues={":c": {"S": p["code"]}, ":t": {"N": str(int(time.time()))}})
        return "Pickup code saved. It is used with your next RECEIVED n."

    lot = cl.pick_lot(my_lots(sub, role), p["lot"])
    if lot is None:
        return "I couldn't find a matching open lot for you."
    code = p["code"]
    if p["cmd"] == "RECEIVED" and not code:
        pc, pts = link.get("pending_code", {}).get("S"), int(link.get("pending_code_ts", {}).get("N", "0"))
        if pc and time.time() - pts < PENDING_CODE_SECONDS:
            code = pc
    method, path, fields = cl.route_for(p["cmd"], lot["lot_id"], p["n"], code)
    if method == "POST":
        fields = dict(fields, idem_key="wa-" + message_id, expected_version=lot.get("version"))
    status, body = dispatch(api_event(method, path, fields, sub, role, "wa-" + message_id), path)
    print(json.dumps({"msg": "chat_command", "cmd": p["cmd"], "lot_id": lot["lot_id"], "actor": sub,
                      "status": status, "message_id": message_id}))
    return cl.reply_for(status, body, p["cmd"])


def handler(event, context):
    method = ((event.get("requestContext") or {}).get("http") or {}).get("method", "")
    if method == "GET":
        q = event.get("queryStringParameters") or {}
        expected = chatio.secrets().get("WA_VERIFY_TOKEN", "")
        given = q.get("hub.verify_token", "")
        if q.get("hub.mode") == "subscribe" and expected and hmac.compare_digest(given.encode("utf-8"), expected.encode("utf-8")):
            return reply_http(200, q.get("hub.challenge", ""))
        return reply_http(403, "forbidden")
    if method != "POST":
        return reply_http(405, "method not allowed")

    raw = event.get("body") or ""
    raw = base64.b64decode(raw) if event.get("isBase64Encoded") else raw.encode("utf-8")
    if not cl.verify_signature(chatio.secrets().get("WA_APP_SECRET", ""), raw, header(event, "x-hub-signature-256")):
        print(json.dumps({"msg": "bad_signature"}))
        return reply_http(403, "bad signature")
    try:
        payload = json.loads(raw)
    except ValueError:
        return reply_http(400, "bad json")

    for entry in payload.get("entry", []):
        for change in entry.get("changes", []):
            for m in (change.get("value") or {}).get("messages", []) or []:
                phone, mid = cl.normalize_phone(m.get("from")), m.get("id")
                if not phone or not mid:
                    continue
                if m.get("type") != "text":
                    chatio.send_text(phone, "I can only read text messages for now. Reply HELP for commands.")
                    continue
                try:
                    text = handle_text(phone, mid, (m.get("text") or {}).get("body", ""))
                except Exception as e:  # never let one message turn into a webhook retry storm
                    print(json.dumps({"msg": "chat_error", "error": type(e).__name__}))
                    text = "Something went wrong on our side. Send STATUS to see where the lot stands before retrying, or use the web app."
                chatio.send_text(phone, text)
    return reply_http(200)
