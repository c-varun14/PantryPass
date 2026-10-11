"""Direct donations to top donors: validation, Razorpay signatures, simulated mode, settle-once, webhook. No fee."""

import hashlib
import hmac
import json
import unittest
import urllib.error
from unittest import mock

import test_api_trust as T
from test_api_trust import api, ClientError, DONOR, RECV, COORD
from test_payouts import FakePayoutsDDB as DDB, FakeKMS, GOOD
import payments

TOP = "top-1"
STATS = {TOP: {"points": 60, "level": "Steward", "volume": [{"unit": "kg", "quantity": 140, "lots": 4}], "streak_weeks": 2,
               "verified_lots": 4, "partners": 3},
         "rookie": {"points": 10, "level": "Seedling", "volume": [], "streak_weeks": 0, "verified_lots": 1, "partners": 1}}
CFG = {"key_id": "rzp_test_abc", "key_secret": "s3cret", "webhook_secret": "whsec"}


class PureTest(unittest.TestCase):
    def test_validation(self):
        ok, err = payments.clean_donation({"donor_sub": "d", "amount_inr": "500", "note": "Thank you!"})
        self.assertEqual((ok["amount_inr"], err), (500, None))
        for bad in ({"donor_sub": "", "amount_inr": 50}, {"donor_sub": "d", "amount_inr": 9}, {"donor_sub": "d", "amount_inr": 50001},
                    {"donor_sub": "d", "amount_inr": "x"}, {"donor_sub": "d", "amount_inr": 50, "note": "<script>"}):
            self.assertIsNone(payments.clean_donation(bad)[0], bad)

    def test_checkout_signature(self):
        sig = hmac.new(b"s3cret", b"order_1|pay_1", hashlib.sha256).hexdigest()
        self.assertTrue(payments.verify_checkout("order_1", "pay_1", sig, "s3cret"))
        self.assertFalse(payments.verify_checkout("order_1", "pay_2", sig, "s3cret"))
        self.assertFalse(payments.verify_checkout("order_1", "pay_1", "", "s3cret"))
        self.assertFalse(payments.verify_checkout("order_1", "pay_1", sig, ""))

    def test_webhook_signature(self):
        body = b'{"event":"payment.captured"}'
        sig = hmac.new(b"whsec", body, hashlib.sha256).hexdigest()
        self.assertTrue(payments.verify_webhook(body, sig, "whsec"))
        self.assertFalse(payments.verify_webhook(body + b" ", sig, "whsec"))

    def test_create_order_sends_paise_and_basic_auth_and_reports_failures(self):
        seen = {}

        class Resp:
            def __enter__(s): return s
            def __exit__(s, *a): return False
            def read(s): return b'{"id": "order_X", "amount": 50000}'

        def opener(req, timeout):
            seen["req"], seen["body"] = req, json.loads(req.data)
            return Resp()
        order, err = payments.create_order("k", "s", 500, "pp-1", {"a": "b"}, opener)
        self.assertEqual((order["id"], err), ("order_X", None))
        self.assertEqual(seen["body"]["amount"], 50000)
        self.assertTrue(seen["req"].get_header("Authorization").startswith("Basic "))

        def boom(req, timeout):
            raise urllib.error.HTTPError("u", 401, "no", {}, None)
        self.assertEqual(payments.create_order("k", "s", 5, "r", {}, boom), (None, "the payment gateway refused the order (401)"))
        def down(req, timeout):
            raise urllib.error.URLError("down")
        self.assertIn("could not be reached", payments.create_order("k", "s", 5, "r", {}, down)[1])


