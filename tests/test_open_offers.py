"""Open offers (announced to every receiver, first claim wins), units and food, and the donor fund.

Reuses the in-memory DynamoDB/Step Functions fakes from test_api_trust.
"""

import json
import time
import unittest
from unittest import mock

import test_api_trust as T
from test_api_trust import api, DONOR, RECV
import rewards

RECV2, COORD = "recv-2", "coord-1"


class OpenOfferTest(unittest.TestCase):
    setUp_trust = T.TrustApiTest.setUp
    call = T.TrustApiTest.__dict__["call"]

    def setUp(self):
        self.setUp_trust()

    def announce(self, **over):
        body = {"food": "Cooked rice", "unit": "kg", "offered": 12}
        body.update(over)
        return self.call(api.h_create(DONOR, "donor", body, "rq-c"))

    def claim(self, lot_id, sub=RECV, version=1, idem="claim-1"):
        return self.call(api.h_accept(lot_id, sub, "receiver", {"idem_key": idem, "expected_version": version}, "rq-a"))

    # -------------------------------------------------------------- creating
    def test_announce_has_no_receiver_and_records_food_and_unit(self):
        st, body = self.announce()
        self.assertEqual(st, 201, body)
        lot = body["lot"]
        self.assertNotIn("receiver_sub", lot)
        self.assertTrue(lot["open_offer"])
        self.assertEqual((lot["food"], lot["unit"], lot["offered"]), ("Cooked rice", "kg", 12))
        self.assertEqual(lot["stage"], "OFFERED")

    def test_old_style_assigned_offer_still_works_and_defaults(self):
        st, body = self.call(api.h_create(DONOR, "donor", {"receiver_sub": RECV, "offered": 10}, "rq"))
        self.assertEqual(st, 201, body)
        lot = body["lot"]
        self.assertEqual((lot["receiver_sub"], lot["open_offer"], lot["unit"], lot["food"]), (RECV, False, "packets", "Surplus food"))

    def test_validation(self):
        self.assertEqual(self.announce(unit="barrels")[0], 400)
        self.assertEqual(self.announce(food="x" * 61)[0], 400)
        self.assertEqual(self.announce(offered=0)[0], 400)
        self.assertEqual(self.announce(offered=-3)[0], 400)
        st, body = self.announce(food="  Rice   and dal \n")
        self.assertEqual((st, body["lot"]["food"]), (201, "Rice and dal"))     # whitespace is tidied

    def test_policy_sees_an_unclaimed_stand_in_receiver(self):
        lot_id = self.announce()[1]["lot"]["lot_id"]
        ents = api.vp_entities(RECV, "receiver", api.get_lot(lot_id))["entityList"]
        lot_entity = next(e for e in ents if e["identifier"]["entityType"].endswith("::Lot"))
        self.assertEqual(lot_entity["attributes"]["receiver"]["entityIdentifier"]["entityId"], "unclaimed")
        ids = [e["identifier"]["entityId"] for e in ents if e["identifier"]["entityType"].endswith("::User")]
        self.assertNotIn("unclaimed", ids)

    # -------------------------------------------------------------- claiming
    def test_first_claim_wins_and_the_lot_becomes_theirs(self):
        lot_id = self.announce()[1]["lot"]["lot_id"]
        self.ddb.lots[lot_id]["task_token"] = {"S": "tok"}
        st, body = self.claim(lot_id)
        self.assertEqual((st, body["stage"], body.get("claimed"), body.get("receiver_sub")), (200, "ACCEPTED", True, RECV), body)
        lot = self.ddb.lots[lot_id]
        self.assertEqual((lot["receiver_sub"]["S"], lot["open_offer"]["BOOL"]), (RECV, False))
        # a second receiver arrives late: refused, and nothing changes
        st, body = self.claim(lot_id, sub=RECV2, idem="claim-2")
        self.assertEqual(st, 409, body)
        self.assertEqual(self.ddb.lots[lot_id]["receiver_sub"]["S"], RECV)
        self.assertEqual(len(self.sfn.successes), 1)                     # the durable wait advanced once

    def test_claim_is_one_chained_event_naming_the_claimer(self):
        lot_id = self.announce()[1]["lot"]["lot_id"]
        self.claim(lot_id)
        accepts = [json.loads(e["result"]["S"]) for (lid, _), e in self.ddb.events.items()
                   if lid == lot_id and e.get("action", {}).get("S") == "Accept" and not e["event_id"]["S"].startswith("IDEM#")]
        self.assertEqual(len(accepts), 1)
        self.assertEqual((accepts[0]["receiver_sub"], accepts[0]["claimed"]), (RECV, True))
        ok = self.call(api.h_verify(lot_id, DONOR, "donor", "rq-v"))[1]
        self.assertTrue(ok["ok"], ok)

    def test_policy_denial_changes_nothing(self):
        lot_id = self.announce()[1]["lot"]["lot_id"]
        self.vp.return_value = False
        st, body = self.claim(lot_id)
        self.assertEqual((st, body["error"]), (403, "VP_DENY"))
        self.assertNotIn("receiver_sub", self.ddb.lots[lot_id])
        self.assertTrue(self.ddb.lots[lot_id]["open_offer"]["BOOL"])

    # -------------------------------------------------------------- reading and listing
    def test_receivers_can_read_an_open_offer_but_only_its_owner_after_the_claim(self):
        lot_id = self.announce()[1]["lot"]["lot_id"]
        get = lambda sub, role: self.call(api.h_get(lot_id, sub, role, "rq-g"))[0]
        self.assertEqual(get(RECV2, "receiver"), 200)
        self.assertEqual(get("stranger-donor", "donor"), 403)
        self.claim(lot_id)
        self.assertEqual(get(RECV, "receiver"), 200)
        self.assertEqual(get(RECV2, "receiver"), 403)
        self.assertEqual(get(COORD, "coordinator"), 200)

    def test_open_offers_listing(self):
        a = self.announce(food="Rice")[1]["lot"]["lot_id"]
        self.ddb.lots[a]["created_epoch"] = {"N": "100"}
        b = self.announce(food="Dal", unit="litres")[1]["lot"]["lot_id"]
        self.ddb.lots[b]["created_epoch"] = {"N": "200"}
        c = self.announce(food="Taken")[1]["lot"]["lot_id"]
        self.claim(c, idem="c-claim")
        d = self.announce(food="Too late")[1]["lot"]["lot_id"]
        self.ddb.lots[d]["response_deadline_epoch"] = {"N": "1"}
        self.call(api.h_create(DONOR, "donor", {"receiver_sub": RECV, "offered": 5}, "rq-assigned"))
        st, body = self.call(api.h_open_offers(RECV2, "receiver", "rq-o"))
        self.assertEqual(st, 200)
        self.assertEqual([l["food"] for l in body["lots"]], ["Dal", "Rice"])       # newest first; claimed, late, assigned excluded
        self.assertEqual(self.call(api.h_open_offers(COORD, "coordinator", "rq"))[0], 200)
        self.assertEqual(self.call(api.h_open_offers(DONOR, "donor", "rq"))[0], 403)


