"""Money in and out with no fee and no custody: sponsor pool top-ups, RazorpayX payouts, retries that cannot pay twice,
the payout webhook, and the scheduled run. The Razorpay network calls are patched; signatures are real HMACs."""

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
TOP2 = "top-2"


def stat(points=60):
    return {"points": points, "level": "Steward", "volume": [{"unit": "kg", "quantity": 100, "lots": 4}], "streak_weeks": 2,
            "verified_lots": 4, "partners": 3}


CFG = {"key_id": "rzp_test_abc", "key_secret": "s3cret", "webhook_secret": "whsec", "payout_account": "2323230000000001"}


class PureTest(unittest.TestCase):
    def test_pool_validation(self):
        ok, err = payments.clean_pool({"amount_inr": "5000", "note": "CSR round 3"})
        self.assertEqual((ok, err), ({"amount_inr": 5000, "note": "CSR round 3"}, None))
        for bad in ({"amount_inr": 5}, {"amount_inr": 60000}, {"amount_inr": "x"}, {"amount_inr": 100, "note": "<b>"}):
            self.assertIsNone(payments.clean_pool(bad)[0], bad)

    def test_name_and_mode_helpers(self):
        self.assertEqual(payments.rzp_name("Asha O'Rao", 4, 120), "Asha ORao")
        self.assertIsNone(payments.rzp_name("Ann", 4, 120))
        self.assertEqual((payments.payout_mode(500000), payments.payout_mode(500001)), ("IMPS", "NEFT"))

    def _opener(self, seen, body=b'{"id": "pout_1", "status": "processing"}'):
        class Resp:
            def __enter__(s): return s
            def __exit__(s, *a): return False
            def read(s): return body

        def opener(req, timeout):
            seen["req"], seen["body"] = req, json.loads(req.data)
            return Resp()
        return opener

    P = {"amount_inr": 3200, "idem": "k" * 36, "reference_id": "r" * 32, "donor_ref": "donor-1", "holder_name": "Asha Rao",
         "ifsc": "HDFC0001234", "bank_account": "123456789012"}

    def test_payout_request_shape(self):
        seen = {}
        out, kind, err = payments.create_payout("k", "s", "2323230000000001", self.P, self._opener(seen))
        self.assertEqual((out["id"], kind, err), ("pout_1", None, None))
        b = seen["body"]
        self.assertEqual((b["amount"], b["currency"], b["mode"], b["purpose"], b["queue_if_low_balance"]), (320000, "INR", "IMPS", "payout", True))
        self.assertEqual(b["account_number"], "2323230000000001")
        self.assertEqual(b["fund_account"]["bank_account"], {"name": "Asha Rao", "ifsc": "HDFC0001234", "account_number": "123456789012"})
        self.assertEqual(b["fund_account"]["contact"]["type"], "vendor")
        self.assertLessEqual(len(b["narration"]), 30)
        self.assertEqual(seen["req"].get_header("X-payout-idempotency"), "k" * 36)

    def test_failure_kinds(self):
        def refused(req, timeout):
            raise urllib.error.HTTPError("u", 400, "bad", {}, __import__("io").BytesIO(b'{"error":{"description":"Invalid IFSC"}}'))
        self.assertEqual(payments.create_payout("k", "s", "a", self.P, refused), (None, "definite", "Invalid IFSC"))

        def broken(req, timeout):
            raise urllib.error.HTTPError("u", 502, "bad", {}, None)
        self.assertEqual(payments.create_payout("k", "s", "a", self.P, broken)[1], "uncertain")

        def down(req, timeout):
            raise urllib.error.URLError("down")
        self.assertEqual(payments.create_payout("k", "s", "a", self.P, down)[1], "uncertain")
        calls = []
        out = payments.create_payout("k", "s", "a", dict(self.P, holder_name="Ann"), lambda *a, **k: calls.append(1))
        self.assertEqual((out[1], calls), ("definite", []))          # a too-short name never reaches the network


