#!/usr/bin/env python3
"""Live check of quantity points, top donors, payout details (KMS), direct donations (simulated mode) and payouts
against the deployed stack. Signs in as the demo users with DEMO_PASSWORD (it does NOT change any password).
It seeds verified lots for the demo donor if she is not a top donor yet.

    source infra/00_env.sh && export DEMO_PASSWORD=... && python3 tests/live_donations.py
"""
import base64, json, os, secrets, subprocess, sys, urllib.error, urllib.request

API, CLIENT, PW = os.environ["API_URL"], os.environ["COGNITO_CLIENT_ID"], os.environ["DEMO_PASSWORD"]
ACCOUNT = "123456789012"
fails = 0


def check(name, ok, detail=""):
    global fails
    fails += 0 if ok else 1
    print("%s | %s %s" % ("PASS" if ok else "FAIL", name, str(detail)[:170] if detail and not ok else ""))


def token(user):
    out = subprocess.run(["aws", "cognito-idp", "initiate-auth", "--auth-flow", "USER_PASSWORD_AUTH", "--client-id", CLIENT,
                          "--auth-parameters", "USERNAME=%s,PASSWORD=%s" % (user, PW), "--query", "AuthenticationResult.IdToken",
                          "--output", "text"], capture_output=True, text=True)
    if out.returncode:
        sys.exit("sign-in failed for %s (run infra/25_demo_passwords.sh)" % user)
    return out.stdout.strip()


def sub_of(tok):
    return json.loads(base64.urlsafe_b64decode(tok.split(".")[1] + "==")).get("sub")


