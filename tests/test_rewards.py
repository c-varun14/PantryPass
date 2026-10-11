"""Unit tests for backend/rewards.py (trust points), built on hash-chained lot events.

Chains are built the same way tests/test_trust.py builds them: each event's hash is
trust.event_hash(prev_hash, lot_id, event_id, actor, action, decision, result, ts).
"""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend")))

import rewards  # noqa: E402
import trust  # noqa: E402

LOT = "lot-1"
DONOR = "sub-donor"
RECEIVER = "sub-receiver"
COORD = "sub-coord"
OTHER_COORD = "sub-coord-2"
STRANGER = "sub-stranger"
DEADLINE = 5000


def step(action, actor, result=None, ts=None, decision="ALLOW", hashed=True):
    """One event to add to a lot's chain. result may be a dict (dumped to JSON) or a raw string."""
    return {"action": action, "actor": actor, "result": {} if result is None else result,
            "ts": ts, "decision": decision, "hashed": hashed}


def accept(ts=2000, actor=RECEIVER):
    return step("Accept", actor, {"action": "Accept", "stage": "ACCEPTED"}, ts)


def receipt(in_person=True, dispute=False, ts=3000, actor=RECEIVER, **quantities):
    res = {"received": 10, "count_dispute": dispute, "confirmed_in_person": in_person}
    res.update(quantities)
    return step("Receipt", actor, res, ts)


def close(ts=4000, actor=RECEIVER):
    return step("Close", actor, {"action": "Close", "stage": "ACCOUNTED_FOR"}, ts)


def resolve(actor=COORD, ts=None):
    return step("ResolveDispute", actor, {"action": "ResolveDispute"}, ts)


def handoff(actor=DONOR, ts=None):
    return step("DeclareHandoff", actor, {"action": "DeclareHandoff"}, ts)


def happy_steps():
    """Donor creates and declares, receiver accepts on time, confirms in person, counts match, closes."""
    return [step("CreateLot", DONOR, {"action": "CreateLot"}, 1000), handoff(DONOR, 1001),
            accept(), receipt(), close()]


def make_lot(steps=(), lot_id=LOT, stage="ACCOUNTED_FOR", donor=DONOR, receiver=RECEIVER,
             deadline=DEADLINE, extra_events=()):
    """Build (lot_record, events) from steps. Steps with hashed=False become legacy events.

    Returns the lot dict the way the caller would pass it to compute_rewards, plus its event list.
    extra_events are appended as-is (for DENY rows or hand-written events).
    """
    events, prev, chained = [], trust.GENESIS, 0
    for i, s in enumerate(steps, 1):
        ts = s["ts"] if s["ts"] is not None else 1000 + i
        raw = s["result"] if isinstance(s["result"], str) else json.dumps(s["result"])
        e = {"lot_id": lot_id, "event_id": "%012d#ab" % i, "actor": s["actor"], "action": s["action"],
             "decision": s["decision"], "result": raw, "ts": ts}
        if s["hashed"]:
            e["prev_hash"] = prev
            e["hash"] = trust.event_hash(prev, lot_id, e["event_id"], e["actor"], e["action"],
                                         e["decision"], raw, ts)
            prev = e["hash"]
            chained += 1
        events.append(e)
    events.extend(extra_events)
    lot = {"lot_id": lot_id, "chain_head": prev, "chain_len": chained, "stage": stage,
           "donor_sub": donor, "receiver_sub": receiver, "response_deadline_epoch": deadline}
    return lot, events


def happy_lot(lot_id=LOT, **kw):
    return make_lot(happy_steps(), lot_id=lot_id, **kw)


def rewards_for(sub, role, lots_and_events, community=0):
    lots = [lot for lot, _ in lots_and_events]
    by_lot = {lot["lot_id"]: events for lot, events in lots_and_events}
    return rewards.compute_rewards(sub, role, lots, by_lot, community)


def badge(out, bid):
    return next(b for b in out["badges"] if b["id"] == bid)


def reasons(out):
    return sorted(x["reason"] for x in out["ledger"])


def hashes_for(events, action):
    return {e["hash"] for e in events if e.get("action") == action and e.get("hash")}


