"""Pure helpers for the chat channel: webhook signature check, phone normalisation,
command parsing and lot selection. No AWS calls, so they are unit-testable."""

import base64
import hashlib
import hmac
import re
from urllib.parse import parse_qs

HELP = (
    "PantryPass commands:\n"
    "ACCEPT | HANDOFF n | RECEIVED n [CODE 123456] | DISTRIBUTED n | RETURNED n | DISPOSED n | CLOSE | STATUS | CODE 123456 | HELP\n"
    "Add #abc123 to pick a lot, otherwise your latest open lot is used."
)

NUMERIC = {"HANDOFF": "donor_handoff", "RECEIVED": "received", "DISTRIBUTED": "distributed",
           "RETURNED": "returned", "DISPOSED": "disposed"}
SIMPLE = {"ACCEPT", "CLOSE", "STATUS", "HELP"}
TERMINAL = {"ACCOUNTED_FOR"}


def verify_signature(app_secret, raw_body, header):
    """X-Hub-Signature-256 is 'sha256=' + HMAC-SHA256(app_secret, raw body)."""
    if not (app_secret and header and isinstance(raw_body, (bytes, bytearray)) and header.startswith("sha256=")):
        return False
    want = hmac.new(app_secret.encode("utf-8"), bytes(raw_body), hashlib.sha256).hexdigest()
    return hmac.compare_digest(want.encode("utf-8"), header[len("sha256="):].strip().lower().encode("utf-8"))


def twilio_signature(auth_token, url, params):
    """Twilio: base64(HMAC-SHA1(auth token, url + each POST param name+value sorted by name))."""
    data = url + "".join(k + params[k] for k in sorted(params))
    return base64.b64encode(hmac.new(auth_token.encode("utf-8"), data.encode("utf-8"), hashlib.sha1).digest()).decode()


def verify_twilio(auth_token, url, params, header):
    if not (auth_token and url and header and isinstance(params, dict)):
        return False
    want = twilio_signature(auth_token, url, params)
    return hmac.compare_digest(want.encode("utf-8"), header.strip().encode("utf-8"))


def parse_form(raw_body):
    """application/x-www-form-urlencoded bytes -> {name: first value}."""
    try:
        q = parse_qs(bytes(raw_body).decode("utf-8"), keep_blank_values=True)
    except (UnicodeDecodeError, ValueError):
        return {}
    return {k: v[0] for k, v in q.items()}


def normalize_phone(p):
    """Digits only, so '+91 98765 43210' and '919876543210' are the same key."""
    return re.sub(r"\D", "", str(p or ""))


def parse_command(text):
    """Returns {'cmd', 'n', 'lot', 'code'} or {'error': str}. Never raises."""
    words = str(text or "").strip().split()
    if not words:
        return {"error": "empty"}
    out = {"cmd": words[0].upper().rstrip(":"), "n": None, "lot": None, "code": None}
    rest = []
    i = 1
    while i < len(words):
        w = words[i]
        if w.startswith("#") and len(w) > 1:
            out["lot"] = w[1:].lower()
        elif w.upper() == "CODE" and i + 1 < len(words):
            i += 1
            out["code"] = words[i]
        else:
            rest.append(w)
        i += 1
    cmd = out["cmd"]
    if cmd == "CODE":
        # "CODE 123456" parsed above as cmd CODE with the code in the first word
        if len(rest) > (0 if out["code"] else 1):
            return {"error": "CODE takes only the 6-digit pickup code"}
        c = out["code"] or (rest[0] if rest else None)
        if not c or not re.fullmatch(r"\d{6}", c):
            return {"error": "CODE needs the 6-digit pickup code, e.g. CODE 123456"}
        out["code"] = c
        return out
    if cmd in NUMERIC:
        if len(rest) != 1 or not re.fullmatch(r"\d{1,6}", rest[0]):
            return {"error": "%s needs one whole number, e.g. %s 8" % (cmd, cmd)}
        out["n"] = int(rest[0])
    elif cmd in SIMPLE:
        if rest:
            return {"error": "%s takes no extra words" % cmd}
    else:
        return {"error": "unknown command"}
    if out["code"] is not None and (cmd != "RECEIVED" or not re.fullmatch(r"\d{6}", out["code"])):
        return {"error": "only RECEIVED takes a 6-digit CODE"}
    return out


