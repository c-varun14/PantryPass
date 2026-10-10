#!/usr/bin/env python3
"""Live check of pickup code, hash chain, verify, impact and the chat webhook.
Run after infra/40_lambda.sh, 60_api.sh and 75_channel.sh:  python3 tests/live_trust.py
Passwords/tokens exist only in memory. Prints PASS/FAIL lines; exit 1 on any FAIL."""
import hashlib, hmac, json, os, re, secrets, subprocess, sys, urllib.error, urllib.request

env = {}
for line in open(os.path.join(os.path.dirname(__file__), "..", "infra", ".env.generated")):
    m = re.match(r"export (\w+)=(.*)", line.strip())
    if m:
        env[m.group(1)] = m.group(2)
API, POOL, CLIENT = env["API_URL"], env["COGNITO_POOL_ID"], env["COGNITO_CLIENT_ID"]
REGION = "ap-south-1"
failed = 0


def aws(*a):
    return subprocess.run(["aws", "--region", REGION, *a], capture_output=True, text=True, check=True).stdout


def check(label, ok, extra=""):
    global failed
    failed |= (not ok)
    print(("PASS" if ok else "FAIL"), "|", label, extra)


pw = "Pp-%s-aA1!" % secrets.token_urlsafe(9)
tok = {}
for u in ("donor1", "receiver1", "coordinator1"):
    aws("cognito-idp", "admin-set-user-password", "--user-pool-id", POOL, "--username", u, "--password", pw, "--permanent")
    out = aws("cognito-idp", "admin-initiate-auth", "--user-pool-id", POOL, "--client-id", CLIENT, "--auth-flow",
              "ADMIN_USER_PASSWORD_AUTH", "--auth-parameters", "USERNAME=%s,PASSWORD=%s" % (u, pw))
    tok[u] = json.loads(out)["AuthenticationResult"]["IdToken"]
sub = {u: json.loads(aws("cognito-idp", "admin-get-user", "--user-pool-id", POOL, "--username", u))["UserAttributes"] for u in tok}
sub = {u: [a["Value"] for a in v if a["Name"] == "sub"][0] for u, v in sub.items()}


