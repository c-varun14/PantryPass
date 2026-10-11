"""Transport for the chat channel: send_text(to, text) and the channel secrets.

WhatsApp Cloud API is the transport today. A Telegram adapter would implement the same
send_text(to, text) and be selected with CHANNEL_TRANSPORT=telegram. CHANNEL_TRANSPORT=log
only writes the outbound text to CloudWatch (used for dry runs and tests)."""

import base64
import json
import os
import urllib.parse
import urllib.error
import urllib.request

import boto3

SECRET_ID = os.environ.get("CHANNEL_SECRET_ID", "pantrypass/channel")
GRAPH = "https://graph.facebook.com/v21.0"
_cache = {}


def secrets():
    """WA_PHONE_NUMBER_ID, WA_ACCESS_TOKEN, WA_APP_SECRET, WA_VERIFY_TOKEN from Secrets Manager."""
    if "s" not in _cache:
        raw = boto3.client("secretsmanager").get_secret_value(SecretId=SECRET_ID)["SecretString"]
        _cache["s"] = json.loads(raw)
    return _cache["s"]


def send_text(to, text):
    """Returns True when the transport accepted the message. Never raises."""
    transport = os.environ.get("CHANNEL_TRANSPORT", "whatsapp")
    if transport == "log":
        print(json.dumps({"msg": "outbound", "to_suffix": str(to)[-4:], "text": text}))
        return True
    if transport == "twilio":
        return _send_twilio(to, text)
    try:
        sec = secrets()
        req = urllib.request.Request(
            "%s/%s/messages" % (GRAPH, sec["WA_PHONE_NUMBER_ID"]),
            data=json.dumps({"messaging_product": "whatsapp", "to": to, "type": "text",
                             "text": {"body": text[:4000]}}).encode("utf-8"),
            headers={"Authorization": "Bearer " + sec["WA_ACCESS_TOKEN"], "Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=8) as r:
            return 200 <= r.status < 300
    except (urllib.error.URLError, KeyError, ValueError, OSError) as e:
        print(json.dumps({"msg": "send_failed", "error": type(e).__name__}))
        return False


def _send_twilio(to, text):
    """Twilio WhatsApp (sandbox or approved sender) through the REST API, stdlib only."""
    try:
        sec = secrets()
        sid, token, sender = sec["TWILIO_ACCOUNT_SID"], sec["TWILIO_AUTH_TOKEN"], sec["TWILIO_FROM"]
        if not sender.startswith("whatsapp:"):
            sender = "whatsapp:" + sender
        body = urllib.parse.urlencode({"From": sender, "To": "whatsapp:+" + str(to).lstrip("+"),
                                       "Body": text[:1500]}).encode("utf-8")
        auth = base64.b64encode(("%s:%s" % (sid, token)).encode("utf-8")).decode()
        req = urllib.request.Request(
            "https://api.twilio.com/2010-04-01/Accounts/%s/Messages.json" % sid, data=body, method="POST",
            headers={"Authorization": "Basic " + auth, "Content-Type": "application/x-www-form-urlencoded"})
        with urllib.request.urlopen(req, timeout=8) as r:
            return 200 <= r.status < 300
    except (urllib.error.URLError, KeyError, ValueError, OSError) as e:
        print(json.dumps({"msg": "send_failed", "error": type(e).__name__}))
        return False
