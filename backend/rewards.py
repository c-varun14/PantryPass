"""Trust points: recognition for verified behaviour, derived from lots and their events.

Pure functions, no AWS calls. See docs/api.md ("Rewards"). Rules in one place:
  * only lots whose hash chain verifies earn anything (tampered history earns nothing);
  * a lot where donor and receiver are the same person earns nothing;
  * points never depend on quantity, and nothing is ever deducted.
"""

import json

import trust

LEVELS = [("Seedling", 0), ("Helper", 20), ("Steward", 60)]

BADGES = [
    ("first_clean_handoff", "First clean handoff", "Get a lot accounted for", "accounted", 1),
    ("face_to_face", "Face to face", "Confirm 5 handoffs in person", "in_person", 5),
    ("quick_responder", "Quick responder", "Accept 3 offers before the deadline", "on_time", 3),
    ("closer", "Closer", "Close 3 lots as accounted for", "accounted", 3),
    ("tie_breaker", "Tie-breaker", "Resolve 3 count disputes", "resolved", 3),
]


def _result(event):
    try:
        r = json.loads(event.get("result") or "{}")
        return r if isinstance(r, dict) else {}
    except ValueError:
        return {}


def level_for(points):
    name, idx = LEVELS[0][0], 0
    for i, (n, floor) in enumerate(LEVELS):
        if points >= floor:
            name, idx = n, i
    nxt = LEVELS[idx + 1] if idx + 1 < len(LEVELS) else None
    return name, (nxt[0] if nxt else None), (nxt[1] if nxt else None)


def _lot_entries(sub, role, lot, events):
    """[(kind, reason, points, event_hash)] earned by `sub` on one lot, or [] if untrustworthy."""
    verdict = trust.verify_chain(events, lot.get("chain_head"), lot.get("chain_len", 0))
    if not verdict["ok"] or verdict["length"] == 0:
        return []
    donor, receiver = lot.get("donor_sub"), lot.get("receiver_sub")
    if donor and donor == receiver:
        return []
    chained = [e for e in events if e.get("hash") and e.get("decision") == "ALLOW"]
    by_action = {}
    for e in chained:
        by_action.setdefault(e.get("action"), []).append(e)
    out = []
    accounted = lot.get("stage") == "ACCOUNTED_FOR"
    receipt = (by_action.get("Receipt") or [None])[0]
    rres = _result(receipt) if receipt else {}
    matched = bool(receipt) and rres.get("count_dispute") is False

    if sub == receiver:
        for e in by_action.get("Accept", []):
            if e.get("actor") == sub and lot.get("response_deadline_epoch") is not None \
                    and e.get("ts", 0) <= lot["response_deadline_epoch"]:
                out.append(("on_time", "Accepted before the deadline", 3, e["hash"]))
        if receipt and receipt.get("actor") == sub:
            if rres.get("confirmed_in_person") is True:
                out.append(("in_person", "Receipt confirmed in person", 5, receipt["hash"]))
            if matched:
                out.append(("matched", "Count matched the donor's", 5, receipt["hash"]))
        for e in by_action.get("Close", []):
            if accounted and e.get("actor") == sub:
                out.append(("accounted", "Lot closed as accounted for", 10, e["hash"]))
    if sub == donor:
        if accounted and matched:
            close = (by_action.get("Close") or [receipt])[0]
            out.append(("accounted", "Lot accounted for with matching counts", 10, close["hash"]))
        if receipt and rres.get("confirmed_in_person") is True:
            out.append(("in_person", "Handoff confirmed in person", 5, receipt["hash"]))
    if role == "coordinator":
        for e in by_action.get("ResolveDispute", []):
            if e.get("actor") == sub:
                out.append(("resolved", "Resolved a count dispute", 3, e["hash"]))
    return out


def compute_rewards(sub, role, lots, events_by_lot, community_accounted=0):
    """lots: plain dicts the caller may earn on; events_by_lot: lot_id -> plain event dicts."""
    ledger, counts = [], {}
    for lot in lots:
        lid = lot.get("lot_id")
        for kind, reason, pts, h in _lot_entries(sub, role, lot, events_by_lot.get(lid, [])):
            ledger.append({"lot_id": lid, "reason": reason, "points": pts, "event_hash": h})
            counts[kind] = counts.get(kind, 0) + 1
    points = sum(x["points"] for x in ledger)
    level, nxt, nxt_at = level_for(points)
    badges = []
    for bid, name, rule, kind, goal in BADGES:
        have = counts.get(kind, 0)
        badges.append({"id": bid, "name": name, "rule": rule, "earned": have >= goal,
                       "progress": min(have, goal), "goal": goal})
    return {"points": points, "level": level, "next_level": nxt, "next_level_at": nxt_at,
            "badges": badges, "ledger": ledger, "community": {"lots_accounted_for": community_accounted}}
