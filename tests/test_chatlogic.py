"""Unit tests for backend/chatlogic.py (pure helpers, no AWS)."""

import hashlib
import hmac
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))

import chatlogic as cl  # noqa: E402

SECRET = "app-secret"


def sign(secret, body):
    return "sha256=" + hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()


class VerifySignatureTests(unittest.TestCase):
    BODY = b'{"entry":[{"id":"1"}]}'

    def test_valid_signature_accepted(self):
        self.assertTrue(cl.verify_signature(SECRET, self.BODY, sign(SECRET, self.BODY)))

    def test_uppercase_hex_accepted(self):
        hexpart = sign(SECRET, self.BODY)[len("sha256="):].upper()
        self.assertTrue(cl.verify_signature(SECRET, self.BODY, "sha256=" + hexpart))

    def test_wrong_secret_rejected(self):
        self.assertFalse(cl.verify_signature(SECRET, self.BODY, sign("other-secret", self.BODY)))

    def test_empty_secret_rejected(self):
        self.assertFalse(cl.verify_signature("", self.BODY, sign("", self.BODY)))

    def test_missing_header_rejected(self):
        self.assertFalse(cl.verify_signature(SECRET, self.BODY, None))
        self.assertFalse(cl.verify_signature(SECRET, self.BODY, ""))

    def test_header_without_sha256_prefix_rejected(self):
        hexonly = sign(SECRET, self.BODY)[len("sha256="):]
        self.assertFalse(cl.verify_signature(SECRET, self.BODY, hexonly))

    def test_tampered_body_rejected(self):
        sig = sign(SECRET, self.BODY)
        self.assertFalse(cl.verify_signature(SECRET, self.BODY + b" ", sig))
        self.assertFalse(cl.verify_signature(SECRET, self.BODY.replace(b"1", b"2"), sig))

    def test_non_ascii_header_returns_false_not_raise(self):
        self.assertFalse(cl.verify_signature(SECRET, self.BODY, "sha256=é"))

    def test_str_body_rejected(self):
        # Signature must be computed over raw bytes; a str body is refused outright.
        self.assertFalse(cl.verify_signature(SECRET, self.BODY.decode(), sign(SECRET, self.BODY)))


class NormalizePhoneTests(unittest.TestCase):
    def test_spaces_and_plus_removed(self):
        self.assertEqual(cl.normalize_phone("+91 98765 43210"), "919876543210")

    def test_already_digits_unchanged(self):
        self.assertEqual(cl.normalize_phone("919876543210"), "919876543210")

    def test_none_and_empty(self):
        self.assertEqual(cl.normalize_phone(None), "")
        self.assertEqual(cl.normalize_phone(""), "")


