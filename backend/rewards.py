"""Trust points: recognition for verified behaviour, derived from lots and their events.

Pure functions, no AWS calls. See docs/api.md ("Rewards"). Rules in one place:
  * only lots whose hash chain verifies earn anything (tampered history earns nothing);
  * a lot where donor and receiver are the same person earns nothing;
  * quantity counts only once verified: the receiver's confirmed count, on a lot whose counts matched and
    that is accounted for, earns a small donor bonus that grows with the log of the quantity and is capped
    per lot, so a huge lot is worth more than a tiny one but cannot be farmed;
  * repeat handoffs between the same donor and receiver earn a shrinking volume bonus;
  * units are never added together; and nothing is ever deducted.
"""

import json
import math
import time

import trust

LEVELS = [("Seedling", 0), ("Helper", 20), ("Steward", 60), ("Champion", 150)]

VOLUME_CAP = 12                    # most volume points one lot can earn
PAIR_FACTORS = (1.0, 0.5, 0.0)     # 1st, 2nd, 3rd+ accounted lot with the same counterparty
WEEK = 7 * 24 * 3600
BIG_MOVER_GOAL = 100               # verified units in one unit of measure
STREAK_GOAL = 3
TOP_MIN_LOTS = 3                   # a "top donor" needs this many verified lots ...
TOP_MIN_PARTNERS = 2               # ... with at least this many different receivers

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


def volume_points(qty):
    """Bonus for a verified quantity: grows with the log of it, capped per lot. 1 -> 2, 10 -> 6, 100+ -> 12."""
    return min(VOLUME_CAP, int(2 * math.log2(1 + max(qty, 0))))


def _verified_quantity(lot, events):
    """The receiver's confirmed count for a lot, or None unless the whole record backs it: the chain
    verifies, donor and receiver differ, the counts matched and the lot is accounted for."""
    verdict = trust.verify_chain(events, lot.get("chain_head"), lot.get("chain_len", 0))
    if not verdict["ok"] or verdict["length"] == 0 or lot.get("stage") != "ACCOUNTED_FOR":
        return None
    donor, receiver = lot.get("donor_sub"), lot.get("receiver_sub")
    if not donor or not receiver or donor == receiver:
        return None
    for e in events:
        if e.get("hash") and e.get("decision") == "ALLOW" and e.get("action") == "Receipt":
            r = _result(e)
            qty = r.get("received")
            if r.get("count_dispute") is False and isinstance(qty, int) and not isinstance(qty, bool) and qty > 0:
                return qty
            return None
    return None