class ReceiverHappyPathTest(unittest.TestCase):
    def setUp(self):
        self.lot, self.events = happy_lot()
        self.out = rewards_for(RECEIVER, "receiver", [(self.lot, self.events)])

    def test_receiver_earns_23(self):
        self.assertEqual(self.out["points"], 3 + 5 + 5 + 10)
        self.assertEqual(self.out["points"], 23)

    def test_ledger_entries_and_points(self):
        self.assertEqual(reasons(self.out), sorted([
            "Accepted before the deadline",
            "Receipt confirmed in person",
            "Count matched the donor's",
            "Lot closed as accounted for",
        ]))
        self.assertEqual(sum(x["points"] for x in self.out["ledger"]), 23)

    def test_ledger_names_the_right_event_hashes(self):
        by_reason = {x["reason"]: x for x in self.out["ledger"]}
        accept_hash = hashes_for(self.events, "Accept").pop()
        receipt_hash = hashes_for(self.events, "Receipt").pop()
        close_hash = hashes_for(self.events, "Close").pop()
        self.assertEqual(by_reason["Accepted before the deadline"]["event_hash"], accept_hash)
        self.assertEqual(by_reason["Receipt confirmed in person"]["event_hash"], receipt_hash)
        self.assertEqual(by_reason["Count matched the donor's"]["event_hash"], receipt_hash)
        self.assertEqual(by_reason["Lot closed as accounted for"]["event_hash"], close_hash)
        for x in self.out["ledger"]:
            self.assertEqual(x["lot_id"], LOT)

    def test_ledger_hashes_exist_in_the_chain(self):
        chain_hashes = {e["hash"] for e in self.events if e.get("hash")}
        for x in self.out["ledger"]:
            self.assertIn(x["event_hash"], chain_hashes)

    def test_receiver_23_points_is_helper(self):
        self.assertEqual(self.out["level"], "Helper")
        self.assertEqual(self.out["next_level"], "Steward")
        self.assertEqual(self.out["next_level_at"], 60)


class DonorHappyPathTest(unittest.TestCase):
    def setUp(self):
        self.lot, self.events = happy_lot()
        self.out = rewards_for(DONOR, "donor", [(self.lot, self.events)])

    def test_donor_earns_15(self):
        self.assertEqual(self.out["points"], 10 + 5)

    def test_donor_ledger_names_close_and_receipt_hashes(self):
        by_reason = {x["reason"]: x["event_hash"] for x in self.out["ledger"]}
        self.assertEqual(set(by_reason), {"Lot accounted for with matching counts",
                                          "Handoff confirmed in person"})
        self.assertEqual(by_reason["Lot accounted for with matching counts"],
                         hashes_for(self.events, "Close").pop())
        self.assertEqual(by_reason["Handoff confirmed in person"],
                         hashes_for(self.events, "Receipt").pop())

    def test_donor_is_not_given_receiver_points(self):
        reasons_set = set(reasons(self.out))
        self.assertNotIn("Accepted before the deadline", reasons_set)
        self.assertNotIn("Lot closed as accounted for", reasons_set)


class DeadlineTest(unittest.TestCase):
    def test_accept_after_deadline_earns_no_on_time_points(self):
        steps = happy_steps()
        steps[2] = accept(ts=DEADLINE + 1)
        lot, events = make_lot(steps)
        out = rewards_for(RECEIVER, "receiver", [(lot, events)])
        self.assertEqual(out["points"], 5 + 5 + 10)
        self.assertNotIn("Accepted before the deadline", reasons(out))
        self.assertEqual(badge(out, "quick_responder")["progress"], 0)

    def test_accept_exactly_at_deadline_counts(self):
        steps = happy_steps()
        steps[2] = accept(ts=DEADLINE)
        lot, events = make_lot(steps)
        out = rewards_for(RECEIVER, "receiver", [(lot, events)])
        self.assertEqual(out["points"], 23)

    def test_no_deadline_on_lot_earns_no_on_time_points(self):
        lot, events = make_lot(happy_steps(), deadline=None)
        out = rewards_for(RECEIVER, "receiver", [(lot, events)])
        self.assertEqual(out["points"], 20)


