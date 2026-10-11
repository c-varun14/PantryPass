"""Payout details: validation and masking for the bank details a donor gives so the operator can pay them.

Pure functions, no AWS calls. The account number is encrypted by the caller (KMS) before it is stored and
is never returned in full except to the coordinator who is making the transfer (see docs/api.md, "Payouts").
Nothing here moves money: PantryPass records details and the transfers a coordinator made by hand.
"""

import re

IFSC_RE = re.compile(r"^[A-Z]{4}0[A-Z0-9]{6}$")
UPI_RE = re.compile(r"^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9]{1,31}$")
ACCOUNT_RE = re.compile(r"^[0-9]{9,18}$")
NAME_RE = re.compile(r"^[A-Za-z][A-Za-z .'-]{1,79}$")
REFERENCE_RE = re.compile(r"^[A-Za-z0-9 ._/-]{3,40}$")
MAX_TRANSFER_INR = 1_000_000


def clean_profile(body):
    """(profile, error). profile = {holder_name, account_number, ifsc, upi}; upi may be ''."""
    name = " ".join(str(body.get("holder_name") or "").split())
    account = "".join(str(body.get("account_number") or "").split())
    ifsc = str(body.get("ifsc") or "").strip().upper()
    upi = str(body.get("upi") or "").strip()
    if not NAME_RE.match(name):
        return None, "holder_name must be the name on the account (letters, spaces, . ' -)"
    if not ACCOUNT_RE.match(account):
        return None, "account_number must be 9 to 18 digits"
    if not IFSC_RE.match(ifsc):
        return None, "ifsc must look like HDFC0001234"
    if upi and not UPI_RE.match(upi):
        return None, "upi must look like name@bank"
    return {"holder_name": name, "account_number": account, "ifsc": ifsc, "upi": upi}, None


def mask_account(last4):
    return "XXXXXX" + (last4 or "")


def mask_upi(upi):
    if not upi or "@" not in upi:
        return ""
    local, _, handle = upi.partition("@")
    return local[:2] + "***@" + handle


def public_profile(item):
    """The masked view of a stored profile (plain dict from api.public). Safe for the owner and the coordinator list."""
    if not item:
        return {"configured": False}
    return {"configured": True, "holder_name": item.get("holder_name"), "account": mask_account(item.get("account_last4")),
            "ifsc": item.get("ifsc"), "upi": mask_upi(item.get("upi")), "updated": item.get("updated")}


def clean_transfer(body):
    """(transfer, error) for a coordinator recording a transfer they made by hand."""
    try:
        amount = int(body.get("amount_inr"))
    except (TypeError, ValueError):
        return None, "amount_inr must be a whole number of rupees"
    ref = " ".join(str(body.get("reference") or "").split())
    if amount <= 0 or amount > MAX_TRANSFER_INR:
        return None, "amount_inr must be between 1 and %d" % MAX_TRANSFER_INR
    if not REFERENCE_RE.match(ref):
        return None, "reference must be the bank or UPI transaction reference (3 to 40 characters)"
    return {"amount_inr": amount, "reference": ref}, None
