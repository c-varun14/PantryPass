"""Payout details: validation, masking, KMS sealing, who may see what, and hand-recorded transfers.

A small in-memory DynamoDB (one table, hash+range key) and a fake KMS stand in for AWS.
"""

import base64
import copy
import json
import unittest
from unittest import mock

import test_api_trust as T
from test_api_trust import api, ClientError, DONOR, RECV, COORD
import payouts
import rewards

GOOD = {"holder_name": "Asha Rao", "account_number": "123456789012", "ifsc": "hdfc0001234", "upi": "asha@okhdfc"}


class FakePayoutsDDB:
    def __init__(self):
        self.items = {}

    def get_item(self, TableName, Key):
        it = self.items.get((Key["sub"]["S"], Key["sk"]["S"]))
        return {"Item": copy.deepcopy(it)} if it else {}

    def put_item(self, TableName, Item, ConditionExpression=None):
        k = (Item["sub"]["S"], Item["sk"]["S"])
        if ConditionExpression == "attribute_not_exists(sk)" and k in self.items:
            raise ClientError({"Error": {"Code": "ConditionalCheckFailedException", "Message": "x"}}, "PutItem")
        self.items[k] = copy.deepcopy(Item)
        return {}

    def update_item(self, TableName, Key, UpdateExpression, ExpressionAttributeValues, ExpressionAttributeNames=None,
                    ConditionExpression=None):
        item = self.items[(Key["sub"]["S"], Key["sk"]["S"])]
        names = ExpressionAttributeNames or {}
        if ConditionExpression:
            lhs, rhs = [x.strip() for x in ConditionExpression.split("=")]
            if item.get(names.get(lhs, lhs)) != ExpressionAttributeValues[rhs]:
                raise ClientError({"Error": {"Code": "ConditionalCheckFailedException", "Message": "x"}}, "UpdateItem")
        assert UpdateExpression.startswith("SET ")
        for clause in UpdateExpression[4:].split(", "):
            lhs, rhs = [x.strip() for x in clause.split(" = ")]
            item[names.get(lhs, lhs)] = copy.deepcopy(ExpressionAttributeValues[rhs])
        return {}

    def query(self, TableName, KeyConditionExpression, ExpressionAttributeNames, ExpressionAttributeValues):
        assert "begins_with(sk, :k)" in KeyConditionExpression
        sub, prefix = ExpressionAttributeValues[":p"]["S"], ExpressionAttributeValues[":k"]["S"]
        return {"Items": [copy.deepcopy(v) for (s, sk), v in sorted(self.items.items()) if s == sub and sk.startswith(prefix)]}


class FakeKMS:
    def __init__(self):
        self.calls = []

    def encrypt(self, KeyId, Plaintext, EncryptionContext):
        self.calls.append(("encrypt", EncryptionContext))
        return {"CiphertextBlob": b"ENC:" + EncryptionContext["sub"].encode() + b":" + Plaintext[::-1]}

    def decrypt(self, CiphertextBlob, KeyId, EncryptionContext):
        self.calls.append(("decrypt", EncryptionContext))
        head, sub, rest = CiphertextBlob.split(b":", 2)
        if sub.decode() != EncryptionContext["sub"]:
            raise ClientError({"Error": {"Code": "InvalidCiphertextException", "Message": "context"}}, "Decrypt")
        return {"Plaintext": rest[::-1]}


class ValidationTest(unittest.TestCase):
    def test_good_profile_is_normalised(self):
        prof, err = payouts.clean_profile(dict(GOOD, holder_name="  Asha   Rao ", account_number="1234 5678 9012"))
        self.assertIsNone(err)
        self.assertEqual((prof["holder_name"], prof["account_number"], prof["ifsc"]), ("Asha Rao", "123456789012", "HDFC0001234"))

    def test_bad_fields_are_refused(self):
        for bad in ({"holder_name": "1"}, {"holder_name": "Ann"}, {"holder_name": ""}, {"account_number": "12345"}, {"account_number": "12ab56789012"},
                    {"ifsc": "HDFC1001234"}, {"ifsc": "HDFC000123"}, {"upi": "not a upi"}):
            prof, err = payouts.clean_profile(dict(GOOD, **bad))
            self.assertIsNone(prof, bad)
            self.assertTrue(err, bad)

    def test_upi_is_optional(self):
        prof, err = payouts.clean_profile(dict(GOOD, upi=""))
        self.assertIsNone(err)

    def test_masking(self):
        self.assertEqual(payouts.mask_account("9012"), "XXXXXX9012")
        self.assertEqual(payouts.mask_upi("asha@okhdfc"), "as***@okhdfc")
        self.assertEqual(payouts.public_profile(None), {"configured": False})



