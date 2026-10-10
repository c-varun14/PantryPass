"""Handler tests for backend/api.py trust-record routes, against an in-memory DynamoDB fake.

boto3 is not installed, so a stub boto3/botocore is put into sys.modules before api is imported.
"""

import copy
import json
import os
import re
import sys
import types
import unittest
from unittest import mock

BACKEND = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))
sys.path.insert(0, BACKEND)


class ClientError(Exception):
    def __init__(self, error_response, operation_name):
        super().__init__(error_response.get("Error", {}).get("Message", ""))
        self.response = error_response
        self.operation_name = operation_name


_botocore_exc = types.ModuleType("botocore.exceptions")
_botocore_exc.ClientError = ClientError
_botocore = types.ModuleType("botocore")
_botocore.exceptions = _botocore_exc
_boto3 = types.ModuleType("boto3")
_boto3.client = lambda service, **kw: None  # replaced per test by the fakes below
sys.modules["boto3"] = _boto3
sys.modules["botocore"] = _botocore
sys.modules["botocore.exceptions"] = _botocore_exc

LOTS, EVENTS = "lots", "events"
os.environ["LOTS_TABLE"] = LOTS
os.environ["EVENTS_TABLE"] = EVENTS
os.environ["POLICY_STORE_ID"] = "x"
os.environ["STATE_MACHINE_ARN"] = "y"

import api  # noqa: E402
import trust  # noqa: E402

DONOR, RECV, COORD = "donor-1", "recv-1", "coord-1"


def _cond_failed(op):
    return ClientError({"Error": {"Code": "ConditionalCheckFailedException",
                                  "Message": "The conditional request failed"}}, op)


def _key_of(item):
    if "event_id" in item:
        return (item["lot_id"]["S"], item["event_id"]["S"])
    return item["lot_id"]["S"]


def _eq_filter(item, expr, names, values):
    lhs, rhs = [p.strip() for p in expr.split("=")]
    return item.get(names.get(lhs, lhs)) == values[rhs]


def _cond_ok(item, expr, names, values):
    if not expr:
        return True
    for clause in expr.split(" AND "):
        lhs, rhs = [p.strip() for p in clause.split("=")]
        if item.get(names.get(lhs, lhs)) != values[rhs]:
            return False
    return True


def _apply_update(item, expr, names, values):
    set_part, _, rem_part = expr.partition(" REMOVE ")
    assert set_part.startswith("SET "), expr
    for clause in set_part[len("SET "):].split(", "):
        lhs, rhs = [p.strip() for p in clause.split("=")]
        item[names.get(lhs, lhs)] = copy.deepcopy(values[rhs])
    if rem_part:
        for n in rem_part.split(", "):
            n = n.strip()
            item.pop(names.get(n, n), None)


