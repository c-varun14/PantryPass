"""Photo evidence: scoped upload keys, commit-time fingerprinting, hash-chain inclusion, signed viewing.

Reuses the in-memory DynamoDB/Step Functions fakes from test_api_trust; S3 is a small fake here.
"""

import hashlib
import io
import json
import unittest
from unittest import mock

import test_api_trust as T
from test_api_trust import api, ClientError, DONOR, RECV, COORD

JPEG = b"\xff\xd8\xff\xe0" + b"jfif-bytes" * 20
PNG = b"\x89PNG\r\n\x1a\n" + b"png-bytes" * 20
WEBP = b"RIFF\x24\x00\x00\x00WEBPVP8 " + b"x" * 20


class FakeS3:
    def __init__(self):
        self.objects = {}
        self.posts = []

    def put(self, key, data):
        self.objects[key] = data

    def head_object(self, Bucket, Key):
        if Key not in self.objects:
            raise ClientError({"Error": {"Code": "404", "Message": "Not Found"}}, "HeadObject")
        return {"ContentLength": len(self.objects[Key])}

    def get_object(self, Bucket, Key):
        if Key not in self.objects:
            raise ClientError({"Error": {"Code": "NoSuchKey", "Message": "missing"}}, "GetObject")
        return {"Body": io.BytesIO(self.objects[Key])}

    def generate_presigned_post(self, **kw):
        self.posts.append(kw)
        return {"url": "https://bkt.s3.ap-south-1.amazonaws.com/", "fields": dict(kw["Fields"], key=kw["Key"], policy="p")}

    def generate_presigned_url(self, op, Params, ExpiresIn):
        return "https://signed.example/%s?exp=%d" % (Params["Key"], ExpiresIn)


class PhotoHelperTest(unittest.TestCase):
    def test_key_must_match_lot_kind_and_shape(self):
        k = "lots/lot-abc123/handoff-" + "a" * 32 + ".jpg"
        self.assertTrue(api.photo_key_ok("lot-abc123", "handoff", k))
        self.assertFalse(api.photo_key_ok("lot-other", "handoff", k))        # another lot
        self.assertFalse(api.photo_key_ok("lot-abc123", "receipt", k))       # the other step
        for bad in ("lots/lot-abc123/handoff-" + "a" * 32 + ".gif", "lots/lot-abc123/../x/handoff-" + "a" * 32 + ".jpg",
                    "lots/lot-abc123/handoff-short.jpg", "/etc/passwd", "", None, 5):
            self.assertFalse(api.photo_key_ok("lot-abc123", "handoff", bad), bad)

    def test_magic_bytes(self):
        for good in (JPEG, PNG, WEBP):
            self.assertTrue(api.looks_like_image(good))
        for bad in (b"<html>", b"", b"GIF89a", b"%PDF-1.7"):
            self.assertFalse(api.looks_like_image(bad))