class ReceiptAndCodeTest(unittest.TestCase):
    def test_receipt_without_code_earns_no_in_person_points(self):
        steps = happy_steps()
        steps[3] = receipt(in_person=False)
        lot, events = make_lot(steps)
        recv = rewards_for(RECEIVER, "receiver", [(lot, events)])
        self.assertNotIn("Receipt confirmed in person", reasons(recv))
        self.assertEqual(recv["points"], 3 + 5 + 10)
        donor = rewards_for(DONOR, "donor", [(lot, events)])
        self.assertNotIn("Handoff confirmed in person", reasons(donor))
        self.assertEqual(donor["points"], 10)

    def test_missing_confirmed_flag_earns_no_in_person_points(self):
        steps = happy_steps()
        steps[3] = step("Receipt", RECEIVER, {"count_dispute": False, "received": 10}, 3000)
        lot, events = make_lot(steps)
        recv = rewards_for(RECEIVER, "receiver", [(lot, events)])
        self.assertNotIn("Receipt confirmed in person", reasons(recv))
        self.assertEqual(recv["points"], 3 + 5 + 10)

    def test_malformed_receipt_result_is_treated_as_empty(self):
        steps = happy_steps()
        steps[3] = step("Receipt", RECEIVER, "not json", 3000)
        lot, events = make_lot(steps)
        recv = rewards_for(RECEIVER, "receiver", [(lot, events)])
        self.assertEqual(recv["points"], 3 + 10)
        donor = rewards_for(DONOR, "donor", [(lot, events)])
        self.assertEqual(donor["points"], 0)

    def test_receipt_with_count_dispute_earns_no_matched_points(self):
        steps = happy_steps()
        steps[3] = receipt(dispute=True)
        lot, events = make_lot(steps)
        recv = rewards_for(RECEIVER, "receiver", [(lot, events)])
        self.assertNotIn("Count matched the donor's", reasons(recv))
        self.assertEqual(recv["points"], 3 + 5 + 10)

    def test_dispute_means_donor_gets_no_accounted_for_points(self):
        steps = happy_steps()
        steps[3] = receipt(dispute=True)
        lot, events = make_lot(steps)
        donor = rewards_for(DONOR, "donor", [(lot, events)])
        self.assertNotIn("Lot accounted for with matching counts", reasons(donor))
        self.assertEqual(donor["points"], 5)
        self.assertEqual(badge(donor, "first_clean_handoff")["earned"], False)

    def test_receipt_without_dispute_key_is_not_a_match(self):
        steps = happy_steps()
        steps[3] = step("Receipt", RECEIVER, {"confirmed_in_person": True}, 3000)
        lot, events = make_lot(steps)
        recv = rewards_for(RECEIVER, "receiver", [(lot, events)])
        self.assertNotIn("Count matched the donor's", reasons(recv))


