"""Direct donations: validation, fee arithmetic and the Razorpay gateway calls.

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


def split_fee(amount_inr, fee_pct):
    """(fee, net) in whole rupees. The platform keeps the rounded-down fee; the donor gets the rest."""
    fee = int(amount_inr * max(fee_pct, 0) // 100)
    return fee, amount_inr - fee


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
