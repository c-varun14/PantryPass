"""Pure helpers for the trust record: pickup code and hash-chained events.

No AWS calls here, so everything is unit-testable with the standard library.
See docs/api.md ("Trust record") for the contract.
"""

import hashlib
import hmac
import secrets

GENESIS = ""
MAX_PICKUP_ATTEMPTS = 5


def event_hash(prev_hash, lot_id, event_id, actor, action, decision, result, ts):
    """sha256 over the exact strings stored on the event, newline separated."""
    parts = [prev_hash, lot_id, event_id, actor, action, decision, result, str(ts)]
    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()


def new_pickup_code():
    """Returns (code, salt, digest). Only salt and digest are stored."""
    code = "%06d" % secrets.randbelow(1000000)
    salt = secrets.token_hex(8)
    return code, salt, pickup_digest(salt, code)


def pickup_digest(salt, code):
    return hashlib.sha256((salt + ":" + code).encode("utf-8")).hexdigest()


def pickup_matches(salt, digest, code):
    if not (salt and digest and isinstance(code, str)):
        return False
    return hmac.compare_digest(pickup_digest(salt, code.strip()), digest)


def verify_chain(events, lot_head, lot_len):
    """Walk the chain by prev_hash links and recompute every hash.

    events: plain dicts of one lot's events (IDEM markers already removed).
    Events without a hash are legacy (written before the chain) or outside it
    (DENY, CallbackRetried) and are not part of the walk.
    """
    chained = [e for e in events if e.get("hash")]
    legacy = sum(1 for e in events
                 if not e.get("hash") and e.get("decision") != "DENY"
                 and e.get("action") != "CallbackRetried")
    by_prev = {}
    for e in chained:
        by_prev.setdefault(e.get("prev_hash", ""), []).append(e)

    def out(ok, length, head, broken_at=None, reason=None):
        return {"ok": ok, "length": length, "head": head, "lot_head": lot_head or "",
                "legacy": legacy, "broken_at": broken_at, "reason": reason}

    prev = GENESIS
    length = 0
    seen = set()
    while True:
        nxt = by_prev.get(prev, [])
        if not nxt:
            break
        if len(nxt) > 1:
            return out(False, length, prev, nxt[0].get("event_id"), "chain forks: two events share a predecessor")
        e = nxt[0]
        want = event_hash(prev, e.get("lot_id", ""), e.get("event_id", ""), e.get("actor", ""),
                          e.get("action", ""), e.get("decision", ""), e.get("result", ""), e.get("ts", ""))
        if want != e["hash"] or e["hash"] in seen:
            return out(False, length, prev, e.get("event_id"), "event content does not match its hash")
        seen.add(e["hash"])
        prev = e["hash"]
        length += 1
    if length != len(chained):
        stray = [e for e in chained if e["hash"] not in seen]
        return out(False, length, prev, stray[0].get("event_id"), "event not reachable from the start of the chain")
    if (lot_head or "") != prev or (lot_len or 0) != length:
        return out(False, length, prev, None, "chain head differs from the lot record (event removed or lot edited)")
    return out(True, length, prev)