class ParseCommandTests(unittest.TestCase):
    def test_simple_commands(self):
        for cmd in ("ACCEPT", "CLOSE", "STATUS", "HELP"):
            with self.subTest(cmd=cmd):
                p = cl.parse_command(cmd)
                self.assertEqual(p["cmd"], cmd)
                self.assertIsNone(p["n"])
                self.assertIsNone(p["code"])

    def test_numeric_commands(self):
        for cmd in ("HANDOFF", "RECEIVED", "DISTRIBUTED", "RETURNED", "DISPOSED"):
            with self.subTest(cmd=cmd):
                p = cl.parse_command(cmd + " 8")
                self.assertEqual(p["cmd"], cmd)
                self.assertEqual(p["n"], 8)

    def test_case_insensitive(self):
        self.assertEqual(cl.parse_command("received 8")["cmd"], "RECEIVED")
        self.assertEqual(cl.parse_command("Distributed 3")["n"], 3)
        self.assertEqual(cl.parse_command("status")["cmd"], "STATUS")

    def test_trailing_colon_stripped(self):
        self.assertEqual(cl.parse_command("STATUS:")["cmd"], "STATUS")

    def test_code_command(self):
        p = cl.parse_command("CODE 123456")
        self.assertEqual(p["cmd"], "CODE")
        self.assertEqual(p["code"], "123456")

    def test_code_command_lowercase(self):
        self.assertEqual(cl.parse_command("code 123456")["code"], "123456")

    def test_code_must_be_six_digits(self):
        for bad in ("CODE 12345", "CODE 1234567", "CODE abcdef", "CODE"):
            with self.subTest(bad=bad):
                self.assertIn("error", cl.parse_command(bad))

    def test_received_takes_code(self):
        p = cl.parse_command("RECEIVED 8 CODE 123456")
        self.assertEqual(p["cmd"], "RECEIVED")
        self.assertEqual(p["n"], 8)
        self.assertEqual(p["code"], "123456")

    def test_code_command_rejects_extra_words(self):
        self.assertIn("error", cl.parse_command("CODE 123456 extra"))

    def test_received_code_must_be_six_digits(self):
        self.assertIn("error", cl.parse_command("RECEIVED 8 CODE 12345"))

    def test_received_code_without_number_rejected(self):
        self.assertIn("error", cl.parse_command("RECEIVED CODE 123456"))

    def test_only_received_takes_code(self):
        for text in ("DISTRIBUTED 3 CODE 123456", "HANDOFF 5 CODE 123456",
                     "RETURNED 2 CODE 123456", "DISPOSED 1 CODE 123456", "ACCEPT CODE 123456"):
            with self.subTest(text=text):
                self.assertEqual(cl.parse_command(text)["error"], "only RECEIVED takes a 6-digit CODE")

    def test_lot_prefix_parsed_and_lowercased(self):
        self.assertEqual(cl.parse_command("RECEIVED 8 #ABC123")["lot"], "abc123")
        self.assertEqual(cl.parse_command("STATUS #abc123")["lot"], "abc123")
        self.assertEqual(cl.parse_command("HANDOFF #abc 5")["n"], 5)

    def test_lot_with_received_code(self):
        p = cl.parse_command("RECEIVED 8 #abc123 CODE 654321")
        self.assertEqual((p["n"], p["lot"], p["code"]), (8, "abc123", "654321"))

    def test_extra_words_rejected_for_simple_commands(self):
        self.assertIn("error", cl.parse_command("STATUS now"))
        self.assertIn("error", cl.parse_command("ACCEPT please"))

    def test_extra_words_rejected_for_numeric_commands(self):
        self.assertIn("error", cl.parse_command("RECEIVED 8 extra"))
        self.assertIn("error", cl.parse_command("DISTRIBUTED"))
        self.assertIn("error", cl.parse_command("DISTRIBUTED abc"))
        self.assertIn("error", cl.parse_command("DISTRIBUTED -1"))
        self.assertIn("error", cl.parse_command("DISTRIBUTED 1234567"))

    def test_unknown_and_empty(self):
        self.assertEqual(cl.parse_command("FOO")["error"], "unknown command")
        self.assertEqual(cl.parse_command("")["error"], "empty")
        self.assertEqual(cl.parse_command("   ")["error"], "empty")
        self.assertEqual(cl.parse_command(None)["error"], "empty")

    def test_never_raises(self):
        weird = [None, 0, 123, b"bytes", "CODE", "#", "#  ", "RECEIVED CODE", "RECEIVED CODE CODE",
                 "\x00\x01", "CODE " * 50, "RECEIVED " + "9" * 500, "🙂 🙂", "CODE\n123456"]
        for text in weird:
            with self.subTest(text=text):
                p = cl.parse_command(text)
                self.assertIsInstance(p, dict)
                self.assertTrue("error" in p or "cmd" in p)


class PickLotTests(unittest.TestCase):
    def setUp(self):
        self.lots = [
            {"lot_id": "lot-abc123", "stage": "OFFERED", "created_epoch": 100},
            {"lot_id": "lot-abd999", "stage": "RECEIVED", "created_epoch": 200},
            {"lot_id": "lot-fff000", "stage": "ACCOUNTED_FOR", "created_epoch": 300},
        ]

    def test_explicit_prefix_selects_lot(self):
        self.assertEqual(cl.pick_lot(self.lots, "abc")["lot_id"], "lot-abc123")
        self.assertEqual(cl.pick_lot(self.lots, "abd9")["lot_id"], "lot-abd999")

    def test_ambiguous_prefix_returns_none(self):
        self.assertIsNone(cl.pick_lot(self.lots, "ab"))

    def test_unknown_prefix_returns_none(self):
        self.assertIsNone(cl.pick_lot(self.lots, "zzz"))

    def test_default_is_newest_open_lot(self):
        # lot-fff000 is newest but ACCOUNTED_FOR, so lot-abd999 (created 200) wins.
        self.assertEqual(cl.pick_lot(self.lots)["lot_id"], "lot-abd999")

    def test_none_open_returns_none(self):
        done = [{"lot_id": "lot-x", "stage": "ACCOUNTED_FOR", "created_epoch": 1}]
        self.assertIsNone(cl.pick_lot(done))
        self.assertIsNone(cl.pick_lot([]))