class PhotoApiTest(unittest.TestCase):
    setUp_trust = T.TrustApiTest.setUp
    call = T.TrustApiTest.__dict__["call"]
    create = T.TrustApiTest.create
    accept = T.TrustApiTest.accept
    verify = T.TrustApiTest.verify
    stored_events = T.TrustApiTest.stored_events
    event_results = T.TrustApiTest.event_results

    def setUp(self):
        self.setUp_trust()
        self.s3 = FakeS3()
        for p in (mock.patch.object(api, "s3_client", lambda: self.s3), mock.patch.object(api, "PHOTOS_BUCKET", "bkt")):
            p.start()
            self.addCleanup(p.stop)

    def key(self, lot_id, kind="handoff", ext="jpg", n="a"):
        return "lots/%s/%s-%s.%s" % (lot_id, kind, n * 32, ext)

    def handoff(self, lot_id, photo_key=None, idem="hand-1", version=2):
        body = {"idem_key": idem, "expected_version": version, "donor_handoff": 10}
        if photo_key:
            body["photo_key"] = photo_key
        return self.call(api.h_handoff(lot_id, DONOR, "donor", body, "rq-h"))

    def receipt(self, lot_id, code, photo_key=None, idem="rec-1", version=3, received=8):
        body = {"idem_key": idem, "expected_version": version, "received": received, "pickup_code": code}
        if photo_key:
            body["photo_key"] = photo_key
        return self.call(api.h_receipt(lot_id, RECV, "receiver", body, "rq-r"))

    def upload(self, lot_id, sub, role, kind="handoff", ctype="image/jpeg"):
        return self.call(api.h_photo_upload(lot_id, sub, role, {"kind": kind, "content_type": ctype}, "rq-u"))

    # ---------------------------------------------------------------- upload route
    def test_upload_hands_out_a_scoped_size_limited_post(self):
        lot_id = self.create(10)
        self.assertEqual(self.accept(lot_id)[0], 200)
        st, body = self.upload(lot_id, DONOR, "donor")
        self.assertEqual(st, 200, body)
        self.assertTrue(api.photo_key_ok(lot_id, "handoff", body["key"]), body["key"])
        self.assertEqual(body["max_bytes"], 5 * 1024 * 1024)
        post = self.s3.posts[0]
        self.assertIn(["content-length-range", 1, 5 * 1024 * 1024], post["Conditions"])
        self.assertIn({"Content-Type": "image/jpeg"}, post["Conditions"])
        self.assertLessEqual(post["ExpiresIn"], 300)

    def test_upload_validation_and_policy(self):
        lot_id = self.create(10)
        self.accept(lot_id)
        self.assertEqual(self.upload(lot_id, DONOR, "donor", kind="selfie")[0], 400)
        self.assertEqual(self.upload(lot_id, DONOR, "donor", ctype="image/gif")[0], 400)
        self.assertEqual(self.upload("lot-000000000000", DONOR, "donor")[0], 404)
        # a receipt photo is not allowed while the lot is only ACCEPTED
        self.assertEqual(self.upload(lot_id, RECV, "receiver", kind="receipt")[0], 409)
        # the policy engine decides who may add the photo
        self.vp.return_value = False
        st, body = self.upload(lot_id, RECV, "receiver", kind="handoff")
        self.assertEqual((st, body["error"]), (403, "VP_DENY"))
        self.assertEqual(self.s3.posts, [])

    def test_upload_needs_storage_configured(self):
        lot_id = self.create(10)
        self.accept(lot_id)
        with mock.patch.object(api, "PHOTOS_BUCKET", ""):
            self.assertEqual(self.upload(lot_id, DONOR, "donor")[0], 503)

    # ------------------------------------------------------------ commit with photo
    def test_handoff_photo_is_fingerprinted_into_the_hash_chain(self):
        lot_id = self.create(10)
        self.accept(lot_id)
        key = self.key(lot_id)
        self.s3.put(key, JPEG)
        st, body = self.handoff(lot_id, key)
        self.assertEqual(st, 200, body)
        sha = hashlib.sha256(JPEG).hexdigest()
        self.assertEqual((body["photo_key"], body["photo_sha256"], body["photo_bytes"]), (key, sha, len(JPEG)))
        lot = self.call(api.h_get(lot_id, DONOR, "donor", "rq-g"))[1]["lot"]
        self.assertEqual((lot["handoff_photo_key"], lot["handoff_photo_sha256"]), (key, sha))
        self.assertTrue(self.verify(lot_id)["ok"])
        # the digest is inside the chained event: change it and Verify fails
        ev = next(e for e in self.stored_events(lot_id) if e.get("action", {}).get("S") == "DeclareHandoff")
        stored = self.ddb.events[(lot_id, ev["event_id"]["S"])]
        res = json.loads(stored["result"]["S"])
        res["photo_sha256"] = "0" * 64
        stored["result"]["S"] = json.dumps(res)
        self.assertFalse(self.verify(lot_id)["ok"])

    def test_handoff_photo_replay_is_idempotent(self):
        lot_id = self.create(10)
        self.accept(lot_id)
        key = self.key(lot_id)
        self.s3.put(key, PNG)
        first = self.handoff(lot_id, key)
        again = self.handoff(lot_id, key)
        self.assertEqual(first[0], 200)
        self.assertEqual(again[0], 200)
        self.assertEqual(again[1]["photo_sha256"], first[1]["photo_sha256"])
        self.assertNotIn("pickup_code", again[1])

    def test_bad_photo_keys_are_refused_and_nothing_is_committed(self):
        lot_id = self.create(10)
        self.accept(lot_id)
        other = "lot-ffffffffffff"
        cases = {
            "wrong lot": self.key(other),
            "wrong step": self.key(lot_id, kind="receipt"),
            "missing object": self.key(lot_id, n="b"),
            "malformed": "lots/../../etc/passwd",
        }
        self.s3.put(self.key(other), JPEG)
        self.s3.put(self.key(lot_id, kind="receipt"), JPEG)
        for label, k in cases.items():
            st, body = self.handoff(lot_id, k, idem="hand-" + label.replace(" ", "-"))
            self.assertEqual(st, 409, (label, body))
        self.s3.put(self.key(lot_id, n="c"), b"<html>not an image</html>")
        self.assertEqual(self.handoff(lot_id, self.key(lot_id, n="c"), idem="hand-html")[0], 409)
        self.s3.put(self.key(lot_id, n="d"), JPEG * 50000)  # larger than 5 MB
        self.assertEqual(self.handoff(lot_id, self.key(lot_id, n="d"), idem="hand-big")[0], 409)
        self.assertEqual(self.ddb.lots[lot_id]["stage"]["S"], "ACCEPTED")        # still open: a clean retry works
        self.assertEqual(self.handoff(lot_id, idem="hand-clean")[0], 200)

    def test_receipt_photo_and_the_viewing_route(self):
        lot_id = self.create(10)
        self.accept(lot_id)
        hk, rk = self.key(lot_id), self.key(lot_id, kind="receipt", n="e")
        self.s3.put(hk, JPEG)
        self.s3.put(rk, WEBP)
        code = self.handoff(lot_id, hk)[1]["pickup_code"]
        st, body = self.receipt(lot_id, code, rk)
        self.assertEqual(st, 200, body)
        self.assertTrue(body["count_dispute"])
        self.assertEqual(body["photo_sha256"], hashlib.sha256(WEBP).hexdigest())
        self.assertTrue(self.verify(lot_id)["ok"])

        view = lambda sub, role, key: self.call(api.h_photo(lot_id, sub, role, {"key": key}, "rq-v"))
        for sub, role in ((DONOR, "donor"), (RECV, "receiver"), (COORD, "coordinator")):
            st, out = view(sub, role, hk)
            self.assertEqual(st, 200, (role, out))
            self.assertIn(hk, out["url"])
            self.assertLessEqual(out["expires_in"], 300)
        self.assertEqual(view("stranger", "donor", hk)[0], 403)               # not on the lot
        self.s3.put(self.key(lot_id, n="f"), JPEG)                            # in the bucket, but never recorded
        self.assertEqual(view(COORD, "coordinator", self.key(lot_id, n="f"))[0], 404)
        self.assertEqual(view(COORD, "coordinator", None)[0], 404)


if __name__ == "__main__":
    unittest.main()