class FakeDDB:
    """In-memory stand-in for the boto3 dynamodb client, limited to what api.py uses."""

    def __init__(self):
        self.lots = {}    # lot_id -> typed item
        self.events = {}  # (lot_id, event_id) -> typed item

    def _store(self, table):
        if table == LOTS:
            return self.lots
        if table == EVENTS:
            return self.events
        raise KeyError(table)

    def get_item(self, TableName, Key, ConsistentRead=False):
        it = self._store(TableName).get(_key_of(Key))
        return {"Item": copy.deepcopy(it)} if it is not None else {}

    def put_item(self, TableName, Item, ConditionExpression=None):
        store = self._store(TableName)
        k = _key_of(Item)
        if ConditionExpression == "attribute_not_exists(lot_id)" and k in store:
            raise _cond_failed("PutItem")
        store[k] = copy.deepcopy(Item)
        return {}

    def update_item(self, TableName, Key, UpdateExpression, ExpressionAttributeValues,
                    ConditionExpression=None, ExpressionAttributeNames=None):
        assert TableName == LOTS
        item = self.lots[Key["lot_id"]["S"]]
        v = ExpressionAttributeValues
        if UpdateExpression == "SET callback_pending = :p":
            item["callback_pending"] = copy.deepcopy(v[":p"])
        elif UpdateExpression == "SET exec_arn = :a":
            item["exec_arn"] = copy.deepcopy(v[":a"])
        elif UpdateExpression == "ADD pickup_attempts :one":
            assert ConditionExpression == "attribute_not_exists(pickup_attempts) OR pickup_attempts < :max"
            cur = item.get("pickup_attempts")
            if cur is not None and int(cur["N"]) >= int(v[":max"]["N"]):
                raise _cond_failed("UpdateItem")
            item["pickup_attempts"] = {"N": str((int(cur["N"]) if cur else 0) + int(v[":one"]["N"]))}
        else:
            raise NotImplementedError(UpdateExpression)
        return {}

    def query(self, TableName, KeyConditionExpression, ExpressionAttributeValues,
              ConsistentRead=False, ExclusiveStartKey=None):
        assert TableName == EVENTS and KeyConditionExpression == "lot_id = :l"
        lot_id = ExpressionAttributeValues[":l"]["S"]
        items = [copy.deepcopy(v) for (lid, _), v in sorted(self.events.items()) if lid == lot_id]
        return {"Items": items}

    def scan(self, TableName, FilterExpression=None, ExpressionAttributeNames=None,
             ExpressionAttributeValues=None, ExclusiveStartKey=None):
        out = []
        for it in self._store(TableName).values():
            if FilterExpression and not _eq_filter(it, FilterExpression,
                                                   ExpressionAttributeNames or {},
                                                   ExpressionAttributeValues or {}):
                continue
            out.append(copy.deepcopy(it))
        return {"Items": out}

    def transact_write_items(self, TransactItems):
        staged_lots = copy.deepcopy(self.lots)
        staged_events = copy.deepcopy(self.events)
        reasons, failed = [], False
        for ti in TransactItems:
            if "Update" in ti:
                u = ti["Update"]
                assert u["TableName"] == LOTS
                names = u.get("ExpressionAttributeNames", {})
                values = u.get("ExpressionAttributeValues", {})
                item = staged_lots.get(u["Key"]["lot_id"]["S"])
                if item is None or not _cond_ok(item, u.get("ConditionExpression"), names, values):
                    reasons.append({"Code": "ConditionalCheckFailed"})
                    failed = True
                    continue
                _apply_update(item, u["UpdateExpression"], names, values)
                reasons.append({"Code": "None"})
            elif "Put" in ti:
                p = ti["Put"]
                if p["TableName"] == LOTS:
                    lid = p["Item"]["lot_id"]["S"]
                    if p.get("ConditionExpression") == "attribute_not_exists(lot_id)" and lid in staged_lots:
                        reasons.append({"Code": "ConditionalCheckFailed"})
                        failed = True
                        continue
                    staged_lots[lid] = copy.deepcopy(p["Item"])
                    reasons.append({"Code": "None"})
                    continue
                assert p["TableName"] == EVENTS
                k = _key_of(p["Item"])
                if p.get("ConditionExpression") == "attribute_not_exists(event_id)" and k in staged_events:
                    reasons.append({"Code": "ConditionalCheckFailed"})
                    failed = True
                    continue
                staged_events[k] = copy.deepcopy(p["Item"])
                reasons.append({"Code": "None"})
            else:
                raise NotImplementedError(ti)
        if failed:
            raise ClientError({"Error": {"Code": "TransactionCanceledException",
                                         "Message": "Transaction cancelled"},
                               "CancellationReasons": reasons}, "TransactWriteItems")
        self.lots, self.events = staged_lots, staged_events
        return {}


class FakeSFN:
    def __init__(self):
        self.started = []
        self.successes = []
        self.fail_success = False

    def start_execution(self, stateMachineArn, name, input):
        self.started.append(name)
        return {"executionArn": "arn:exec:" + name}

    def send_task_success(self, taskToken, output):
        if self.fail_success:
            raise ClientError({"Error": {"Code": "TaskTimedOut", "Message": "task timed out"}},
                              "SendTaskSuccess")
        self.successes.append((taskToken, json.loads(output)))
        return {}