class ChainIntegrityTest(unittest.TestCase):
    def test_tampered_event_result_earns_nothing(self):
        lot, events = happy_lot()
        receipt_event = next(e for e in events if e["action"] == "Receipt")
        receipt_event["result"] = json.dumps({"count_dispute": False, "confirmed_in_person": True,
                                              "received": 999})
        self.assertEqual(rewards_for(RECEIVER, "receiver", [(lot, events)])["points"], 0)
        self.assertEqual(rewards_for(DONOR, "donor", [(lot, events)])["points"], 0)

    def test_removed_event_earns_nothing(self):
        lot, events = happy_lot()
        out = rewards_for(RECEIVER, "receiver", [(lot, events[:-1])])
        self.assertEqual(out["points"], 0)
        self.assertEqual(out["ledger"], [])

    def test_tampered_lot_head_earns_nothing(self):
        lot, events = happy_lot()
        lot["chain_head"] = "f" * 64
        self.assertEqual(rewards_for(RECEIVER, "receiver", [(lot, events)])["points"], 0)

    def test_one_tampered_lot_does_not_hide_a_good_lot(self):
        bad_lot, bad_events = happy_lot(lot_id="lot-bad")
        bad_events[0]["result"] = json.dumps({"forged": True})
        good_lot, good_events = happy_lot(lot_id="lot-good")
        out = rewards_for(RECEIVER, "receiver", [(bad_lot, bad_events), (good_lot, good_events)])
        self.assertEqual(out["points"], 23)
        self.assertTrue(all(x["lot_id"] == "lot-good" for x in out["ledger"]))

    def test_empty_lot_earns_nothing(self):
        lot, events = make_lot([])
        self.assertEqual(events, [])
        out = rewards_for(RECEIVER, "receiver", [(lot, events)])
        self.assertEqual(out["points"], 0)
        self.assertEqual(out["ledger"], [])

    def test_lot_with_no_events_entry_earns_nothing(self):
        lot, _ = happy_lot()
        out = rewards.compute_rewards(RECEIVER, "receiver", [lot], {})
        self.assertEqual(out["points"], 0)

    def test_same_donor_and_receiver_earns_nothing(self):
        lot, events = happy_lot(donor=RECEIVER)
        self.assertEqual(rewards_for(RECEIVER, "receiver", [(lot, events)])["points"], 0)
        self.assertEqual(rewards_for(RECEIVER, "donor", [(lot, events)])["points"], 0)
        self.assertEqual(rewards_for(RECEIVER, "receiver", [(lot, events)])["ledger"], [])

    def test_same_donor_and_receiver_with_coordinator_resolve_earns_nothing(self):
        steps = happy_steps()[:3] + [receipt(dispute=True), resolve(actor=RECEIVER)]
        lot, events = make_lot(steps, stage="RECEIVED", donor=RECEIVER)
        self.assertEqual(rewards_for(RECEIVER, "coordinator", [(lot, events)])["points"], 0)


class CoordinatorTest(unittest.TestCase):
    def setUp(self):
        steps = happy_steps()[:3] + [receipt(dispute=True), resolve(COORD), resolve(COORD),
                                     resolve(OTHER_COORD)]
        self.lot, self.events = make_lot(steps, stage="RECEIVED")

    def test_each_resolve_by_this_coordinator_is_plus_3(self):
        out = rewards_for(COORD, "coordinator", [(self.lot, self.events)])
        self.assertEqual(out["points"], 6)
        self.assertEqual([x["reason"] for x in out["ledger"]],
                         ["Resolved a count dispute", "Resolved a count dispute"])
        self.assertEqual(sorted(x["event_hash"] for x in out["ledger"]),
                         sorted(hashes_for(self.events, "ResolveDispute") -
                                {next(e["hash"] for e in self.events
                                      if e["action"] == "ResolveDispute" and e["actor"] == OTHER_COORD)}))

    def test_other_coordinators_resolves_are_not_credited(self):
        out = rewards_for(OTHER_COORD, "coordinator", [(self.lot, self.events)])
        self.assertEqual(out["points"], 3)
        other_hash = next(e["hash"] for e in self.events
                          if e["action"] == "ResolveDispute" and e["actor"] == OTHER_COORD)
        self.assertEqual([x["event_hash"] for x in out["ledger"]], [other_hash])

    def test_resolve_only_counts_for_coordinator_role(self):
        out = rewards_for(COORD, "receiver", [(self.lot, self.events)])
        self.assertEqual(out["points"], 0)

    def test_coordinator_points_are_not_deducted_for_unresolved_lots(self):
        out = rewards_for(COORD, "coordinator", [(self.lot, self.events)])
        self.assertGreaterEqual(out["points"], 0)


