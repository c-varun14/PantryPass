"""Unit tests for backend/trust.py (pickup code + hash-chained event helpers)."""

import os
import re
import sys
import unittest

sys.path.insert(0, os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend")))

import trust  # noqa: E402

ACTIONS = ["CreateLot", "Accept", "DeclareHandoff"]


def make_event(prev, lot_id, event_id, action, result, ts, actor="sub-1", decision="ALLOW", **extra):
    """Build an event dict exactly as api.chained_event would store it (after public())."""
    h = trust.event_hash(prev, lot_id, event_id, actor, action, decision, result, ts)
    e = {
        "lot_id": lot_id, "event_id": event_id, "actor": actor, "action": action,
        "decision": decision, "result": result, "ts": ts, "prev_hash": prev, "hash": h,
    }
    e.update(extra)
    return e


def build_chain(lot_id="lot-1", n=3):
    events, prev = [], trust.GENESIS
    for i in range(1, n + 1):
        e = make_event(prev, lot_id, "%012d#ab" % i, ACTIONS[i - 1], '{"n": %d}' % i, 1000 + i)
        events.append(e)
        prev = e["hash"]
    return events


class EventHashTest(unittest.TestCase):
    def test_known_vector(self):
        self.assertEqual(
            trust.event_hash('', 'lot-1', '000000000001#ab', 'sub-1', 'Accept', 'ALLOW', '{"a": 1}', 1),
            'c4cddbcde3d606c1c85327d7bbce578c8da0a175c52eb1cfb256b9ce1b8cf506',
        )


class PickupCodeTest(unittest.TestCase):
    def test_code_is_six_digits(self):
        for _ in range(200):
            code, salt, digest = trust.new_pickup_code()
            self.assertRegex(code, r"^\d{6}$")
            self.assertTrue(salt)
            self.assertEqual(digest, trust.pickup_digest(salt, code))

    def test_right_code_matches(self):
        code, salt, digest = trust.new_pickup_code()
        self.assertTrue(trust.pickup_matches(salt, digest, code))

    def test_surrounding_whitespace_is_tolerated(self):
        code, salt, digest = trust.new_pickup_code()
        self.assertTrue(trust.pickup_matches(salt, digest, "  " + code + " "))

    def test_wrong_code_does_not_match(self):
        code, salt, digest = trust.new_pickup_code()
        other = "000000" if code != "000000" else "000001"
        self.assertFalse(trust.pickup_matches(salt, digest, other))

    def test_empty_none_and_int_do_not_match(self):
        code, salt, digest = trust.new_pickup_code()
        self.assertFalse(trust.pickup_matches(salt, digest, ""))
        self.assertFalse(trust.pickup_matches(salt, digest, None))
        self.assertFalse(trust.pickup_matches(salt, digest, int(code)))

    def test_missing_salt_or_digest_never_matches(self):
        code, salt, digest = trust.new_pickup_code()
        self.assertFalse(trust.pickup_matches("", digest, code))
        self.assertFalse(trust.pickup_matches(salt, "", code))


class VerifyChainTest(unittest.TestCase):
    def test_good_chain_verifies(self):
        events = build_chain()
        out = trust.verify_chain(events, events[-1]["hash"], 3)
        self.assertTrue(out["ok"])
        self.assertEqual(out["length"], 3)
        self.assertEqual(out["head"], events[-1]["hash"])
        self.assertEqual(out["lot_head"], events[-1]["hash"])
        self.assertEqual(out["legacy"], 0)
        self.assertIsNone(out["broken_at"])

    def test_tampered_result_of_middle_event_is_located(self):
        events = build_chain()
        events[1]["result"] = '{"n": 99}'
        out = trust.verify_chain(events, events[-1]["hash"], 3)
        self.assertFalse(out["ok"])
        self.assertEqual(out["broken_at"], events[1]["event_id"])
        self.assertEqual(out["length"], 1)

    def test_removed_last_event_fails_head_check(self):
        events = build_chain()
        out = trust.verify_chain(events[:2], events[2]["hash"], 3)
        self.assertFalse(out["ok"])
        self.assertEqual(out["length"], 2)
        self.assertIn("head", out["reason"])

    def test_removed_middle_event_fails(self):
        events = build_chain()
        out = trust.verify_chain([events[0], events[2]], events[2]["hash"], 3)
        self.assertFalse(out["ok"])
        self.assertEqual(out["length"], 1)
        self.assertIn("not reachable", out["reason"])

    def test_forked_chain_fails(self):
        events = build_chain()
        sibling = make_event(events[0]["hash"], "lot-1", "000000000002#zz", "Accept", '{"n": 9}', 1002)
        out = trust.verify_chain(events + [sibling], events[-1]["hash"], 3)
        self.assertFalse(out["ok"])
        self.assertIn("forks", out["reason"])

    def test_legacy_events_are_counted_and_do_not_break_chain(self):
        events = build_chain()
        legacy = [
            {"lot_id": "lot-1", "event_id": "000000000000#aa", "actor": "sub-0",
             "action": "CreateLot", "decision": "ALLOW", "ts": 900, "result": "{}"},
            {"lot_id": "lot-1", "event_id": "000000000000#bb", "actor": "sub-0",
             "action": "Accept", "decision": "ALLOW", "ts": 901, "result": "{}"},
        ]
        out = trust.verify_chain(legacy + events, events[-1]["hash"], 3)
        self.assertTrue(out["ok"])
        self.assertEqual(out["length"], 3)
        self.assertEqual(out["legacy"], 2)

    def test_deny_and_callback_retried_without_hash_are_not_legacy(self):
        events = build_chain()
        deny = {"lot_id": "lot-1", "event_id": "000000000000#dd", "actor": "sub-9",
                "action": "Accept", "decision": "DENY", "source": "VerifiedPermissions", "ts": 800}
        retried = {"lot_id": "lot-1", "event_id": "000000000000#ee", "actor": "system",
                   "action": "CallbackRetried", "decision": "ALLOW", "ts": 801}
        out = trust.verify_chain([deny, retried] + events, events[-1]["hash"], 3)
        self.assertTrue(out["ok"])
        self.assertEqual(out["legacy"], 0)
        self.assertEqual(out["length"], 3)

    def test_empty_lot_verifies(self):
        out = trust.verify_chain([], "", 0)
        self.assertTrue(out["ok"])
        self.assertEqual(out["length"], 0)
        self.assertEqual(out["head"], "")
        self.assertEqual(out["legacy"], 0)

    def test_events_listed_out_of_order_still_verify(self):
        events = build_chain()
        out = trust.verify_chain(list(reversed(events)), events[-1]["hash"], 3)
        self.assertTrue(out["ok"])
        self.assertEqual(out["length"], 3)
        self.assertEqual(out["head"], events[-1]["hash"])

    def test_lot_length_mismatch_fails(self):
        events = build_chain()
        out = trust.verify_chain(events, events[-1]["hash"], 2)
        self.assertFalse(out["ok"])
        self.assertEqual(out["length"], 3)


if __name__ == "__main__":
    unittest.main()