def leaves(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield k
            yield from leaves(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from leaves(v)
    else:
        yield obj


class TrustApiTest(unittest.TestCase):
    def setUp(self):
        self.ddb = FakeDDB()
        self.sfn = FakeSFN()
        patches = [
            mock.patch.object(api, "ddb", self.ddb),
            mock.patch.object(api, "sfn", self.sfn),
            mock.patch.object(api, "log", lambda **kw: None),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.vp = mock.patch.object(api, "vp_authorize", return_value=True).start()
        self.addCleanup(mock.patch.stopall)

    # ------------------------------------------------------------ helpers
    @staticmethod
    def call(r):
        return r["statusCode"], json.loads(r["body"])

    def create(self, offered=10):
        st, body = self.call(api.h_create(DONOR, "donor",
                                          {"receiver_sub": RECV, "offered": offered}, "rq-create"))
        self.assertEqual(st, 201, body)
        lot_id = body["lot"]["lot_id"]
        # Step Functions writes the callback token while the lot waits for the receiver.
        self.ddb.lots[lot_id]["task_token"] = {"S": "tok-" + lot_id}
        return lot_id

    def accept(self, lot_id, version=1, idem="acc-1"):
        return self.call(api.h_accept(lot_id, RECV, "receiver",
                                      {"idem_key": idem, "expected_version": version}, "rq-acc"))

    def handoff(self, lot_id, version=2, qty=10, idem="hand-1"):
        return self.call(api.h_handoff(lot_id, DONOR, "donor",
                                       {"idem_key": idem, "expected_version": version,
                                        "donor_handoff": qty}, "rq-hand"))

    def receipt(self, lot_id, version=3, received=10, code=None, idem="rec-1"):
        body = {"idem_key": idem, "expected_version": version, "received": received}
        if code is not None:
            body["pickup_code"] = code
        return self.call(api.h_receipt(lot_id, RECV, "receiver", body, "rq-rec"))

    def distribute(self, lot_id, version, qty, idem):
        return self.call(api.h_distribution(lot_id, RECV, "receiver",
                                            {"idem_key": idem, "expected_version": version,
                                             "distributed": qty}, "rq-dist"))

    def close(self, lot_id, version, idem="close-1"):
        return self.call(api.h_close(lot_id, RECV, "receiver",
                                     {"idem_key": idem, "expected_version": version}, "rq-close"))

    def verify(self, lot_id, sub=DONOR, role="donor"):
        st, body = self.call(api.h_verify(lot_id, sub, role, "rq-verify"))
        self.assertEqual(st, 200, body)
        return body

    def get_lot(self, lot_id):
        st, body = self.call(api.h_get(lot_id, DONOR, "donor", "rq-get"))
        self.assertEqual(st, 200, body)
        return body

    def stored_events(self, lot_id):
        return [copy.deepcopy(v) for (lid, _), v in sorted(self.ddb.events.items())
                if lid == lot_id and not v["event_id"]["S"].startswith("IDEM#")]

    def event_results(self, lot_id):
        return [json.loads(e["result"]["S"]) for e in self.stored_events(lot_id) if "result" in e]

    def run_to_handoff(self, offered=10):
        lot_id = self.create(offered)
        st, _ = self.accept(lot_id)
        self.assertEqual(st, 200)
        st, body = self.handoff(lot_id, 2, offered)
        self.assertEqual(st, 200, body)
        return lot_id, body["pickup_code"]

    def assert_no_code_material(self, obj, code):
        values = [str(x) for x in leaves(obj)]
        self.assertNotIn(code, values)
        for name in ("pickup_hash", "pickup_salt", "pickup_code", "task_token"):
            self.assertNotIn(name, values)

    # -------------------------------------------------------------- tests
    def test_a_happy_path_full_flow_verifies(self):
        lot_id = self.create(10)
        self.assertEqual(self.accept(lot_id, 1)[0], 200)
        st, body = self.handoff(lot_id, 2, 10)
        self.assertEqual(st, 200)
        code = body["pickup_code"]
        self.assertEqual(self.receipt(lot_id, 3, 10, code)[0], 200)
        self.assertEqual(self.distribute(lot_id, 4, 6, "d-1")[0], 200)
        self.assertEqual(self.distribute(lot_id, 5, 4, "d-2")[0], 200)
        st, body = self.close(lot_id, 6)
        self.assertEqual(st, 200, body)
        self.assertEqual(body["stage"], "ACCOUNTED_FOR")

        # The accept delivered its callback once and the lot is no longer pending.
        self.assertEqual(len(self.sfn.successes), 1)
        self.assertIs(self.ddb.lots[lot_id]["callback_pending"]["BOOL"], False)

        state_changing = len(self.stored_events(lot_id))
        self.assertEqual(state_changing, 7)
        v = self.verify(lot_id)
        self.assertTrue(v["ok"], v)
        self.assertEqual(v["length"], state_changing)
        self.assertEqual(v["head"], v["lot_head"])
        self.assertEqual(v["legacy"], 0)
        self.assertIsNone(v["broken_at"])

    def test_b_pickup_code_never_leaves_the_server(self):
        lot_id, code = self.run_to_handoff(10)
        self.assertRegex(code, r"^\d{6}$")

        # Public lot view and the stored lot record before receipt.
        public_lot = self.get_lot(lot_id)
        self.assert_no_code_material(public_lot, code)
        self.assertNotIn("pickup_hash", public_lot["lot"])
        self.assertNotIn("pickup_salt", public_lot["lot"])
        self.assertEqual(public_lot["lot"]["stage"], "HANDOFF_DECLARED")
        self.assertIn("pickup_salt", self.ddb.lots[lot_id])  # stored server side, hashed

        # Every stored event result (including the idempotency markers) is code-free.
        for e in self.ddb.events.values():
            self.assertNotIn("pickup_code", json.dumps(e))
            if "result" in e:
                self.assert_no_code_material(json.loads(e["result"]["S"]), code)

    def test_c_receipt_with_correct_code_confirms_and_replays(self):
        lot_id, code = self.run_to_handoff(10)
        st, first = self.receipt(lot_id, 3, 10, code, idem="rec-ok")
        self.assertEqual(st, 200, first)
        self.assertIs(first["confirmed_in_person"], True)
        self.assertEqual(first["stage"], "RECEIVED")

        lot = self.get_lot(lot_id)["lot"]
        self.assertIs(lot["confirmed_in_person"], True)
        self.assertNotIn("pickup_hash", lot)
        self.assertNotIn("pickup_salt", lot)

        raw = self.ddb.lots[lot_id]
        self.assertNotIn("pickup_salt", raw)
        self.assertNotIn("pickup_hash", raw)

        receipt_events = [r for r in self.event_results(lot_id) if r.get("action") == "Receipt"]
        self.assertEqual(len(receipt_events), 1)
        self.assertIs(receipt_events[0]["confirmed_in_person"], True)

        # Replaying the same receipt returns the stored result and writes nothing new.
        before = len(self.stored_events(lot_id))
        st, replay = self.receipt(lot_id, 3, 10, code, idem="rec-ok")
        self.assertEqual(st, 200)
        self.assertEqual(replay, first)
        self.assertEqual(len(self.stored_events(lot_id)), before)

    def test_d_wrong_code_counts_down_then_locks(self):
        lot_id, code = self.run_to_handoff(10)
        wrong = "000000" if code != "000000" else "000001"

        for expected_left in (4, 3, 2, 1, 0):
            st, body = self.receipt(lot_id, 3, 10, wrong, idem="rec-w")
            self.assertEqual(st, 409)
            self.assertEqual(body["error"], "pickup code invalid")
            self.assertEqual(body["attempts_left"], expected_left)

        self.assertEqual(self.ddb.lots[lot_id]["pickup_attempts"], {"N": "5"})

        # Locked: even the correct code is refused now.
        st, body = self.receipt(lot_id, 3, 10, code, idem="rec-w")
        self.assertEqual(st, 409)
        self.assertEqual(body["error"], "pickup code attempt limit reached")
        self.assertEqual(body["attempts_left"], 0)

        # Failed attempts never bump the version or move the stage.
        lot = self.get_lot(lot_id)["lot"]
        self.assertEqual(lot["version"], 3)
        self.assertEqual(lot["stage"], "HANDOFF_DECLARED")
        self.assertFalse(any(r.get("action") == "Receipt" for r in self.event_results(lot_id)))

    def test_d2_receipt_without_code_still_works_unconfirmed(self):
        lot_id, _ = self.run_to_handoff(10)
        st, body = self.receipt(lot_id, 3, 4, None, idem="rec-nocode")
        self.assertEqual(st, 200, body)
        self.assertIs(body["confirmed_in_person"], False)
        self.assertIs(body["count_dispute"], True)  # received 4 != donor_handoff 10
        lot = self.get_lot(lot_id)["lot"]
        self.assertIs(lot["confirmed_in_person"], False)
        self.assertEqual(lot["stage"], "RECEIVED")

    def test_e_expired_code_is_refused_without_costing_an_attempt(self):
        lot_id, code = self.run_to_handoff(10)
        self.ddb.lots[lot_id]["pickup_expires_epoch"] = {"N": str(1)}  # long past
        st, body = self.receipt(lot_id, 3, 10, code, idem="rec-exp")
        self.assertEqual(st, 409)
        self.assertEqual(body["error"], "pickup code expired")
        self.assertEqual(self.ddb.lots[lot_id]["pickup_attempts"], {"N": "0"})
        self.assertEqual(self.get_lot(lot_id)["lot"]["version"], 3)

    def test_f_tampered_event_result_fails_verify(self):
        lot_id = self.create(10)
        self.assertEqual(self.accept(lot_id, 1)[0], 200)
        self.assertTrue(self.verify(lot_id)["ok"])

        accept_ev = [e for e in self.stored_events(lot_id) if e["action"]["S"] == "Accept"][0]
        accept_ev["result"] = {"S": json.dumps({"forged": True})}
        self.ddb.events[(lot_id, accept_ev["event_id"]["S"])] = accept_ev

        v = self.verify(lot_id)
        self.assertFalse(v["ok"])
        self.assertEqual(v["broken_at"], accept_ev["event_id"]["S"])
        self.assertIn("does not match", v["reason"])

    def test_f_deleted_last_event_fails_verify(self):
        lot_id = self.create(10)
        self.assertEqual(self.accept(lot_id, 1)[0], 200)
        st, _ = self.handoff(lot_id, 2, 10)
        self.assertEqual(st, 200)
        self.assertTrue(self.verify(lot_id)["ok"])

        # Events in the same second sort by a random suffix, so pick the chain tail by hash.
        head = self.ddb.lots[lot_id]["chain_head"]["S"]
        last = [e for e in self.stored_events(lot_id) if e["hash"]["S"] == head][0]
        del self.ddb.events[(lot_id, last["event_id"]["S"])]

        v = self.verify(lot_id)
        self.assertFalse(v["ok"])
        self.assertEqual(v["length"], 2)
        self.assertIn("head", v["reason"])

    def test_f_deleted_middle_event_fails_verify(self):
        lot_id = self.create(10)
        self.assertEqual(self.accept(lot_id, 1)[0], 200)
        self.assertEqual(self.handoff(lot_id, 2, 10)[0], 200)
        accept_ev = [e for e in self.stored_events(lot_id) if e["action"]["S"] == "Accept"][0]
        del self.ddb.events[(lot_id, accept_ev["event_id"]["S"])]

        v = self.verify(lot_id)
        self.assertFalse(v["ok"])
        self.assertEqual(v["length"], 1)
        self.assertIn("not reachable", v["reason"])

    def test_vp_deny_writes_attributed_event_that_verify_ignores(self):
        lot_id = self.create(10)
        self.assertEqual(self.accept(lot_id, 1)[0], 200)
        self.vp.return_value = False
        st, body = self.close(lot_id, 2)
        self.assertEqual(st, 403)
        self.assertEqual(body["error"], "VP_DENY")
        self.vp.return_value = True

        denies = [v for (lid, _), v in self.ddb.events.items()
                  if lid == lot_id and v.get("decision", {}).get("S") == "DENY"]
        self.assertEqual(len(denies), 1)

        v = self.verify(lot_id)
        self.assertTrue(v["ok"], v)
        self.assertEqual(v["length"], 2)
        self.assertEqual(v["legacy"], 0)

    def test_callback_failure_marks_pending(self):
        lot_id = self.create(10)
        self.sfn.fail_success = True
        st, body = self.accept(lot_id, 1)
        self.assertEqual(st, 200)
        self.assertEqual(body["callback"], "pending")
        self.assertIs(self.ddb.lots[lot_id]["callback_pending"]["BOOL"], True)

    def test_g_impact_is_coordinator_only_and_counts(self):
        # Lot A: complete, confirmed in person, fully distributed and closed.
        a, code_a = self.run_to_handoff(10)
        self.assertEqual(self.receipt(a, 3, 10, code_a, idem="ra")[0], 200)
        self.assertEqual(self.distribute(a, 4, 10, "da")[0], 200)
        self.assertEqual(self.close(a, 5, "ca")[0], 200)

        # Lot B: donor says 5, receiver counts 4 without a code -> dispute, one deadline missed.
        b = self.create(5)
        self.assertEqual(self.accept(b, 1, "ab")[0], 200)
        self.assertEqual(self.handoff(b, 2, 5, "hb")[0], 200)
        self.assertEqual(self.receipt(b, 3, 4, None, idem="rb")[0], 200)
        self.ddb.events[(b, "000000000009#zz")] = {
            "lot_id": {"S": b}, "event_id": {"S": "000000000009#zz"},
            "actor": {"S": "system"}, "action": {"S": "ResponseDeadlineMissed"},
            "decision": {"S": "ALLOW"}, "ts": {"N": "9"},
        }

        st, body = self.call(api.h_impact(DONOR, "donor", "rq-imp"))
        self.assertEqual(st, 403)
        self.assertEqual(body["error"], "coordinator only")
        st, body = self.call(api.h_impact(RECV, "receiver", "rq-imp"))
        self.assertEqual(st, 403)

        st, body = self.call(api.h_impact(COORD, "coordinator", "rq-imp"))
        self.assertEqual(st, 200)
        self.assertEqual(body["lots"], 2)
        self.assertEqual(body["offered"], 15)
        self.assertEqual(body["received"], 14)
        self.assertEqual(body["distributed"], 10)
        self.assertEqual(body["returned"], 0)
        self.assertEqual(body["disposed"], 0)
        self.assertEqual(body["accounted_for"], 1)
        self.assertEqual(body["disputes_caught"], 1)
        self.assertEqual(body["exceptions_raised"], 1)
        self.assertEqual(body["confirmed_in_person"], 1)


if __name__ == "__main__":
    unittest.main()