class PayoutRouteTest(unittest.TestCase):
    call = T.TrustApiTest.__dict__["call"]

    def setUp(self):
        self.db, self.kms, self.logs = FakePayoutsDDB(), FakeKMS(), []
        for p in (mock.patch.object(api, "ddb", self.db), mock.patch.object(api, "PAYOUTS_TABLE", "payouts"),
                  mock.patch.object(api, "KMS_KEY_ID", "key-1"), mock.patch.object(api, "_KMS", self.kms),
                  mock.patch.object(api, "log", lambda **k: self.logs.append(k))):
            p.start()
            self.addCleanup(p.stop)

    def save(self, sub=DONOR, role="donor", **over):
        return self.call(api.h_payout_save(sub, role, dict(GOOD, **over), "rq"))

    def test_donor_saves_and_only_sees_masked_details(self):
        st, body = self.save()
        self.assertEqual(st, 200)
        self.assertEqual((body["account"], body["ifsc"], body["upi"]), ("XXXXXX9012", "HDFC0001234", "as***@okhdfc"))
        self.assertNotIn("123456789012", json.dumps(body))
        st, again = self.call(api.h_payout_profile(DONOR, "donor", "rq"))
        self.assertEqual(again["account"], "XXXXXX9012")
        self.assertEqual(again["payments"], [])

    def test_account_number_is_encrypted_at_rest_and_never_logged(self):
        self.save()
        stored = json.dumps(self.db.items[(DONOR, "profile")])
        self.assertNotIn("123456789012", stored)
        self.assertEqual(self.kms.calls[0], ("encrypt", {"sub": DONOR}))
        self.assertNotIn("123456789012", json.dumps(self.logs))
        self.assertNotIn("123456789012", base64.b64decode(self.db.items[(DONOR, "profile")]["account_enc"]["S"]).decode(errors="ignore"))

    def test_invalid_details_are_a_400_and_store_nothing(self):
        st, body = self.save(ifsc="nope")
        self.assertEqual(st, 400)
        self.assertEqual(self.db.items, {})

    def test_only_donors_can_add_details_and_only_coordinators_list_or_run(self):
        self.assertEqual(self.save(RECV, "receiver")[0], 403)
        self.assertEqual(self.call(api.h_payout_profile(COORD, "coordinator", "rq"))[0], 403)
        self.assertEqual(self.call(api.h_payout_list(DONOR, "donor", "rq"))[0], 403)
        self.assertEqual(self.call(api.h_payout_run(DONOR, "donor", "rq"))[0], 403)
        self.assertEqual(self.call(api.h_payout_run(RECV, "receiver", "rq"))[0], 403)

    def test_not_configured_is_a_503_not_a_crash(self):
        with mock.patch.object(api, "KMS_KEY_ID", ""):
            self.assertEqual(self.save()[0], 503)

    def test_ciphertext_is_bound_to_the_donor(self):
        self.save()
        blob = self.db.items[(DONOR, "profile")]["account_enc"]["S"]
        with self.assertRaises(ClientError):
            api.unseal("someone-else", blob)

    def test_payout_list_shows_what_is_owed_masked_and_skips_simulated_peers(self):
        self.save()
        stats = {DONOR: {"points": 40, "level": "Helper", "volume": [], "streak_weeks": 0, "verified_lots": 3, "partners": 2},
                 "d2": {"points": 20, "level": "Helper", "volume": [], "streak_weeks": 0, "verified_lots": 3, "partners": 2}}
        peers = [{"name": "Sim Cafe", "points": 30}]
        with mock.patch.object(api, "donor_stats", return_value=stats), mock.patch.object(api, "FUND_DEMO_PEERS", peers):
            st, body = self.call(api.h_payout_list(COORD, "coordinator", "rq"))
        self.assertEqual(st, 200)
        rows = {r["donor_sub"]: r for r in body["payouts"]}
        self.assertEqual(set(rows), {DONOR, "d2"})
        self.assertEqual(rows[DONOR]["profile"]["account"], "XXXXXX9012")
        self.assertEqual(rows["d2"]["profile"], {"configured": False})
        self.assertGreater(rows[DONOR]["estimated_inr"], 0)
        self.assertNotIn("123456789012", json.dumps(body))

    def test_routes_are_wired(self):
        def ev(method, path, role, body=None):
            return {"requestContext": {"http": {"method": method, "path": path}, "requestId": "r",
                                       "authorizer": {"jwt": {"claims": {"sub": DONOR if role == "donor" else COORD,
                                                                          "cognito:groups": role}}}},
                    "rawPath": path, "body": json.dumps(body or {})}
        self.assertEqual(api.handler(ev("PUT", "/payout-profile", "donor", GOOD), None)["statusCode"], 200)
        self.assertEqual(api.handler(ev("GET", "/payout-profile", "donor"), None)["statusCode"], 200)
        with mock.patch.object(api, "donor_stats", return_value={}), mock.patch.object(api, "FUND_DEMO_PEERS", []):
            self.assertEqual(api.handler(ev("POST", "/payouts/run", "coordinator"), None)["statusCode"], 200)
        self.assertEqual(api.handler(ev("POST", "/payouts/run", "donor"), None)["statusCode"], 403)
        for gone in ("GET", "POST"):                       # the coordinator can no longer reveal an account or record a transfer
            path = "/payouts/%s/%s" % (DONOR, "details" if gone == "GET" else "transfer")
            self.assertEqual(api.handler(ev(gone, path, "coordinator"), None)["statusCode"], 404)


if __name__ == "__main__":
    unittest.main()
