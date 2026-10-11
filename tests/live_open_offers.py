#!/usr/bin/env python3
"""Live check of open offers, units and the fund against the deployed stack. Signs in as the demo users with
DEMO_PASSWORD (it does NOT change any password) and prints PASS/FAIL.

    source infra/00_env.sh && export DEMO_PASSWORD=... && python3 tests/live_open_offers.py
"""
import json, os, subprocess, sys, urllib.error, urllib.request

API, CLIENT, PW = os.environ["API_URL"], os.environ["COGNITO_CLIENT_ID"], os.environ["DEMO_PASSWORD"]
fails = 0


def check(name, ok, detail=""):
    global fails
    fails += 0 if ok else 1
    print("%s | %s %s" % ("PASS" if ok else "FAIL", name, str(detail)[:170] if detail else ""))


def token(user):
    out = subprocess.run(["aws", "cognito-idp", "initiate-auth", "--auth-flow", "USER_PASSWORD_AUTH", "--client-id", CLIENT,
                          "--auth-parameters", "USERNAME=%s,PASSWORD=%s" % (user, PW), "--query", "AuthenticationResult.IdToken",
                          "--output", "text"], capture_output=True, text=True)
    if out.returncode:
        sys.exit("sign-in failed for %s (run infra/25_demo_passwords.sh)" % user)
    return out.stdout.strip()


def call(method, path, tok, body=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


donor, recv, coord = token("donor1"), token("receiver1"), token("coordinator1")
rsub = json.loads(__import__("base64").urlsafe_b64decode(recv.split(".")[1] + "==")).get("sub")

st, b = call("POST", "/lots", donor, {"food": "Cooked rice", "unit": "kg", "offered": 12})
lot = b.get("lot", {})
check("announce 12 kg of cooked rice to everyone", st == 201 and lot.get("open_offer") is True and "receiver_sub" not in lot
      and (lot.get("food"), lot.get("unit"), lot.get("offered")) == ("Cooked rice", "kg", 12), b)
lid = lot.get("lot_id")
check("a bad unit is refused", call("POST", "/lots", donor, {"food": "x", "unit": "barrels", "offered": 3})[0] == 400)

st, b = call("GET", "/open-offers", recv)
check("a receiver sees it under open offers", st == 200 and any(l["lot_id"] == lid for l in b.get("lots", [])), b)
check("a donor cannot browse open offers", call("GET", "/open-offers", donor)[0] == 403)
st, b = call("GET", "/lots/%s" % lid, recv)
check("a receiver can open an unclaimed offer", st == 200 and b["lot"]["lot_id"] == lid)

st, b = call("POST", "/lots/%s/accept" % lid, donor, {"idem_key": "d-" + lid, "expected_version": 1})
check("the donor cannot claim their own offer", st == 403 and b.get("error") == "VP_DENY", b)
st, b = call("POST", "/lots/%s/accept" % lid, coord, {"idem_key": "c-" + lid, "expected_version": 1})
check("a coordinator cannot claim it", st == 403 and b.get("error") == "VP_DENY", b)

st, b = call("POST", "/lots/%s/accept" % lid, recv, {"idem_key": "r-" + lid, "expected_version": 1})
check("a receiver claims it", st == 200 and b.get("claimed") is True and b.get("receiver_sub") == rsub, b)
st, b = call("POST", "/lots/%s/accept" % lid, recv, {"idem_key": "r2-" + lid, "expected_version": 1})
check("a late second claim is refused", st == 409, b)
st, b = call("GET", "/lots/%s" % lid, donor)
check("the lot now belongs to the claimer", st == 200 and b["lot"].get("receiver_sub") == rsub and b["lot"].get("open_offer") is False, b["lot"] if st == 200 else b)
check("it left the open offers", all(l["lot_id"] != lid for l in call("GET", "/open-offers", recv)[1].get("lots", [])))
check("the claim is in the hash chain", call("GET", "/lots/%s/verify" % lid, donor)[1].get("ok") is True)

st, b = call("GET", "/fund", donor)
check("fund: a donor sees their own share", st == 200 and b.get("demo") is True and b.get("you") and b["allocations"] == [] and b["pool_inr"] > 0, {k: b.get(k) for k in ("pool_inr", "total_points", "you")})
st, c = call("GET", "/fund", coord)
check("fund: the coordinator sees the allocation table", st == 200 and c["you"] is None and len(c["allocations"]) >= 1 and sum(a["estimated_inr"] for a in c["allocations"]) <= c["pool_inr"], {"rows": len(c.get("allocations", []))})
st, r = call("GET", "/fund", recv)
check("fund: a receiver sees no payout rows", st == 200 and r["you"] is None and r["allocations"] == [])
print("RESULT:", "ALL PASS" if not fails else "%d FAILED" % fails)
sys.exit(1 if fails else 0)