class NoNegativeAndQuantityTest(unittest.TestCase):
    def test_points_do_not_depend_on_quantities(self):
        small_steps = happy_steps()
        small_steps[3] = receipt(received=1, offered=1, distributed=0, returned=0, disposed=0, remaining=1)
        big_steps = happy_steps()
        big_steps[3] = receipt(received=500, offered=999, distributed=400, returned=50, disposed=49,
                               remaining=1)
        small_lot, small_events = make_lot(small_steps)
        big_lot, big_events = make_lot(big_steps)
        for sub, role in [(RECEIVER, "receiver"), (DONOR, "donor")]:
            a = rewards_for(sub, role, [(small_lot, small_events)])
            b = rewards_for(sub, role, [(big_lot, big_events)])
            self.assertEqual(a["points"], b["points"])
            self.assertEqual([x["points"] for x in a["ledger"]], [x["points"] for x in b["ledger"]])
        self.assertEqual(rewards_for(RECEIVER, "receiver", [(big_lot, big_events)])["points"], 23)

    def test_negative_or_zero_quantities_do_not_change_points(self):
        steps = happy_steps()
        steps[3] = receipt(received=-5, remaining=-5)
        lot, events = make_lot(steps)
        self.assertEqual(rewards_for(RECEIVER, "receiver", [(lot, events)])["points"], 23)

    def test_points_are_never_negative(self):
        scenarios = [
            make_lot([]),
            make_lot(happy_steps()[:2]),
            happy_lot(),
            make_lot(happy_steps()[:3] + [receipt(dispute=True)]),
        ]
        for lot, events in scenarios:
            for sub, role in [(RECEIVER, "receiver"), (DONOR, "donor"), (COORD, "coordinator"),
                              (STRANGER, "")]:
                self.assertGreaterEqual(rewards_for(sub, role, [(lot, events)])["points"], 0)


class IgnoredEventsTest(unittest.TestCase):
    def test_deny_event_is_ignored(self):
        lot, events = happy_lot(extra_events=[
            {"lot_id": LOT, "event_id": "000000000099#dd", "actor": RECEIVER, "action": "Accept",
             "decision": "DENY", "source": "VerifiedPermissions", "ts": 1500},
        ])
        out = rewards_for(RECEIVER, "receiver", [(lot, events)])
        self.assertEqual(out["points"], 23)
        self.assertNotIn("DENY", json.dumps(out["ledger"]))

    def test_chained_deny_event_is_ignored(self):
        steps = happy_steps()
        steps.insert(2, step("Accept", RECEIVER, {"action": "Accept"}, 1900, decision="DENY"))
        lot, events = make_lot(steps)
        out = rewards_for(RECEIVER, "receiver", [(lot, events)])
        self.assertEqual(out["points"], 23)
        deny_hash = next(e["hash"] for e in events if e["decision"] == "DENY")
        self.assertNotIn(deny_hash, [x["event_hash"] for x in out["ledger"]])

    def test_event_without_hash_is_ignored(self):
        steps = [step("CreateLot", DONOR, {}, 1000), handoff(DONOR, 1001),
                 step("Accept", RECEIVER, {"action": "Accept"}, 2000, hashed=False),
                 receipt(), close()]
        lot, events = make_lot(steps)
        out = rewards_for(RECEIVER, "receiver", [(lot, events)])
        self.assertEqual(out["points"], 5 + 5 + 10)
        self.assertNotIn("Accepted before the deadline", reasons(out))

    def test_legacy_unhashed_close_and_receipt_are_ignored(self):
        steps = happy_steps()[:3] + [
            step("Receipt", RECEIVER, {"count_dispute": False, "confirmed_in_person": True}, 3000,
                 hashed=False),
            step("Close", RECEIVER, {}, 4000, hashed=False),
        ]
        lot, events = make_lot(steps)
        out = rewards_for(RECEIVER, "receiver", [(lot, events)])
        self.assertEqual(out["points"], 3)

    def test_unhashed_events_do_not_break_the_chain(self):
        lot, events = happy_lot(extra_events=[
            {"lot_id": LOT, "event_id": "000000000000#aa", "actor": DONOR, "action": "CreateLot",
             "decision": "ALLOW", "ts": 900, "result": "{}"},
        ])
        self.assertEqual(rewards_for(RECEIVER, "receiver", [(lot, events)])["points"], 23)


