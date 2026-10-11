"""Money in and out: donation and pool validation and the Razorpay calls (Orders in, RazorpayX Payouts out).

PantryPass keeps no money and takes no fee: every rupee paid in is owed on to donors.

No third-party package: Razorpay's REST API is called with urllib. Keys come from the environment (or a Secrets
Manager secret the caller loads); with none, the caller runs in a clearly labelled simulated mode and no money
moves. Pure functions apart from `create_order`, which takes an injectable opener so tests never touch the network.
"""

import base64
import hashlib
import hmac
import json
import re
import urllib.error
import urllib.request

MIN_INR = 10
MAX_INR = 50000
MIN_PAYOUT_INR = 100
IMPS_MAX_INR = 500000
# Payout lifecycle (RazorpayX): what still counts as money on its way, and what ends it without paying.
PAYOUT_COUNTED = {"initiating", "queued", "pending", "processing", "processed", "simulated"}
PAYOUT_TERMINAL = {"processed", "reversed", "failed", "rejected", "cancelled"}
PAYOUT_STATUSES = {"queued", "pending", "processing", "processed", "reversed", "failed", "rejected", "cancelled"}
API = "https://api.razorpay.com/v1"
NOTE_RE = re.compile(r"^[A-Za-z0-9 .,!?'()-]{0,80}$")


def clean_donation(body):
    """(donation, error). donation = {donor_sub, amount_inr, note}."""
    donor = str(body.get("donor_sub") or "").strip()
    try:
        amount = int(body.get("amount_inr"))
    except (TypeError, ValueError):
        return None, "amount_inr must be a whole number of rupees"
    note = " ".join(str(body.get("note") or "").split())
    if not donor:
        return None, "donor_sub is required"
    if amount < MIN_INR or amount > MAX_INR:
        return None, "amount_inr must be between %d and %d" % (MIN_INR, MAX_INR)
    if not NOTE_RE.match(note):
        return None, "note can be up to 80 characters: letters, numbers and basic punctuation"
    return {"donor_sub": donor, "amount_inr": amount, "note": note}, None


def clean_pool(body):
    """(contribution, error) for a sponsor top-up of the shared pool: {amount_inr, note}."""
    don, err = clean_donation(dict(body, donor_sub="pool"))
    return ({"amount_inr": don["amount_inr"], "note": don["note"]}, None) if not err else (None, err)


def checkout_signature(order_id, payment_id, secret):
    """The signature Razorpay Checkout returns: HMAC-SHA256(order_id|payment_id) keyed with the key secret."""
    return hmac.new(secret.encode(), ("%s|%s" % (order_id, payment_id)).encode(), hashlib.sha256).hexdigest()


def verify_checkout(order_id, payment_id, signature, secret):
    if not (order_id and payment_id and signature and secret):
        return False
    return hmac.compare_digest(checkout_signature(order_id, payment_id, secret), str(signature))


def verify_webhook(raw_body, signature, secret):
    """X-Razorpay-Signature is HMAC-SHA256 of the raw request body keyed with the webhook secret."""
    if not (raw_body and signature and secret):
        return False
    raw = raw_body if isinstance(raw_body, bytes) else str(raw_body).encode()
    return hmac.compare_digest(hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest(), str(signature))


def create_order(key_id, key_secret, amount_inr, receipt, notes, opener=urllib.request.urlopen):
    """Create a Razorpay order. Returns (order_dict, None) or (None, error_text). Amount is sent in paise."""
    payload = json.dumps({"amount": amount_inr * 100, "currency": "INR", "receipt": receipt[:40], "notes": notes}).encode()
    auth = base64.b64encode(("%s:%s" % (key_id, key_secret)).encode()).decode()
    req = urllib.request.Request(API + "/orders", data=payload, method="POST",
                                 headers={"Authorization": "Basic " + auth, "Content-Type": "application/json"})
    try:
        with opener(req, timeout=8) as r:
            order = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return None, "the payment gateway refused the order (%s)" % e.code
    except (urllib.error.URLError, OSError, ValueError):
        return None, "the payment gateway could not be reached"
    if not isinstance(order, dict) or not order.get("id"):
        return None, "the payment gateway sent an unexpected reply"
    return order, None


# ------------------------------------------------------------------ RazorpayX payouts

_RZP_NAME_BAD = re.compile(r"[^A-Za-z0-9 \-_/().]")


def rzp_name(s, lo, hi):
    """A name in the characters Razorpay accepts (a-z A-Z 0-9 space - _ / ( ) .), or None if it is too short."""
    s = " ".join(_RZP_NAME_BAD.sub("", str(s or "")).split())[:hi]
    return s if len(s) >= lo else None


def payout_mode(amount_inr):
    return "IMPS" if amount_inr <= IMPS_MAX_INR else "NEFT"


def create_payout(key_id, key_secret, account_number, p, opener=urllib.request.urlopen):
    """Create a RazorpayX payout with a composite fund account. `p` carries amount_inr, idem, reference_id, donor_ref,
    holder_name, ifsc, bank_account. Returns (payout, None, None), or (None, kind, text) where kind is
    "definite" (Razorpay refused it, nothing was sent) or "uncertain" (no answer: it may have been created, so the
    same idempotency key must be used to ask again)."""
    name_c, name_b = rzp_name(p["holder_name"], 3, 50), rzp_name(p["holder_name"], 4, 120)
    if not name_c or not name_b:
        return None, "definite", "the name on the account is too short for the bank"
    body = {"account_number": account_number, "amount": p["amount_inr"] * 100, "currency": "INR",
            "mode": payout_mode(p["amount_inr"]), "purpose": "payout", "queue_if_low_balance": True,
            "reference_id": p["reference_id"][:40], "narration": "PantryPass payout",
            "notes": {"donor": p["donor_ref"][:40]},
            "fund_account": {"account_type": "bank_account",
                             "bank_account": {"name": name_b, "ifsc": p["ifsc"], "account_number": p["bank_account"]},
                             "contact": {"name": name_c, "type": "vendor", "reference_id": p["donor_ref"][:40]}}}
    auth = base64.b64encode(("%s:%s" % (key_id, key_secret)).encode()).decode()
    req = urllib.request.Request(API + "/payouts", data=json.dumps(body).encode(), method="POST",
                                 headers={"Authorization": "Basic " + auth, "Content-Type": "application/json",
                                          "X-Payout-Idempotency": p["idem"]})
    try:
        with opener(req, timeout=6) as r:
            out = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        if e.code >= 500:
            return None, "uncertain", "the payout service had an error (%s)" % e.code
        try:
            desc = json.loads(e.read().decode()).get("error", {}).get("description")
        except (ValueError, OSError, AttributeError):
            desc = None
        return None, "definite", (desc or "the payout was refused (%s)" % e.code)[:200]
    except (urllib.error.URLError, OSError, ValueError):
        return None, "uncertain", "the payout service could not be reached"
    if not isinstance(out, dict) or not out.get("id"):
        return None, "uncertain", "the payout service sent an unexpected reply"
    return out, None, None