class ImpactUnitsTest(unittest.TestCase):
    setUp_trust = T.TrustApiTest.setUp
    call = T.TrustApiTest.__dict__["call"]

    def setUp(self):
        self.setUp_trust()

    def test_impact_never_adds_different_units(self):
        mk = lambda **b: self.call(api.h_create(DONOR, "donor", dict({"food": "Food"}, **b), "rq"))[1]["lot"]["lot_id"]
        a, b, c = mk(unit="kg", offered=12), mk(unit="kg", offered=8), mk(unit="plates", offered=40)
        st, out = self.call(api.h_impact(COORD, "coordinator", "rq-i"))
        self.assertEqual(st, 200)
        self.assertTrue(out["mixed_units"])
        self.assertEqual((out["by_unit"]["kg"]["offered"], out["by_unit"]["kg"]["lots"]), (20, 2))
        self.assertEqual((out["by_unit"]["plates"]["offered"], out["by_unit"]["plates"]["lots"]), (40, 1))
        self.assertEqual(sum(v["lots"] for v in out["by_unit"].values()), out["lots"])


class FundTest(unittest.TestCase):
    def test_shares_follow_points(self):
        out = rewards.compute_fund({"a": 30, "b": 20, "c": 10}, 6000, 100)
        self.assertEqual([out[d]["estimated_inr"] for d in "abc"], [3000, 2000, 1000])
        self.assertEqual([out[d]["share_pct"] for d in "abc"], [50.0, 33.3, 16.7])
        self.assertFalse(any(v["capped"] for v in out.values()))

    def test_cap_redistributes_and_never_over_allocates(self):
        out = rewards.compute_fund({"a": 70, "b": 20, "c": 10}, 10000, 40)
        self.assertEqual(out["a"]["estimated_inr"], 4000)
        self.assertTrue(out["a"]["capped"])
        self.assertLessEqual(sum(v["estimated_inr"] for v in out.values()), 10000)
        self.assertGreater(out["b"]["estimated_inr"], out["c"]["estimated_inr"])    # b and c split the rest by points

    def test_edge_cases(self):
        self.assertEqual(rewards.compute_fund({"a": 0, "b": 0}, 5000, 30)["a"]["estimated_inr"], 0)
        solo = rewards.compute_fund({"a": 12}, 5000, 30)["a"]
        self.assertEqual((solo["estimated_inr"], solo["share_pct"], solo["capped"]), (5000, 100.0, False))
        self.assertEqual(rewards.compute_fund({}, 5000, 30), {})
        two = rewards.compute_fund({"a": 90, "b": 10}, 1000, 30)                    # cap 30% is impossible for 2 donors
        self.assertEqual(two["a"]["estimated_inr"] + two["b"]["estimated_inr"], 1000)

    def test_quantity_is_not_an_input(self):
        import inspect
        self.assertEqual(list(inspect.signature(rewards.compute_fund).parameters), ["points_by_donor", "pool_inr", "cap_pct"])