def _streak(weeks, now):
    """Consecutive weeks (ending this week or last week) that each had a verified donation."""
    if not weeks:
        return 0
    cur = int(now // WEEK)
    last = cur if cur in weeks else cur - 1 if (cur - 1) in weeks else None
    if last is None:
        return 0
    n = 0
    while (last - n) in weeks:
        n += 1
    return n


def compute_rewards(sub, role, lots, events_by_lot, community_accounted=0, now=None):
    """lots: plain dicts the caller may earn on; events_by_lot: lot_id -> plain event dicts."""
    ledger, counts = [], {}
    volume, weeks, pair_seen = {}, set(), {}
    for lot in sorted(lots, key=lambda l: l.get("created_epoch") or 0):
        lid = lot.get("lot_id")
        events = events_by_lot.get(lid, [])
        for kind, reason, pts, h in _lot_entries(sub, role, lot, events):
            ledger.append({"lot_id": lid, "reason": reason, "points": pts, "event_hash": h})
            counts[kind] = counts.get(kind, 0) + 1
        if sub != lot.get("donor_sub"):
            continue
        qty = _verified_quantity(lot, events)
        if qty is None:
            continue
        unit = lot.get("unit") or "packets"
        row = volume.setdefault(unit, {"unit": unit, "quantity": 0, "lots": 0})
        row["quantity"] += qty
        row["lots"] += 1
        if lot.get("created_epoch"):
            weeks.add(int(lot["created_epoch"] // WEEK))
        seen = pair_seen.get(lot.get("receiver_sub"), 0)
        pair_seen[lot.get("receiver_sub")] = seen + 1
        pts = int(volume_points(qty) * PAIR_FACTORS[min(seen, len(PAIR_FACTORS) - 1)])
        if pts > 0:
            h = next(e["hash"] for e in events if e.get("action") == "Receipt" and e.get("hash"))
            ledger.append({"lot_id": lid, "reason": "Verified %d %s moved" % (qty, unit), "points": pts, "event_hash": h})
    points = sum(x["points"] for x in ledger)
    level, nxt, nxt_at = level_for(points)
    badges = []
    for bid, name, rule, kind, goal in BADGES:
        have = counts.get(kind, 0)
        badges.append({"id": bid, "name": name, "rule": rule, "earned": have >= goal,
                       "progress": min(have, goal), "goal": goal})
    vol = sorted(volume.values(), key=lambda r: -r["quantity"])
    best = max((r["quantity"] for r in vol), default=0)
    streak = _streak(weeks, now if now is not None else time.time())
    badges.append({"id": "big_mover", "name": "Big mover", "rule": "Move %d verified units in one unit of measure" % BIG_MOVER_GOAL,
                   "earned": best >= BIG_MOVER_GOAL, "progress": min(best, BIG_MOVER_GOAL), "goal": BIG_MOVER_GOAL})
    badges.append({"id": "steady_giver", "name": "Steady giver", "rule": "Verified donations %d weeks in a row" % STREAK_GOAL,
                   "earned": streak >= STREAK_GOAL, "progress": min(streak, STREAK_GOAL), "goal": STREAK_GOAL})
    return {"points": points, "level": level, "next_level": nxt, "next_level_at": nxt_at,
            "badges": badges, "ledger": ledger, "volume": vol, "streak_weeks": streak,
            "verified_lots": sum(r["lots"] for r in vol), "partners": len(pair_seen),
            "community": {"lots_accounted_for": community_accounted}}


def is_top_donor(result, min_lots=TOP_MIN_LOTS, min_partners=TOP_MIN_PARTNERS):
    """True once a donor's verified record is broad enough to be shown publicly and paid out: several verified
    lots, handed to more than one receiver, so one accomplice cannot manufacture the status."""
    return result.get("verified_lots", 0) >= min_lots and result.get("partners", 0) >= min_partners


def compute_fund(points_by_donor, pool_inr, cap_pct):
    """Share a pool among donors in proportion to trust points, never giving one donor more than cap_pct
    of it. Anything over the cap is redistributed to the others. Returns
    {donor: {points, share_pct, estimated_inr, capped}}. A donor with 0 points gets 0."""
    donors = {d: p for d, p in points_by_donor.items() if p > 0}
    out = {d: {"points": int(p), "share_pct": 0.0, "estimated_inr": 0, "capped": False} for d, p in points_by_donor.items()}
    if not donors or pool_inr <= 0:
        return out
    cap = cap_pct / 100.0
    if cap * len(donors) < 1.0:          # too few donors to honour the cap: split what the cap allows
        cap = 1.0 / len(donors)
    share, free, remaining = {}, dict(donors), 1.0
    while free:
        total = sum(free.values())
        over = {d for d, p in free.items() if remaining * p / total > cap + 1e-12}
        if not over:
            for d, p in free.items():
                share[d] = remaining * p / total
            break
        for d in over:
            share[d] = cap
            remaining -= cap
            del free[d]
    for d, f in share.items():
        out[d]["share_pct"] = round(f * 100, 1)
        out[d]["estimated_inr"] = int(round(f * pool_inr))
        out[d]["capped"] = abs(f - cap) < 1e-9 and len(donors) > 1 and cap < 1.0
    return out