def call(method, path, tok, body=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def k():
    return secrets.token_hex(5)


def verified_lot(donor, recv, qty):
    """One full verified lot: announce, claim, hand over, receive in person with the code, distribute, close."""
    st, b = call("POST", "/lots", donor, {"food": "Rice and dal", "unit": "trays", "offered": qty})
    lid = b["lot"]["lot_id"]
    assert call("POST", "/lots/%s/accept" % lid, recv, {"idem_key": k(), "expected_version": 1})[0] == 200
    st, h = call("POST", "/lots/%s/handoff" % lid, donor, {"idem_key": k(), "expected_version": 2, "donor_handoff": qty})
    code = h.get("pickup_code")
    assert st == 200 and code, h
    assert call("POST", "/lots/%s/receipt" % lid, recv, {"idem_key": k(), "expected_version": 3, "received": qty, "pickup_code": code})[0] == 200
    assert call("POST", "/lots/%s/distribution" % lid, recv, {"idem_key": k(), "expected_version": 4, "distributed": qty})[0] == 200
    assert call("POST", "/lots/%s/close" % lid, recv, {"idem_key": k(), "expected_version": 5})[0] == 200
    return lid


donor, r1, r2, coord = token("donor1"), token("receiver1"), token("receiver2"), token("coordinator1")
dsub = sub_of(donor)

st, rw = call("GET", "/rewards", donor)
need = []
if rw.get("verified_lots", 0) < 3 or rw.get("partners", 0) < 2:
    for recv, qty in ((r1, 24), (r2, 18), (r1, 40)):
        need.append(verified_lot(donor, recv, qty))
    st, rw = call("GET", "/rewards", donor)
check("seeded verified lots across two receivers" if need else "donor already has a broad verified record",
      rw.get("verified_lots", 0) >= 3 and rw.get("partners", 0) >= 2, {k_: rw.get(k_) for k_ in ("verified_lots", "partners")})
check("verified volume is tracked per unit", any(v["unit"] == "trays" and v["quantity"] >= 18 for v in rw.get("volume", [])), rw.get("volume"))
check("volume bonus is in the ledger", any(x["reason"].startswith("Verified") for x in rw.get("ledger", [])))
check("a donor level exists above zero points", rw.get("points", 0) > 0 and rw.get("level"))

st, f = call("GET", "/fund", donor)
check("fund: Asha is eligible and listed as a top donor", st == 200 and f["you"]["eligible"] is True and any(t["donor_sub"] == dsub for t in f["top_donors"]), f.get("you"))
check("fund: donations enabled in simulated mode", f["donations"]["enabled"] is True and f["donations"]["mode"] in ("demo", "razorpay"), f.get("donations"))
mode = f["donations"]["mode"]

# payout details: KMS-sealed, masked everywhere
check("payout: a receiver cannot add bank details", call("PUT", "/payout-profile", r1, {"holder_name": "Ravi K", "account_number": ACCOUNT, "ifsc": "HDFC0001234"})[0] == 403)
check("payout: bad IFSC is refused", call("PUT", "/payout-profile", donor, {"holder_name": "Asha Rao", "account_number": ACCOUNT, "ifsc": "nope"})[0] == 400)
st, p = call("PUT", "/payout-profile", donor, {"holder_name": "Asha Rao", "account_number": ACCOUNT, "ifsc": "hdfc0001234", "upi": "asha@okhdfc"})
check("payout: saved, returned masked, number never echoed", st == 200 and p["account"] == "XXXXXX9012" and ACCOUNT not in json.dumps(p), p)
st, g = call("GET", "/payout-profile", donor)
check("payout: donor reads back the masked profile", st == 200 and g["configured"] and g["ifsc"] == "HDFC0001234" and ACCOUNT not in json.dumps(g))
check("payout: coordinator cannot read a donor's own profile route", call("GET", "/payout-profile", coord)[0] == 403)

# donations
st, o = call("POST", "/donations", r1, {"donor_sub": dsub, "amount_inr": 500, "note": "Thank you"})
check("donate: order created, every rupee goes on to the donor (no fee fields)", st == 200 and o["amount_inr"] == 500 and o["kind"] == "donation" and "fee_inr" not in o and o["mode"] == mode, o)
check("donate: yourself is refused", call("POST", "/donations", donor, {"donor_sub": dsub, "amount_inr": 100})[0] == 409)
check("donate: a non-donor cannot receive", call("POST", "/donations", r1, {"donor_sub": sub_of(r2), "amount_inr": 100})[0] == 409)
check("donate: a tiny amount is refused", call("POST", "/donations", r1, {"donor_sub": dsub, "amount_inr": 3})[0] == 400)
if mode == "demo":
    st, c = call("POST", "/donations/confirm", r2, {"order_id": o["order_id"], "razorpay_payment_id": "pay_demo_x"})
    check("confirm: only the payer can confirm", st == 404)
    st, c = call("POST", "/donations/confirm", r1, {"order_id": o["order_id"], "razorpay_payment_id": "pay_demo_" + k()})
    check("confirm: simulated, never counted as owed", st == 200 and c["status"] == "simulated", c)
    st, c2 = call("POST", "/donations/confirm", r1, {"order_id": o["order_id"], "razorpay_payment_id": "pay_demo_again"})
    check("confirm: repeating it changes nothing", st == 200 and c2["status"] == "simulated")
    st, d = call("GET", "/donations", donor)
    check("donor sees the support, with received_inr 0 for simulated", st == 200 and d["received_inr"] == 0 and any(r["status"] == "simulated" and r["amount_inr"] == 500 for r in d["received"]), d)
    st, gv = call("GET", "/donations", r1)
    check("the supporter sees what they gave", any(x["donor_sub"] == dsub and x["amount_inr"] == 500 for x in gv["given"]))
    st, f2 = call("GET", "/fund", r1)
    row = next(t for t in f2["top_donors"] if t["donor_sub"] == dsub)
    check("top donor shows supporters and amount", row["supporters"] >= 1 and row["supported_inr"] >= 500, row)
try:
    urllib.request.urlopen(urllib.request.Request(API + "/razorpay/webhook", data=b"{}", method="POST", headers={"X-Razorpay-Signature": "bad", "Content-Type": "application/json"}))
    check("webhook: bad signature is refused", False)
except urllib.error.HTTPError as e:
    check("webhook: bad signature is refused (400), no login needed", e.code == 400, e.code)

# sponsor pool top-up (any role), simulated without keys
st, po = call("POST", "/pool", r2, {"amount_inr": 5000, "note": "Sponsor round"})
check("pool: a sponsor starts a top-up (any role), no fee, no recipient", st == 200 and po["kind"] == "pool" and po["amount_inr"] == 5000 and "donor_sub" not in po and "fee_inr" not in po, po)
check("pool: a tiny amount is refused", call("POST", "/pool", r2, {"amount_inr": 3})[0] == 400)
if po.get("mode") == "demo":
    st, pc = call("POST", "/donations/confirm", r2, {"order_id": po["order_id"], "razorpay_payment_id": "pay_demo_" + k()})
    check("pool: simulated top-up never changes the pool", st == 200 and pc["status"] == "simulated" and pc["kind"] == "pool", pc)

# coordinator payouts: masked only, one click, never an account number
st, pl = call("GET", "/payouts", coord)
row = next((r for r in pl.get("payouts", []) if r["donor_sub"] == dsub), None)
check("payouts: coordinator sees Asha with masked details and what is owed", st == 200 and row and row["estimated_inr"] > 0 and row["profile"]["account"] == "XXXXXX9012" and ACCOUNT not in json.dumps(pl), row)
check("payouts: the ledger has no fee line", set(pl["ledger"]) == {"collected_inr", "owed_inr", "paid_inr"}, pl.get("ledger"))
check("payouts: donors and receivers cannot list or run", call("GET", "/payouts", donor)[0] == 403 and call("POST", "/payouts/run", donor)[0] == 403 and call("POST", "/payouts/run", r1)[0] == 403)
check("payouts: the reveal and manual transfer routes are gone", call("GET", "/payouts/%s/details" % dsub, coord)[0] == 404 and call("POST", "/payouts/%s/transfer" % dsub, coord, {"amount_inr": 5, "reference": "UTR 12345"})[0] == 404)
st, run = call("POST", "/payouts/run", coord)
asha = [x for x in run.get("paid", []) if x["donor_sub"] == dsub]
check("payouts: Run payouts pays Asha in one click (simulated without RazorpayX keys)", st == 200 and (asha or any(s_["donor_sub"] == dsub for s_ in run.get("skipped", []))), run)
st, g = call("GET", "/payout-profile", donor)
check("payouts: Asha sees the payout with a status", st == 200 and all({"amount_inr", "status", "mode", "utr", "ts"} <= set(x) for x in g.get("payments", [])) and len(g.get("payments", [])) >= 1, g.get("payments"))
st, run2 = call("POST", "/payouts/run", coord)
check("payouts: running again pays nobody twice", not any(x["donor_sub"] == dsub for x in run2.get("paid", [])), run2)
print("RESULT:", "ALL PASS" if not fails else "%d FAILED" % fails)
sys.exit(1 if fails else 0)