def call(method, path, who, body=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": "Bearer " + tok[who], "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def lot_flow(label, code_mode):
    st, b = call("POST", "/lots", "donor1", {"receiver_sub": sub["receiver1"], "offered": 6})
    check(label + " create", st == 201); lid = b["lot"]["lot_id"]
    st, b = call("POST", "/lots/%s/accept" % lid, "receiver1", {"idem_key": secrets.token_hex(4), "expected_version": 1})
    check(label + " accept", st == 200)
    hk = secrets.token_hex(4)
    st, b = call("POST", "/lots/%s/handoff" % lid, "donor1", {"idem_key": hk, "expected_version": 2, "donor_handoff": 6})
    code = b.get("pickup_code", "")
    check(label + " handoff returns 6-digit code", st == 200 and re.fullmatch(r"\d{6}", code) is not None)
    st, b2 = call("POST", "/lots/%s/handoff" % lid, "donor1", {"idem_key": hk, "expected_version": 2, "donor_handoff": 6})
    check(label + " handoff replay has no code", st == 200 and "pickup_code" not in b2)
    st, g = call("GET", "/lots/" + lid, "receiver1")
    blob = json.dumps(g)
    check(label + " code/hash never in GET lot or events", code not in blob and "pickup_hash" not in blob and "pickup_salt" not in blob)
    if code_mode == "right":
        wrong = "%06d" % ((int(code) + 1) % 1000000)
        st, e = call("POST", "/lots/%s/receipt" % lid, "receiver1", {"idem_key": secrets.token_hex(4), "expected_version": 3, "received": 6, "pickup_code": wrong})
        check(label + " wrong code -> 409 attempts_left 4", st == 409 and e.get("attempts_left") == 4, str(e))
        st, e = call("POST", "/lots/%s/receipt" % lid, "receiver1", {"idem_key": secrets.token_hex(4), "expected_version": 3, "received": 6, "pickup_code": code})
        check(label + " right code -> in person", st == 200 and e.get("confirmed_in_person") is True, str(e))
        st, e = call("POST", "/lots/%s/receipt" % lid, "receiver1", {"idem_key": secrets.token_hex(4), "expected_version": 4, "received": 6, "pickup_code": code})
        check(label + " code cannot be replayed", st == 409)
    else:
        st, e = call("POST", "/lots/%s/receipt" % lid, "receiver1", {"idem_key": secrets.token_hex(4), "expected_version": 3, "received": 6})
        check(label + " receipt without code works, not in person", st == 200 and e.get("confirmed_in_person") is False)
    st, e = call("POST", "/lots/%s/distribution" % lid, "receiver1", {"idem_key": secrets.token_hex(4), "expected_version": 4, "distributed": 6})
    check(label + " distribute", st == 200)
    st, e = call("POST", "/lots/%s/close" % lid, "receiver1", {"idem_key": secrets.token_hex(4), "expected_version": 5})
    check(label + " close", st == 200)
    st, v = call("GET", "/lots/%s/verify" % lid, "donor1")
    check(label + " chain verifies", st == 200 and v.get("ok") is True and v.get("length") == 6, str(v))
    return lid


lid = lot_flow("A", "right")
lot_flow("B", "none")
# Go-written events (disposition, resolve-dispute) must be chained too
st, b = call("POST", "/lots", "donor1", {"receiver_sub": sub["receiver1"], "offered": 6}); gl = b["lot"]["lot_id"]
call("POST", "/lots/%s/accept" % gl, "receiver1", {"idem_key": secrets.token_hex(4), "expected_version": 1})
call("POST", "/lots/%s/handoff" % gl, "donor1", {"idem_key": secrets.token_hex(4), "expected_version": 2, "donor_handoff": 6})
call("POST", "/lots/%s/receipt" % gl, "receiver1", {"idem_key": secrets.token_hex(4), "expected_version": 3, "received": 5})
st, e = call("POST", "/lots/%s/disposition" % gl, "receiver1", {"idem_key": secrets.token_hex(4), "expected_version": 4, "returned": 1})
check("G disposition (Go) ok", st == 200, str(e))
st, e = call("POST", "/lots/%s/resolve-dispute" % gl, "coordinator1", {"idem_key": secrets.token_hex(4), "expected_version": 5, "reconciled_received": 5})
check("G resolve-dispute (Go) ok", st == 200, str(e))
call("POST", "/lots/%s/distribution" % gl, "receiver1", {"idem_key": secrets.token_hex(4), "expected_version": 6, "distributed": 4})
st, e = call("POST", "/lots/%s/close" % gl, "receiver1", {"idem_key": secrets.token_hex(4), "expected_version": 7})
check("G close", st == 200, str(e))
st, v = call("GET", "/lots/%s/verify" % gl, "coordinator1")
check("G chain verifies across Python and Go events", st == 200 and v.get("ok") is True and v.get("length") == 8, str(v))
st, i = call("GET", "/impact", "coordinator1")
check("impact for coordinator", st == 200 and i.get("confirmed_in_person", 0) >= 1, str(i))
st, i = call("GET", "/impact", "donor1")
check("impact refused for donor", st == 403)

# tamper evidence: rewrite one event's result directly in DynamoDB, expect verify to fail
q = json.loads(aws("dynamodb", "query", "--table-name", "pantrypass-events", "--key-condition-expression", "lot_id = :l",
                   "--expression-attribute-values", json.dumps({":l": {"S": lid}})))["Items"]
victim = [e for e in q if e.get("action", {}).get("S") == "ReportDistribution"][0]
orig = victim["result"]["S"]
aws("dynamodb", "update-item", "--table-name", "pantrypass-events", "--key",
    json.dumps({"lot_id": {"S": lid}, "event_id": victim["event_id"]}), "--update-expression", "SET #r = :v",
    "--expression-attribute-names", '{"#r":"result"}', "--expression-attribute-values", json.dumps({":v": {"S": orig.replace("6", "9")}}))
st, v = call("GET", "/lots/%s/verify" % lid, "donor1")
check("tampered event detected", st == 200 and v.get("ok") is False and v.get("broken_at") == victim["event_id"]["S"], str(v))
aws("dynamodb", "update-item", "--table-name", "pantrypass-events", "--key",
    json.dumps({"lot_id": {"S": lid}, "event_id": victim["event_id"]}), "--update-expression", "SET #r = :v",
    "--expression-attribute-names", '{"#r":"result"}', "--expression-attribute-values", json.dumps({":v": {"S": orig}}))
st, v = call("GET", "/lots/%s/verify" % lid, "donor1")
check("restored event verifies again", v.get("ok") is True)

# chat webhook (uses the stored app secret; no WhatsApp token needed, replies just fail to send)
sec = json.loads(json.loads(aws("secretsmanager", "get-secret-value", "--secret-id", "pantrypass/channel"))["SecretString"])
hook = API + "/webhook/whatsapp"


def post(body, sig):
    req = urllib.request.Request(hook, method="POST", data=body, headers={"Content-Type": "application/json", "X-Hub-Signature-256": sig})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


try:
    urllib.request.urlopen(hook + "?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=x", timeout=20)
    check("verify with wrong token refused", False)
except urllib.error.HTTPError as e:
    check("verify with wrong token refused", e.code == 403)
r = urllib.request.urlopen(hook + "?hub.mode=subscribe&hub.verify_token=%s&hub.challenge=abc123" % sec["WA_VERIFY_TOKEN"], timeout=20)
check("verify challenge echoed", r.read().decode() == "abc123")
phone = "9199%08d" % secrets.randbelow(10**8)
payload = json.dumps({"entry": [{"changes": [{"value": {"messages": [{"from": phone, "id": "wamid.live" + secrets.token_hex(4), "type": "text", "text": {"body": "DISTRIBUTED 5"}}]}}]}]}).encode()
good = "sha256=" + hmac.new(sec["WA_APP_SECRET"].encode(), payload, hashlib.sha256).hexdigest()
check("bad signature rejected", post(payload, "sha256=" + "0" * 64) == 403)
check("unsigned rejected", post(payload, "") == 403)
check("signed message from unlinked number accepted (politely refused)", post(payload, good) == 200)
aws("dynamodb", "put-item", "--table-name", "pantrypass-links", "--item", json.dumps({"phone": {"S": phone}, "sub": {"S": sub["donor1"]}, "role": {"S": "donor"}}))
mid = "wamid.live" + secrets.token_hex(4)
payload = json.dumps({"entry": [{"changes": [{"value": {"messages": [{"from": phone, "id": mid, "type": "text", "text": {"body": "DISTRIBUTED 5"}}]}}]}]}).encode()
good = "sha256=" + hmac.new(sec["WA_APP_SECRET"].encode(), payload, hashlib.sha256).hexdigest()
check("donor chat DISTRIBUTED accepted by webhook", post(payload, good) == 200)
print("RESULT:", "FAILED" if failed else "ALL PASS")
sys.exit(1 if failed else 0)