class DonationRouteTest(unittest.TestCase):
    call = T.TrustApiTest.__dict__["call"]

    def setUp(self):
        self.db, self.logs = DDB(), []
        api._RZP.update(loaded=False, cfg=None)
        for p in (mock.patch.object(api, "ddb", self.db), mock.patch.object(api, "PAYOUTS_TABLE", "payouts"),
                  mock.patch.object(api, "KMS_KEY_ID", "key-1"), mock.patch.object(api, "_KMS", FakeKMS()),
                  mock.patch.object(api, "donor_stats", return_value=STATS),
                  mock.patch.object(api, "log", lambda **k: self.logs.append(k)),
                  mock.patch.dict("os.environ", {}, clear=False)):
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(lambda: api._RZP.update(loaded=False, cfg=None))

    def donate(self, sub=RECV, role="receiver", **over):
        return self.call(api.h_donate(sub, role, dict({"donor_sub": TOP, "amount_inr": 500}, **over), "rq"))

    def use_razorpay(self):
        api._RZP.update(loaded=True, cfg=CFG)
        return mock.patch.object(api.payments, "create_order", return_value=({"id": "order_R1"}, None))

    def test_simulated_mode_without_keys_never_counts_as_owed(self):
        st, o = self.donate()
        self.assertEqual((st, o["mode"], o["amount_inr"], o["kind"]), (200, "demo", 500, "donation"))
        self.assertNotIn("fee_inr", o)
        self.assertNotIn("key_id", o)
        st, done = self.call(api.h_donate_confirm(RECV, "receiver", {"order_id": o["order_id"], "razorpay_payment_id": "pay_demo_1"}, "rq"))
        self.assertEqual((st, done["status"]), (200, "simulated"))
        st, mine = self.call(api.h_donations(TOP, "donor", "rq"))
        self.assertEqual([(r["amount_inr"], r["status"]) for r in mine["received"]], [(500, "simulated")])
        self.assertEqual(mine["received_inr"], 0)             # simulated money is never owed

    def test_only_top_donors_can_receive_and_not_yourself(self):
        self.assertEqual(self.donate(donor_sub="rookie")[0], 409)
        self.assertEqual(self.donate(donor_sub="nobody")[0], 409)
        self.assertEqual(self.donate(sub=TOP, role="donor")[0], 409)
        self.assertEqual(self.donate(amount_inr=1)[0], 400)
        with mock.patch.object(api, "KMS_KEY_ID", ""):
            self.assertEqual(self.donate()[0], 503)

    def test_real_order_needs_a_valid_signature(self):
        with self.use_razorpay() as co:
            st, o = self.donate()
            self.assertEqual((st, o["mode"], o["order_id"], o["key_id"]), (200, "razorpay", "order_R1", "rzp_test_abc"))
            self.assertNotIn("s3cret", json.dumps(o))
            self.assertEqual(co.call_args[0][2], 500)
        bad = self.call(api.h_donate_confirm(RECV, "receiver", {"order_id": "order_R1", "razorpay_payment_id": "pay_1", "razorpay_signature": "x" * 64}, "rq"))
        self.assertEqual(bad[0], 400)
        self.assertEqual(self.db.items[("order#order_R1", "order")]["status"]["S"], "created")
        sig = payments.checkout_signature("order_R1", "pay_1", "s3cret")
        st, done = self.call(api.h_donate_confirm(RECV, "receiver", {"order_id": "order_R1", "razorpay_payment_id": "pay_1", "razorpay_signature": sig}, "rq"))
        self.assertEqual((st, done["status"], done["amount_inr"]), (200, "paid", 500))
        st, mine = self.call(api.h_donations(TOP, "donor", "rq"))
        self.assertEqual(mine["received_inr"], 500)
        st, given = self.call(api.h_donations(RECV, "receiver", "rq"))
        self.assertEqual([(g["donor_sub"], g["amount_inr"], g["status"]) for g in given["given"]], [(TOP, 500, "paid")])

    def test_confirm_is_idempotent_and_only_for_the_payer(self):
        with self.use_razorpay():
            self.donate()
        sig = payments.checkout_signature("order_R1", "pay_1", "s3cret")
        body = {"order_id": "order_R1", "razorpay_payment_id": "pay_1", "razorpay_signature": sig}
        self.assertEqual(self.call(api.h_donate_confirm("someone-else", "receiver", body, "rq"))[0], 404)
        self.call(api.h_donate_confirm(RECV, "receiver", body, "rq"))
        st, again = self.call(api.h_donate_confirm(RECV, "receiver", body, "rq"))
        self.assertEqual((st, again["status"]), (200, "paid"))
        self.assertEqual(len(api.donations_received(TOP)), 1)         # one record, however many confirms

    def test_webhook_settles_an_order_the_browser_never_confirmed(self):
        with self.use_razorpay():
            self.donate()
        body = json.dumps({"event": "payment.captured", "payload": {"payment": {"entity": {"id": "pay_9", "order_id": "order_R1"}}}})
        sig = hmac_hex = __import__("hmac").new(b"whsec", body.encode(), __import__("hashlib").sha256).hexdigest()
        self.assertEqual(api.h_razorpay_webhook(body, {"x-razorpay-signature": "bad"})["statusCode"], 400)
        self.assertEqual(api.h_razorpay_webhook(body, {"x-razorpay-signature": sig})["statusCode"], 200)
        self.assertEqual(api.donations_received(TOP)[0]["status"], "paid")
        api.h_razorpay_webhook(body, {"x-razorpay-signature": sig})    # a repeat delivery changes nothing
        self.assertEqual(len(api.donations_received(TOP)), 1)

    def test_webhook_route_needs_no_login_but_needs_a_signature(self):
        ev = {"requestContext": {"http": {"method": "POST", "path": "/razorpay/webhook"}}, "rawPath": "/razorpay/webhook",
              "body": "{}", "headers": {"X-Razorpay-Signature": "nope"}}
        self.assertEqual(api.handler(ev, None)["statusCode"], 400)

    def test_gateway_failure_is_a_502_and_creates_no_order(self):
        api._RZP.update(loaded=True, cfg=CFG)
        with mock.patch.object(api.payments, "create_order", return_value=(None, "the payment gateway could not be reached")):
            self.assertEqual(self.donate()[0], 502)
        self.assertEqual(self.db.items, {})

    def test_payout_list_adds_paid_direct_donations_to_what_is_owed(self):
        with self.use_razorpay():
            self.donate()
        api.settle_order("order_R1", "pay_1", "paid")
        with mock.patch.object(api, "FUND_DEMO_PEERS", []):
            st, body = self.call(api.h_payout_list(COORD, "coordinator", "rq"))
        row = next(r for r in body["payouts"] if r["donor_sub"] == TOP)
        self.assertEqual((row["direct_inr"], row["owed_inr"]), (500, row["estimated_inr"] + 500))   # all of it is owed on

    def test_fund_lists_support_totals_and_gateway_mode(self):
        self.donate()
        api.settle_order(next(k[0][6:] for k in self.db.items if k[0].startswith("order#")), "pay_demo_1", "simulated")
        with mock.patch.object(api, "FUND_DEMO_PEERS", []):
            st, body = self.call(api.h_fund(RECV, "receiver", "rq"))
        top = body["top_donors"][0]
        self.assertEqual((top["supporters"], top["supported_inr"]), (1, 500))
        self.assertEqual((body["donations"]["mode"], body["donations"]["pool_enabled"]), ("demo", True))
        self.assertNotIn("fee_pct", body["donations"])


if __name__ == "__main__":
    unittest.main()