class RouteForTests(unittest.TestCase):
    LOT = "lot-abc123"
    BASE = "/lots/lot-abc123"

    def test_status_is_get(self):
        self.assertEqual(cl.route_for("STATUS", self.LOT, None, None), ("GET", self.BASE, {}))

    def test_accept_and_close(self):
        self.assertEqual(cl.route_for("ACCEPT", self.LOT, None, None), ("POST", self.BASE + "/accept", {}))
        self.assertEqual(cl.route_for("CLOSE", self.LOT, None, None), ("POST", self.BASE + "/close", {}))

    def test_handoff(self):
        self.assertEqual(cl.route_for("HANDOFF", self.LOT, 5, None),
                         ("POST", self.BASE + "/handoff", {"donor_handoff": 5}))

    def test_received_without_and_with_code(self):
        self.assertEqual(cl.route_for("RECEIVED", self.LOT, 8, None),
                         ("POST", self.BASE + "/receipt", {"received": 8}))
        self.assertEqual(cl.route_for("RECEIVED", self.LOT, 8, "123456"),
                         ("POST", self.BASE + "/receipt", {"received": 8, "pickup_code": "123456"}))

    def test_distributed(self):
        self.assertEqual(cl.route_for("DISTRIBUTED", self.LOT, 3, None),
                         ("POST", self.BASE + "/distribution", {"distributed": 3}))

    def test_returned_and_disposed_share_disposition(self):
        self.assertEqual(cl.route_for("RETURNED", self.LOT, 2, None),
                         ("POST", self.BASE + "/disposition", {"returned": 2}))
        self.assertEqual(cl.route_for("DISPOSED", self.LOT, 1, None),
                         ("POST", self.BASE + "/disposition", {"disposed": 1}))

    def test_unknown_command_raises(self):
        with self.assertRaises(ValueError):
            cl.route_for("NOPE", self.LOT, None, None)


class IsGoRouteTests(unittest.TestCase):
    def test_go_routes(self):
        self.assertTrue(cl.is_go_route("/lots/lot-1/disposition"))
        self.assertTrue(cl.is_go_route("/lots/lot-1/resolve-dispute"))
        self.assertTrue(cl.is_go_route("/lots"))

    def test_python_routes(self):
        for path in ("/lots/lot-1", "/lots/lot-1/accept", "/lots/lot-1/receipt",
                     "/lots/lot-1/distribution", "/lots/lot-1/handoff", "/lots/lot-1/close"):
            with self.subTest(path=path):
                self.assertFalse(cl.is_go_route(path))


class ReplyForTests(unittest.TestCase):
    def test_403_mentions_verified_permissions_and_nothing_changed(self):
        msg = cl.reply_for(403, {"action": "DistributeLot", "error": "VP_DENY"}, "DISTRIBUTED")
        self.assertIn("Verified Permissions", msg)
        self.assertIn("Nothing changed", msg)
        self.assertIn("DistributeLot", msg)

    def test_403_falls_back_to_command_and_includes_request_id(self):
        msg = cl.reply_for(403, {"request_id": "req-9"}, "RETURNED")
        self.assertIn("RETURNED", msg)
        self.assertIn("req-9", msg)
        self.assertIn("Nothing changed", msg)

    def test_handoff_reply_includes_pickup_code(self):
        msg = cl.reply_for(200, {"action": "DeclareHandoff", "stage": "HANDED_OVER", "pickup_code": "123456"}, "HANDOFF")
        self.assertIn("Pickup code: 123456", msg)
        self.assertIn("Now HANDED_OVER", msg)

    def test_success_flags(self):
        msg = cl.reply_for(200, {"action": "RecordReceipt", "stage": "RECEIVED", "count_dispute": True,
                                 "confirmed_in_person": True}, "RECEIVED")
        self.assertIn("Counts disagree", msg)
        self.assertIn("Confirmed in person", msg)

    def test_201_treated_as_success(self):
        self.assertTrue(cl.reply_for(201, {"action": "CreateLot", "stage": "OFFERED"}, "ADD").startswith("Done"))

    def test_409_includes_attempts_left(self):
        msg = cl.reply_for(409, {"error": "stale version", "attempts_left": 2}, "RECEIVED")
        self.assertIn("Not done", msg)
        self.assertIn("stale version", msg)
        self.assertIn("attempts left: 2", msg)

    def test_409_zero_attempts_still_shown(self):
        self.assertIn("attempts left: 0", cl.reply_for(409, {"error": "x", "attempts_left": 0}, "RECEIVED"))

    def test_409_without_attempts(self):
        msg = cl.reply_for(409, {"error": "already done"}, "CLOSE")
        self.assertEqual(msg, "Not done: already done")

    def test_400_and_other_status(self):
        self.assertEqual(cl.reply_for(400, {"error": "bad qty"}, "HANDOFF"), "Not done: bad qty")
        self.assertIn("Something went wrong (500)", cl.reply_for(500, None, "HANDOFF"))

    def test_status_reply_lists_counts(self):
        body = {"lot": {"lot_id": "lot-abc123", "stage": "OFFERED", "offered": 10, "remaining": 10}}
        msg = cl.reply_for(200, body, "STATUS")
        self.assertIn("Lot #abc123: OFFERED", msg)
        self.assertIn("offered 10", msg)
        self.assertIn("remaining 10", msg)


if __name__ == "__main__":
    unittest.main()
