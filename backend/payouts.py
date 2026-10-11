"""Payout details: validation and masking for the bank details a donor gives so the operator can pay them.

Pure functions, no AWS calls. The account number is encrypted by the caller (KMS) before it is stored and is never
returned to anyone: the server decrypts it only to hand it to Razorpay when paying the donor (see docs/api.md, "Payouts").
"""

import re

IFSC_RE = re.compile(r"^[A-Z]{4}0[A-Z0-9]{6}$")
UPI_RE = re.compile(r"^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9]{1,31}$")
ACCOUNT_RE = re.compile(r"^[0-9]{9,18}$")
NAME_RE = re.compile(r"^[A-Za-z][A-Za-z .'-]{3,79}$")      # banks need at least 4 characters


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