class LevelTest(unittest.TestCase):
    def test_level_boundaries(self):
        self.assertEqual(rewards.level_for(0), ("Seedling", "Helper", 20))
        self.assertEqual(rewards.level_for(19), ("Seedling", "Helper", 20))
        self.assertEqual(rewards.level_for(20), ("Helper", "Steward", 60))
        self.assertEqual(rewards.level_for(59), ("Helper", "Steward", 60))
        self.assertEqual(rewards.level_for(60), ("Steward", None, None))
        self.assertEqual(rewards.level_for(500), ("Steward", None, None))

    def test_level_reported_by_compute_rewards(self):
        donor = rewards_for(DONOR, "donor", [happy_lot()])
        self.assertEqual(donor["points"], 15)
        self.assertEqual((donor["level"], donor["next_level"], donor["next_level_at"]),
                         ("Seedling", "Helper", 20))
        one = rewards_for(RECEIVER, "receiver", [happy_lot()])
        self.assertEqual((one["level"], one["next_level"], one["next_level_at"]),
                         ("Helper", "Steward", 60))
        two = rewards_for(RECEIVER, "receiver", [happy_lot("lot-a"), happy_lot("lot-b")])
        self.assertEqual(two["points"], 46)
        self.assertEqual((two["level"], two["next_level"], two["next_level_at"]),
                         ("Helper", "Steward", 60))
        three = rewards_for(RECEIVER, "receiver", [happy_lot("lot-a"), happy_lot("lot-b"),
                                                   happy_lot("lot-c")])
        self.assertEqual(three["points"], 69)
        self.assertEqual((three["level"], three["next_level"], three["next_level_at"]),
                         ("Steward", None, None))


class BadgeTest(unittest.TestCase):
    def test_no_lots_means_no_badges_earned(self):
        out = rewards_for(RECEIVER, "receiver", [])
        self.assertEqual([b["id"] for b in out["badges"]],
                         ["first_clean_handoff", "face_to_face", "quick_responder", "closer",
                          "tie_breaker"])
        for b in out["badges"]:
            self.assertFalse(b["earned"])
            self.assertEqual(b["progress"], 0)
            self.assertIn("goal", b)
            self.assertIn("rule", b)
            self.assertIn("name", b)

    def test_badge_goals(self):
        out = rewards_for(RECEIVER, "receiver", [])
        goals = {b["id"]: b["goal"] for b in out["badges"]}
        self.assertEqual(goals, {"first_clean_handoff": 1, "face_to_face": 5, "quick_responder": 3,
                                 "closer": 3, "tie_breaker": 3})

    def test_face_to_face_needs_five_in_person_handoffs_across_lots(self):
        def in_person_lot(i):
            return make_lot([step("CreateLot", DONOR, {}, 1000), accept(ts=2000), receipt()],
                            lot_id="lot-%d" % i, stage="RECEIVED")

        four = rewards_for(RECEIVER, "receiver", [in_person_lot(i) for i in range(4)])
        b = badge(four, "face_to_face")
        self.assertEqual((b["progress"], b["earned"]), (4, False))

        five = rewards_for(RECEIVER, "receiver", [in_person_lot(i) for i in range(5)])
        b = badge(five, "face_to_face")
        self.assertEqual((b["progress"], b["earned"]), (5, True))

        six = rewards_for(RECEIVER, "receiver", [in_person_lot(i) for i in range(6)])
        b = badge(six, "face_to_face")
        self.assertEqual((b["progress"], b["earned"]), (5, True))

    def test_quick_responder_needs_three_on_time_accepts(self):
        def on_time_lot(i):
            return make_lot([accept(ts=2000)], lot_id="lot-%d" % i, stage="ACCEPTED")

        two = rewards_for(RECEIVER, "receiver", [on_time_lot(i) for i in range(2)])
        self.assertEqual((badge(two, "quick_responder")["progress"],
                          badge(two, "quick_responder")["earned"]), (2, False))
        three = rewards_for(RECEIVER, "receiver", [on_time_lot(i) for i in range(3)])
        self.assertEqual((badge(three, "quick_responder")["progress"],
                          badge(three, "quick_responder")["earned"]), (3, True))

    def test_late_accepts_do_not_count_for_quick_responder(self):
        lots = [make_lot([accept(ts=DEADLINE + 10)], lot_id="lot-%d" % i, stage="ACCEPTED")
                for i in range(3)]
        out = rewards_for(RECEIVER, "receiver", lots)
        self.assertEqual(badge(out, "quick_responder")["progress"], 0)
        self.assertFalse(badge(out, "quick_responder")["earned"])

    def test_closer_and_first_clean_handoff_for_receiver(self):
        two = rewards_for(RECEIVER, "receiver", [happy_lot("lot-a"), happy_lot("lot-b")])
        closer = badge(two, "closer")
        self.assertEqual((closer["progress"], closer["earned"]), (2, False))
        self.assertTrue(badge(two, "first_clean_handoff")["earned"])

        three = rewards_for(RECEIVER, "receiver",
                            [happy_lot("lot-a"), happy_lot("lot-b"), happy_lot("lot-c")])
        closer = badge(three, "closer")
        self.assertEqual((closer["progress"], closer["earned"]), (3, True))

    def test_donor_earns_closer_and_first_clean_handoff(self):
        three = rewards_for(DONOR, "donor",
                            [happy_lot("lot-a"), happy_lot("lot-b"), happy_lot("lot-c")])
        self.assertTrue(badge(three, "closer")["earned"])
        self.assertTrue(badge(three, "first_clean_handoff")["earned"])

    def test_first_clean_handoff_needs_one_accounted_lot(self):
        steps = happy_steps()[:4]
        lot, events = make_lot(steps, stage="RECEIVED")
        out = rewards_for(RECEIVER, "receiver", [(lot, events)])
        self.assertFalse(badge(out, "first_clean_handoff")["earned"])
        self.assertEqual(badge(out, "first_clean_handoff")["progress"], 0)

    def test_tie_breaker_needs_three_resolutions(self):
        def resolved_lot(i):
            steps = happy_steps()[:3] + [receipt(dispute=True), resolve(COORD)]
            return make_lot(steps, lot_id="lot-%d" % i, stage="RECEIVED")

        two = rewards_for(COORD, "coordinator", [resolved_lot(i) for i in range(2)])
        self.assertEqual((badge(two, "tie_breaker")["progress"], badge(two, "tie_breaker")["earned"]),
                         (2, False))
        three = rewards_for(COORD, "coordinator", [resolved_lot(i) for i in range(3)])
        self.assertEqual((badge(three, "tie_breaker")["progress"], badge(three, "tie_breaker")["earned"]),
                         (3, True))

    def test_other_coordinators_resolves_do_not_count_towards_tie_breaker(self):
        steps = happy_steps()[:3] + [receipt(dispute=True), resolve(OTHER_COORD),
                                     resolve(OTHER_COORD), resolve(OTHER_COORD)]
        lot, events = make_lot(steps, stage="RECEIVED")
        out = rewards_for(COORD, "coordinator", [(lot, events)])
        self.assertEqual(badge(out, "tie_breaker")["progress"], 0)
        self.assertEqual(out["points"], 0)