class MoneyTest(unittest.TestCase):
    call = T.TrustApiTest.__dict__["call"]

    def setUp(self):
        self.db, self.kms, self.logs = DDB(), FakeKMS(), []
        self.stats = {TOP: stat()}
        api._RZP.update(loaded=False, cfg=None)
        for p in (mock.patch.object(api, "ddb", self.db), mock.patch.object(api, "PAYOUTS_TABLE", "payouts"),
                  mock.patch.object(api, "KMS_KEY_ID", "key-1"), mock.patch.object(api, "_KMS", self.kms),
                  mock.patch.object(api, "donor_stats", side_effect=lambda: self.stats),
                  mock.patch.object(api, "FUND_DEMO_PEERS", []), mock.patch.object(api, "FUND_POOL_INR", 25000),
                  mock.patch.object(api, "log", lambda **k: self.logs.append(k)),
                  mock.patch.dict("os.environ", {}, clear=False)):
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(lambda: api._RZP.update(loaded=False, cfg=None))

    def live(self):
        api._RZP.update(loaded=True, cfg=dict(CFG))

    def profile(self, sub=TOP):
        self.assertEqual(self.call(api.h_payout_save(sub, "donor", GOOD, "rq"))[0], 200)

    def pay_order(self, order_id, supporter=RECV):
        sig = payments.checkout_signature(order_id, "pay_1", "s3cret")
        return self.call(api.h_donate_confirm(supporter, "receiver", {"order_id": order_id, "razorpay_payment_id": "pay_1", "razorpay_signature": sig}, "rq"))

    # ---- sponsor pool top-ups ----
    def test_pool_in_demo_mode_is_simulated_and_never_changes_the_pool(self):
        st, o = self.call(api.h_pool(RECV, "receiver", {"amount_inr": 5000, "note": "CSR"}, "rq"))
        self.assertEqual((st, o["mode"], o["kind"], o["amount_inr"]), (200, "demo", "pool", 5000))
        self.assertNotIn("donor_sub", o)
        st, c = self.call(api.h_donate_confirm(RECV, "receiver", {"order_id": o["order_id"], "razorpay_payment_id": "pay_demo_1"}, "rq"))
        self.assertEqual((st, c["status"], c["kind"]), (200, "simulated", "pool"))
        self.assertEqual(api.pool_amount(), 25000)
        st, g = self.call(api.h_donations(RECV, "receiver", "rq"))
        self.assertEqual([(x["kind"], x["donor_sub"], x["status"]) for x in g["given"]], [("pool", None, "simulated")])

    def test_pool_validation_and_not_configured(self):
        self.assertEqual(self.call(api.h_pool(RECV, "receiver", {"amount_inr": 2}, "rq"))[0], 400)
        with mock.patch.object(api, "KMS_KEY_ID", ""):
            self.assertEqual(self.call(api.h_pool(RECV, "receiver", {"amount_inr": 500}, "rq"))[0], 503)

    def test_real_pool_money_becomes_the_pool_and_peers_disappear(self):
        self.live()
        with mock.patch.object(api, "FUND_DEMO_PEERS", [{"name": "Sim Cafe", "points": 90}]), \
                mock.patch.object(api.payments, "create_order", return_value=({"id": "order_P1"}, None)):
            st, o = self.call(api.h_pool(RECV, "receiver", {"amount_inr": 5000}, "rq"))
            self.assertEqual((st, o["mode"], o["key_id"]), (200, "razorpay", "rzp_test_abc"))
            self.assertEqual(self.pay_order("order_P1")[1]["status"], "paid")
            st, f = self.call(api.h_fund(RECV, "receiver", "rq"))
        self.assertEqual((f["pool_inr"], f["pool"]["collected_inr"], f["pool"]["contributors"], f["demo"]), (5000, 5000, 1, False))
        self.assertEqual(f["simulated_peers"], 0)                    # a simulated peer must never take a share of real money

    # ---- payouts, demo mode ----
    def test_demo_run_is_simulated_once_and_skips_donors_without_details(self):
        self.stats[TOP2] = stat(30)
        self.profile(TOP)
        st, r = self.call(api.h_payout_run(COORD, "coordinator", "rq"))
        self.assertEqual((st, r["mode"]), (200, "demo"))
        self.assertEqual([(p["donor_sub"], p["status"]) for p in r["paid"]], [(TOP, "simulated")])
        self.assertEqual(r["skipped"], [{"donor_sub": TOP2, "reason": "no bank details"}])
        st, again = self.call(api.h_payout_run(COORD, "coordinator", "rq"))
        self.assertEqual(again["paid"], [])                          # simulated payouts count as paid: nothing is paid twice
        st, mine = self.call(api.h_payout_profile(TOP, "donor", "rq"))
        self.assertEqual([(p["status"], p["mode"]) for p in mine["payments"]], [("simulated", "simulated")])

    def test_below_minimum_and_per_run_cap(self):
        self.stats[TOP2] = stat(60)
        self.profile(TOP); self.profile(TOP2)
        with mock.patch.object(api, "FUND_POOL_INR", 150):          # 75 each: under the Rs 100 minimum
            st, r = self.call(api.h_payout_run(COORD, "coordinator", "rq"))
        self.assertEqual([x["reason"] for x in r["skipped"]], ["below the Rs 100 minimum"] * 2)
        with mock.patch.object(api, "MAX_PAYOUTS_PER_RUN", 1):
            st, r = self.call(api.h_payout_run(COORD, "coordinator", "rq"))
        self.assertEqual((len(r["paid"]), r["more"]), (1, True))

    # ---- payouts, RazorpayX ----
    def run_live(self, result=({"id": "pout_1", "status": "processing", "utr": None}, None, None)):
        self.live()
        self.profile()
        with mock.patch.object(api, "pool_amount", return_value=10000), \
                mock.patch.object(api.payments, "create_payout", return_value=result) as cp:
            st, r = self.call(api.h_payout_run(COORD, "coordinator", "rq"))
        return r, cp

    def test_live_payout_is_sent_with_the_decrypted_account_and_an_idempotency_key(self):
        r, cp = self.run_live()
        self.assertEqual([(p["donor_sub"], p["amount_inr"], p["status"]) for p in r["paid"]], [(TOP, 10000, "processing")])
        args = cp.call_args[0]
        self.assertEqual((args[0], args[2]), ("rzp_test_abc", "2323230000000001"))
        sent = args[3]
        self.assertEqual((sent["bank_account"], sent["ifsc"], sent["amount_inr"]), ("123456789012", "HDFC0001234", 10000))
        self.assertEqual(len(sent["idem"]), 36)
        self.assertNotIn("123456789012", json.dumps(self.logs))      # the account number never reaches a log
        self.assertEqual(self.db.items[(TOP, "out#000001")]["payout_id"]["S"], "pout_1")
        self.assertIn(("payref#" + sent["reference_id"], "ref"), self.db.items)
        with mock.patch.object(api, "pool_amount", return_value=10000):
            st, pl = self.call(api.h_payout_list(COORD, "coordinator", "rq"))
        self.assertEqual((pl["mode"], pl["ledger"]["owed_inr"], pl["ledger"]["paid_inr"]), ("razorpayx", 0, 10000))
        self.assertNotIn("123456789012", json.dumps(pl))

    def test_a_refused_payout_leaves_the_money_owed_and_is_retried_as_a_new_payout(self):
        r, cp = self.run_live((None, "definite", "Invalid IFSC"))
        self.assertEqual((r["paid"], r["skipped"]), ([], [{"donor_sub": TOP, "reason": "Invalid IFSC"}]))
        self.assertEqual(self.db.items[(TOP, "out#000001")]["status"]["S"], "failed")
        with mock.patch.object(api, "pool_amount", return_value=10000), \
                mock.patch.object(api.payments, "create_payout", return_value=({"id": "pout_2", "status": "queued"}, None, None)):
            st, r2 = self.call(api.h_payout_run(COORD, "coordinator", "rq"))
        self.assertEqual([(p["amount_inr"], p["status"]) for p in r2["paid"]], [(10000, "queued")])
        self.assertIn((TOP, "out#000002"), self.db.items)            # the failed one is history, the retry is a new ordinal

    def test_no_answer_keeps_the_payout_pending_and_asks_again_with_the_same_key(self):
        r, cp = self.run_live((None, "uncertain", "the payout service could not be reached"))
        self.assertEqual([(p["status"]) for p in r["paid"]], ["initiating"])
        first = cp.call_args[0][3]["idem"]
        with mock.patch.object(api, "pool_amount", return_value=10000):
            st, pl = self.call(api.h_payout_list(COORD, "coordinator", "rq"))
        self.assertEqual(pl["ledger"]["owed_inr"], 0)                # on its way: never offered for payment a second time
        with mock.patch.object(api, "pool_amount", return_value=10000), mock.patch.object(api, "STUCK_AFTER_SECONDS", -1), \
                mock.patch.object(api.payments, "create_payout", return_value=({"id": "pout_1", "status": "processing"}, None, None)) as cp2:
            self.call(api.h_payout_run(COORD, "coordinator", "rq"))
        self.assertEqual(cp2.call_args[0][3]["idem"], first)         # same key: Razorpay cannot pay it twice
        self.assertEqual(self.db.items[(TOP, "out#000001")]["status"]["S"], "processing")
        self.assertEqual(len([k for k in self.db.items if k[1].startswith("out#")]), 1)

    def test_each_month_has_its_own_pool_and_its_own_paid_amount(self):
        self.profile()
        with mock.patch.object(api, "period_key", return_value="2026-10"):
            first = api.run_payouts("a")
            again = api.run_payouts("a")
        self.assertEqual((len(first["paid"]), again["paid"]), (1, []))      # paid once in October
        with mock.patch.object(api, "period_key", return_value="2026-11"):
            nov = api.run_payouts("a")
        self.assertEqual(len(nov["paid"]), 1)                                # November's pool is owed again, in full
        self.assertEqual(nov["paid"][0]["amount_inr"], first["paid"][0]["amount_inr"])
        self.assertIn((TOP, "out#000002"), self.db.items)                    # the second payout is a new row, never a rewrite

    def test_period_override_starts_a_fresh_period_without_touching_data(self):
        self.profile()
        api.run_payouts("a")
        self.assertEqual(api.run_payouts("a")["paid"], [])
        with mock.patch.dict("os.environ", {"PERIOD_OVERRIDE": "2026-10-take2"}):
            self.assertEqual(len(api.run_payouts("a")["paid"]), 1)

    def test_two_runs_cannot_take_the_same_payout_slot(self):
        self.profile()
        stale = api.payout_candidates()                              # both runs saw the same state
        with mock.patch.object(api, "payout_candidates", return_value=stale):
            first = api.run_payouts("a")
            second = api.run_payouts("b")
        self.assertEqual(len(first["paid"]), 1)
        self.assertEqual(second["skipped"], [{"donor_sub": TOP, "reason": "a payout is already being sent"}])

    # ---- the webhook ----
    def hook(self, event, entity, eid="evt_1", key="payout"):
        body = json.dumps({"event": event, "payload": {key: {"entity": entity}}})
        sig = hmac.new(b"whsec", body.encode(), hashlib.sha256).hexdigest()
        return api.h_razorpay_webhook(body, {"x-razorpay-signature": sig, "x-razorpay-event-id": eid})["statusCode"]

    def test_payout_webhook_updates_status_ignores_duplicates_and_terminal_states(self):
        r, cp = self.run_live()
        ref = cp.call_args[0][3]["reference_id"]
        self.assertEqual(self.hook("payout.processed", {"id": "pout_1", "status": "processed", "utr": "UTR99", "reference_id": ref}), 200)
        row = self.db.items[(TOP, "out#000001")]
        self.assertEqual((row["status"]["S"], row["utr"]["S"]), ("processed", "UTR99"))
        n = len(self.db.items)
        self.assertEqual(self.hook("payout.processed", {"id": "pout_1", "status": "processed", "reference_id": ref}, eid="evt_1"), 200)
        self.assertEqual(len(self.db.items), n)                      # same event id again: nothing happens
        self.hook("payout.reversed", {"id": "pout_1", "status": "reversed", "reference_id": ref}, eid="evt_2")
        self.assertEqual(self.db.items[(TOP, "out#000001")]["status"]["S"], "processed")   # terminal: later events are ignored

    def test_a_reversed_payout_makes_the_money_owed_again(self):
        r, cp = self.run_live()
        ref = cp.call_args[0][3]["reference_id"]
        self.hook("payout.reversed", {"id": "pout_1", "status": "reversed", "reference_id": ref,
                                      "status_details": {"description": "beneficiary bank offline"}})
        with mock.patch.object(api, "pool_amount", return_value=10000):
            st, pl = self.call(api.h_payout_list(COORD, "coordinator", "rq"))
        self.assertEqual((pl["ledger"]["owed_inr"], pl["payouts"][0]["can_pay"]), (10000, True))
        self.assertEqual(self.db.items[(TOP, "out#000001")]["error"]["S"], "beneficiary bank offline")

    def test_webhook_rejects_bad_signatures_and_settles_payments(self):
        self.live()
        self.assertEqual(api.h_razorpay_webhook("{}", {"x-razorpay-signature": "no"})["statusCode"], 400)
        with mock.patch.object(api.payments, "create_order", return_value=({"id": "order_W1"}, None)):
            self.call(api.h_pool(RECV, "receiver", {"amount_inr": 700}, "rq"))
        self.assertEqual(self.hook("payment.captured", {"id": "pay_7", "order_id": "order_W1"}, key="payment"), 200)
        self.assertEqual(api.pool_stats()["collected_inr"], 700)

    def test_scheduled_event_runs_payouts_without_a_login(self):
        self.profile()
        out = api.handler({"source": "aws.events", "detail-type": "Scheduled Event"}, None)
        self.assertEqual(out["statusCode"], 200)
        self.assertEqual(json.loads(out["body"])["paid"][0]["status"], "simulated")


if __name__ == "__main__":
    unittest.main()