def _stat(points, lots=4, partners=3, kg=60):
    return {"points": points, "level": "Steward", "volume": [{"unit": "kg", "quantity": kg, "lots": lots}],
            "streak_weeks": 2, "verified_lots": lots, "partners": partners}


STATS = {"d1": _stat(45, kg=90), "d2": _stat(15, kg=20), "rookie": _stat(30, lots=1, partners=1, kg=5)}


class FundRouteTest(unittest.TestCase):
    call = T.TrustApiTest.__dict__["call"]

    def run_as(self, sub, role, peers=()):
        with mock.patch.object(api, "donor_stats", return_value=STATS), \
                mock.patch.object(api, "FUND_DEMO_PEERS", list(peers)), mock.patch.object(api, "log", lambda **k: None):
            return self.call(api.h_fund(sub, role, "rq"))

    def test_donor_sees_only_their_own_share(self):
        st, body = self.run_as("d1", "donor")
        self.assertEqual(st, 200)
        self.assertTrue(body["demo"])
        self.assertEqual((body["you"]["points"], body["you"]["role"]), (45, "donor"))
        self.assertEqual(body["allocations"], [])
        self.assertEqual(body["total_points"], 60)

    def test_coordinator_sees_the_allocation_table_receiver_sees_neither(self):
        st, body = self.run_as(COORD, "coordinator")
        self.assertEqual([a["donor_sub"] for a in body["allocations"]], ["d1", "d2"])
        self.assertIsNone(body["you"])
        st, body = self.run_as("r1", "receiver")
        self.assertEqual((body["you"], body["allocations"]), (None, []))
        self.assertTrue(any("amount counts only once verified" in r for r in body["rules"]))

    def test_simulated_peers_are_labelled_and_share_the_pool(self):
        peers = [{"name": "Priya's kitchen", "points": 60}, {"name": "Green Leaf Cafe", "points": 30}]
        st, body = self.run_as(COORD, "coordinator", peers)
        rows = body["allocations"]
        self.assertEqual(body["simulated_peers"], 2)
        self.assertEqual(sorted(r["simulated"] for r in rows), [False, False, True, True])
        self.assertTrue(all("name" in r for r in rows if r["simulated"]))
        self.assertTrue(all("donor_sub" in r for r in rows if not r["simulated"]))
        self.assertIn("simulated", body["note"])
        self.assertEqual(body["total_points"], 150)
        self.assertLessEqual(sum(r["estimated_inr"] for r in rows), body["pool_inr"])
        st, mine = self.run_as("d1", "donor", peers)
        self.assertEqual(mine["you"]["points"], 45)
        self.assertLess(mine["you"]["share_pct"], 50)                  # shares the pool with the peers
        self.assertEqual(mine["allocations"], [])                       # a donor never sees other rows, simulated or not

    def test_only_donors_with_a_broad_verified_record_share_the_pool(self):
        st, body = self.run_as("rookie", "donor")
        self.assertEqual(body["total_points"], 60)                      # the rookie's 30 points are not in the pool
        self.assertEqual((body["you"]["eligible"], body["you"]["estimated_inr"]), (False, 0))
        self.assertEqual(body["you"]["needs"], {"lots": 3, "partners": 2})
        self.assertEqual((body["you"]["verified_lots"], body["you"]["partners"]), (1, 1))
        self.assertNotIn("rookie", [t["donor_sub"] for t in body["top_donors"]])

    def test_top_donors_rank_by_verified_volume(self):
        st, body = self.run_as("d2", "donor")
        self.assertEqual([t["donor_sub"] for t in body["top_donors"]], ["d1", "d2"])
        self.assertEqual(body["top_donors"][0]["volume"][0]["quantity"], 90)
        self.assertTrue(body["you"]["eligible"])

    def test_new_donor_with_no_points_gets_a_zero_row(self):
        st, body = self.run_as("newbie", "donor")
        self.assertEqual((body["you"]["points"], body["you"]["estimated_inr"]), (0, 0))


if __name__ == "__main__":
    unittest.main()