class StrangerAndCommunityTest(unittest.TestCase):
    def test_stranger_earns_nothing_on_a_happy_lot(self):
        lot, events = happy_lot()
        for role in ["", "receiver", "donor"]:
            out = rewards_for(STRANGER, role, [(lot, events)])
            self.assertEqual(out["points"], 0)
            self.assertEqual(out["ledger"], [])
            self.assertFalse(any(b["earned"] for b in out["badges"]))
            self.assertTrue(all(b["progress"] == 0 for b in out["badges"]))

    def test_stranger_cannot_claim_actions_taken_by_someone_else(self):
        steps = [step("CreateLot", DONOR, {}, 1000), handoff(DONOR, 1001),
                 accept(actor=STRANGER), receipt(actor=STRANGER), close(actor=STRANGER)]
        lot, events = make_lot(steps)
        out = rewards_for(STRANGER, "receiver", [(lot, events)])
        self.assertEqual(out["points"], 0)

    def test_community_count_passes_through(self):
        out = rewards_for(RECEIVER, "receiver", [], community=12)
        self.assertEqual(out["community"], {"lots_accounted_for": 12})

    def test_community_defaults_to_zero(self):
        out = rewards_for(RECEIVER, "receiver", [])
        self.assertEqual(out["community"], {"lots_accounted_for": 0})

    def test_output_shape(self):
        out = rewards_for(RECEIVER, "receiver", [happy_lot()])
        self.assertEqual(set(out), {"points", "level", "next_level", "next_level_at", "badges",
                                    "ledger", "community"})
        for x in out["ledger"]:
            self.assertEqual(set(x), {"lot_id", "reason", "points", "event_hash"})


if __name__ == "__main__":
    unittest.main()