def short_id(lot_id):
    return (lot_id or "").replace("lot-", "")[:6]


def pick_lot(lots, wanted=None):
    """lots: plain dicts for ONE person. wanted: hex prefix typed after '#'.
    Without it, the newest lot that is not accounted for."""
    if wanted:
        hits = [l for l in lots if (l.get("lot_id") or "").replace("lot-", "").startswith(wanted)]
        return hits[0] if len(hits) == 1 else None
    open_lots = [l for l in lots if l.get("stage") not in TERMINAL]
    open_lots.sort(key=lambda l: l.get("created_epoch", 0), reverse=True)
    return open_lots[0] if open_lots else None


def route_for(cmd, lot_id, n, code):
    """(method, path, body_fields) for a command. STATUS is a GET."""
    base = "/lots/" + lot_id
    if cmd == "STATUS":
        return "GET", base, {}
    if cmd == "ACCEPT":
        return "POST", base + "/accept", {}
    if cmd == "CLOSE":
        return "POST", base + "/close", {}
    if cmd == "HANDOFF":
        return "POST", base + "/handoff", {"donor_handoff": n}
    if cmd == "RECEIVED":
        body = {"received": n}
        if code:
            body["pickup_code"] = code
        return "POST", base + "/receipt", body
    if cmd == "DISTRIBUTED":
        return "POST", base + "/distribution", {"distributed": n}
    if cmd == "RETURNED":
        return "POST", base + "/disposition", {"returned": n}
    if cmd == "DISPOSED":
        return "POST", base + "/disposition", {"disposed": n}
    raise ValueError(cmd)


# Paths served by the Go Lambda rather than the Python one.
def is_go_route(path):
    return path.endswith("/disposition") or path.endswith("/resolve-dispute") or path == "/lots"


def reply_for(status, body, cmd):
    """Plain-language reply for an API result. Mirrors the web UI wording."""
    b = body if isinstance(body, dict) else {}
    if status == 403:
        who = "Not allowed: %s was refused by Verified Permissions for your role. Nothing changed." % (b.get("action") or cmd)
        return who + (" Request %s." % b["request_id"] if b.get("request_id") else "")
    if status in (200, 201):
        if cmd == "STATUS":
            l = b.get("lot", {})
            return ("Lot #%s: %s. offered %s, handed over %s, received %s, distributed %s, returned %s, disposed %s, remaining %s."
                    % (short_id(l.get("lot_id")), l.get("stage"), l.get("offered"), l.get("donor_handoff", "-"),
                       l.get("received", "-"), l.get("distributed", "-"), l.get("returned", "-"),
                       l.get("disposed", "-"), l.get("remaining", "-")))
        msg = "Done: %s. Now %s." % (b.get("action", cmd), b.get("stage", "updated"))
        if b.get("pickup_code"):
            msg += " Pickup code: %s (shown once; give it to the receiver at pickup)." % b["pickup_code"]
        if b.get("count_dispute"):
            msg += " Counts disagree, so a coordinator must resolve it before closing."
        if b.get("confirmed_in_person"):
            msg += " Confirmed in person."
        return msg
    if status == 409:
        return "Not done: %s" % (b.get("error") or "conflict") + (
            " (attempts left: %s)" % b["attempts_left"] if b.get("attempts_left") is not None else "")
    if status == 400:
        return "Not done: %s" % (b.get("error") or "bad request")
    return "Something went wrong (%s). Try again, or use the web app." % status
