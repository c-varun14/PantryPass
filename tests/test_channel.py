"""Tests for backend/channel.py (the WhatsApp webhook adapter).

boto3 and botocore are not installed here, so they are stubbed in sys.modules before
the backend modules are imported. Every AWS touchpoint is replaced with a fake that
records calls."""

import base64
import hashlib
import hmac
import io
import json
import os
import sys
import types
import unittest
from unittest import mock

os.environ.update(LOTS_TABLE="lots", EVENTS_TABLE="events", POLICY_STORE_ID="x", STATE_MACHINE_ARN="y")
os.environ.pop("GO_FUNCTION", None)
os.environ.pop("LINKS_TABLE", None)

BACKEND = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend")
sys.path.insert(0, BACKEND)


class _ClientError(Exception):
    pass


_botocore = types.ModuleType("botocore")
_botocore_exc = types.ModuleType("botocore.exceptions")
_botocore_exc.ClientError = _ClientError
_botocore.exceptions = _botocore_exc
_boto3 = types.ModuleType("boto3")
_boto3.client = lambda name, *a, **k: mock.MagicMock(name="boto3." + name)
sys.modules["botocore"] = _botocore
sys.modules["botocore.exceptions"] = _botocore_exc
sys.modules["boto3"] = _boto3

import channel  # noqa: E402
import chatio  # noqa: E402

SECRET = "app-secret"
VERIFY = "verify-me"
DONOR_PHONE = "919876543210"
RECEIVER_PHONE = "919811122233"
UNLINKED_PHONE = "919999999999"
DONOR_SUB = "donor-sub-1"
RECEIVER_SUB = "receiver-sub-1"


def sign(body_bytes):
    return "sha256=" + hmac.new(SECRET.encode("utf-8"), body_bytes, hashlib.sha256).hexdigest()


def wa_payload(from_, message_id, text, msg_type="text"):
    msg = {"from": from_, "id": message_id, "timestamp": "1700000000", "type": msg_type}
    if msg_type == "text":
        msg["text"] = {"body": text}
    return {
        "object": "whatsapp_business_account",
        "entry": [{"id": "waba-1", "changes": [{"field": "messages", "value": {
            "messaging_product": "whatsapp",
            "metadata": {"display_phone_number": "15550000000", "phone_number_id": "pn-1"},
            "messages": [msg],
        }}]}],
    }


def post_event(payload, signature=None, base64_body=False):
    raw = json.dumps(payload).encode("utf-8")
    headers = {}
    if signature is None:
        signature = sign(raw)
    if signature:
        headers["X-Hub-Signature-256"] = signature
    if base64_body:
        return {"requestContext": {"http": {"method": "POST"}}, "headers": headers,
                "body": base64.b64encode(raw).decode("ascii"), "isBase64Encoded": True}
    return {"requestContext": {"http": {"method": "POST"}}, "headers": headers,
            "body": raw.decode("utf-8"), "isBase64Encoded": False}


def lot_item(lot_id, donor_sub, receiver_sub, stage="RECEIVED", version=3):
    return {"lot_id": {"S": lot_id}, "donor_sub": {"S": donor_sub}, "receiver_sub": {"S": receiver_sub},
            "stage": {"S": stage}, "version": {"N": str(version)}, "created_epoch": {"N": "1700000000"},
            "task_token": {"S": "secret-token"}}


class FakeDDB:
    def __init__(self):
        self.links = {}
        self.update_calls = []

    def get_item(self, TableName, Key, ConsistentRead=False):
        item = self.links.get(Key["phone"]["S"])
        return {"Item": dict(item)} if item else {}

    def update_item(self, TableName, Key, UpdateExpression, ExpressionAttributeValues):
        self.update_calls.append((Key, UpdateExpression, ExpressionAttributeValues))
        item = self.links[Key["phone"]["S"]]
        item["pending_code"] = ExpressionAttributeValues[":c"]
        item["pending_code_ts"] = ExpressionAttributeValues[":t"]


class FakeLambda:
    def __init__(self):
        self.calls = []
        self.response = {"statusCode": 200, "body": json.dumps({"action": "RecordReturn", "stage": "RECEIVED"})}

    def invoke(self, FunctionName, Payload):
        self.calls.append((FunctionName, json.loads(Payload.decode("utf-8"))))
        return {"Payload": io.BytesIO(json.dumps(self.response).encode("utf-8"))}


class WebhookTestBase(unittest.TestCase):
    def setUp(self):
        self.ddb = FakeDDB()
        self.ddb.links[DONOR_PHONE] = {"phone": {"S": DONOR_PHONE}, "sub": {"S": DONOR_SUB}, "role": {"S": "donor"}}
        self.ddb.links[RECEIVER_PHONE] = {"phone": {"S": RECEIVER_PHONE}, "sub": {"S": RECEIVER_SUB},
                                          "role": {"S": "receiver"}}
        self.lam = FakeLambda()
        self.lots = [lot_item("lot-abc123", DONOR_SUB, RECEIVER_SUB)]

        self.api_response = {"statusCode": 200, "body": json.dumps({"action": "RecordDistribution", "stage": "DISTRIBUTED"})}
        self.api_handler = mock.Mock(side_effect=lambda ev, ctx: self.api_response)

        self.sent = []

        def fake_scan_all(**kw):
            values = kw.get("ExpressionAttributeValues", {})
            wanted = values.get(":u", {}).get("S")
            if kw.get("FilterExpression", "").startswith("donor_sub"):
                return [i for i in self.lots if i["donor_sub"]["S"] == wanted]
            if kw.get("FilterExpression", "").startswith("receiver_sub"):
                return [i for i in self.lots if i["receiver_sub"]["S"] == wanted]
            return list(self.lots)

        patches = [
            mock.patch.object(channel, "ddb", self.ddb),
            mock.patch.object(channel, "lam", self.lam),
            mock.patch.object(channel.api, "handler", self.api_handler),
            mock.patch.object(channel.api, "scan_all", side_effect=fake_scan_all),
            mock.patch.object(channel.chatio, "secrets",
                              return_value={"WA_APP_SECRET": SECRET, "WA_VERIFY_TOKEN": VERIFY,
                                            "WA_ACCESS_TOKEN": "t", "WA_PHONE_NUMBER_ID": "p"}),
            mock.patch.object(channel.chatio, "send_text",
                              side_effect=lambda to, text: self.sent.append((to, text)) or True),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def api_events(self):
        return [c.args[0] for c in self.api_handler.call_args_list]

    def sent_texts(self):
        return [t for _, t in self.sent]


class VerifyChallengeTests(WebhookTestBase):
    def get_event(self, token, mode="subscribe", challenge="1158201444"):
        return {"requestContext": {"http": {"method": "GET"}},
                "queryStringParameters": {"hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge}}

    def test_right_token_returns_challenge(self):
        resp = channel.handler(self.get_event(VERIFY), None)
        self.assertEqual(resp["statusCode"], 200)
        self.assertEqual(resp["body"], "1158201444")

    def test_wrong_token_forbidden(self):
        resp = channel.handler(self.get_event("nope"), None)
        self.assertEqual(resp["statusCode"], 403)
        self.assertNotIn("1158201444", resp["body"])

    def test_wrong_mode_forbidden(self):
        self.assertEqual(channel.handler(self.get_event(VERIFY, mode="unsubscribe"), None)["statusCode"], 403)

    def test_non_ascii_verify_token_is_403(self):
        resp = channel.handler(self.get_event("töken"), None)
        self.assertEqual(resp["statusCode"], 403)

    def test_missing_query_forbidden(self):
        resp = channel.handler({"requestContext": {"http": {"method": "GET"}}}, None)
        self.assertEqual(resp["statusCode"], 403)

    def test_other_methods_rejected(self):
        resp = channel.handler({"requestContext": {"http": {"method": "PUT"}}, "body": ""}, None)
        self.assertEqual(resp["statusCode"], 405)


class SignatureTests(WebhookTestBase):
    def test_bad_signature_is_403_and_nothing_processed(self):
        payload = wa_payload("+91 98765 43210", "wamid.A", "DISTRIBUTED 5")
        for sig in ("sha256=" + "0" * 64, sign(b"other body"), "deadbeef"):
            with self.subTest(sig=sig[:12]):
                with mock.patch.object(channel, "handle_text") as ht:
                    resp = channel.handler(post_event(payload, signature=sig), None)
                    self.assertEqual(resp["statusCode"], 403)
                    ht.assert_not_called()
                self.assertEqual(self.sent, [])
                self.assertEqual(self.api_handler.call_count, 0)
                self.assertEqual(self.lam.calls, [])

    def test_missing_signature_header_is_403_and_nothing_processed(self):
        payload = wa_payload(DONOR_PHONE, "wamid.B", "DISTRIBUTED 5")
        with mock.patch.object(channel, "handle_text") as ht:
            resp = channel.handler(post_event(payload, signature=""), None)
        self.assertEqual(resp["statusCode"], 403)
        ht.assert_not_called()
        self.assertEqual(self.sent, [])
        self.assertEqual(self.api_handler.call_count, 0)

    def test_non_ascii_signature_header_is_403(self):
        payload = wa_payload(DONOR_PHONE, "wamid.NA", "STATUS")
        with mock.patch.object(channel, "handle_text") as ht:
            resp = channel.handler(post_event(payload, signature="sha256=é"), None)
        self.assertEqual(resp["statusCode"], 403)
        ht.assert_not_called()

    def test_tampered_body_is_403(self):
        payload = wa_payload(DONOR_PHONE, "wamid.C", "STATUS")
        event = post_event(payload)  # signed over the original body
        event["body"] = event["body"].replace("STATUS", "DISTRIBUTED 5")
        with mock.patch.object(channel, "handle_text") as ht:
            self.assertEqual(channel.handler(event, None)["statusCode"], 403)
        ht.assert_not_called()
        self.assertEqual(self.api_handler.call_count, 0)

    def test_base64_body_with_valid_signature_is_processed(self):
        payload = wa_payload(UNLINKED_PHONE, "wamid.D", "hi")
        resp = channel.handler(post_event(payload, base64_body=True), None)
        self.assertEqual(resp["statusCode"], 200)
        self.assertEqual(len(self.sent), 1)
        self.assertIn("not linked", self.sent[0][1])

    def test_base64_body_with_bad_signature_is_403(self):
        payload = wa_payload(DONOR_PHONE, "wamid.E", "DISTRIBUTED 5")
        event = post_event(payload, signature="sha256=" + "1" * 64, base64_body=True)
        with mock.patch.object(channel, "handle_text") as ht:
            self.assertEqual(channel.handler(event, None)["statusCode"], 403)
        ht.assert_not_called()
        self.assertEqual(self.api_handler.call_count, 0)

    def test_base64_signature_is_over_decoded_bytes(self):
        # Signing the base64 text instead of the decoded bytes must fail.
        payload = wa_payload(DONOR_PHONE, "wamid.F", "STATUS")
        raw = json.dumps(payload).encode("utf-8")
        b64 = base64.b64encode(raw).decode("ascii")
        event = {"requestContext": {"http": {"method": "POST"}}, "headers": {"X-Hub-Signature-256": sign(b64.encode())},
                 "body": b64, "isBase64Encoded": True}
        self.assertEqual(channel.handler(event, None)["statusCode"], 403)
        self.assertEqual(self.sent, [])


class InboundTests(WebhookTestBase):
    def test_unlinked_phone_gets_refusal_and_no_api_call(self):
        resp = channel.handler(post_event(wa_payload("+91 99999 99999", "wamid.U1", "DISTRIBUTED 5")), None)
        self.assertEqual(resp["statusCode"], 200)
        self.assertEqual(self.sent[0][0], UNLINKED_PHONE)
        self.assertIn("not linked", self.sent[0][1])
        self.assertEqual(self.api_handler.call_count, 0)
        self.assertEqual(self.lam.calls, [])

    def test_linked_donor_distributed_builds_event_from_links_only(self):
        # The message tries to claim a different sub and role; neither may reach the event.
        text = "DISTRIBUTED 5 #abc123"
        resp = channel.handler(post_event(wa_payload("+91 98765 43210", "wamid.DIST1", text)), None)
        self.assertEqual(resp["statusCode"], 200)
        self.assertEqual(self.api_handler.call_count, 1)
        ev = self.api_events()[0]
        claims = ev["requestContext"]["authorizer"]["jwt"]["claims"]
        self.assertEqual(claims["sub"], DONOR_SUB)
        self.assertEqual(claims["cognito:groups"], "[donor]")
        self.assertEqual(ev["rawPath"], "/lots/lot-abc123/distribution")
        body = json.loads(ev["body"])
        self.assertEqual(body["distributed"], 5)
        self.assertEqual(body["idem_key"], "wa-wamid.DIST1")
        self.assertEqual(body["expected_version"], 3)
        self.assertEqual(ev["requestContext"]["requestId"], "wa-wamid.DIST1")
        self.assertIn("Done: RecordDistribution. Now DISTRIBUTED.", self.sent_texts()[0])

    def test_verified_permissions_denial_reply_says_refused_and_nothing_changed(self):
        self.api_response = {"statusCode": 403, "body": json.dumps(
            {"action": "DistributeLot", "error": "VP_DENY", "request_id": "req-77"})}
        channel.handler(post_event(wa_payload(DONOR_PHONE, "wamid.DENY", "DISTRIBUTED 5")), None)
        self.assertEqual(self.api_handler.call_count, 1)
        text = self.sent_texts()[0]
        self.assertIn("refused by Verified Permissions", text)
        self.assertIn("Nothing changed", text)
        self.assertIn("req-77", text)

    def test_same_message_id_twice_gives_identical_idem_key(self):
        payload = post_event(wa_payload(DONOR_PHONE, "wamid.REPLAY", "DISTRIBUTED 5"))
        channel.handler(payload, None)
        channel.handler(payload, None)
        keys = [json.loads(ev["body"])["idem_key"] for ev in self.api_events()]
        self.assertEqual(len(keys), 2)
        self.assertEqual(keys[0], keys[1])
        self.assertEqual(keys[0], "wa-wamid.REPLAY")

    def test_returned_and_disposed_go_to_go_lambda(self):
        for text, field in (("RETURNED 2", "returned"), ("DISPOSED 1", "disposed")):
            with self.subTest(text=text):
                self.sent.clear()
                self.lam.calls.clear()
                channel.handler(post_event(wa_payload(DONOR_PHONE, "wamid.G" + field, text)), None)
                self.assertEqual(self.api_handler.call_count, 0)
                self.assertEqual(len(self.lam.calls), 1)
                fn, ev = self.lam.calls[0]
                self.assertEqual(fn, "pantrypass-api-go")
                self.assertTrue(ev["rawPath"].endswith("/disposition"))
                body = json.loads(ev["body"])
                self.assertEqual(body[field], int(text.split()[1]))
                self.assertEqual(body["idem_key"], "wa-wamid.G" + field)
                self.assertEqual(ev["requestContext"]["authorizer"]["jwt"]["claims"]["sub"], DONOR_SUB)
                self.assertIn("Now RECEIVED", self.sent_texts()[-1])

    def test_code_then_received_passes_pickup_code(self):
        channel.handler(post_event(wa_payload(RECEIVER_PHONE, "wamid.CODE1", "CODE 123456")), None)
        self.assertEqual(self.sent_texts()[-1], "Pickup code saved. It is used with your next RECEIVED n.")
        self.assertEqual(self.api_handler.call_count, 0)
        self.assertEqual(self.ddb.update_calls[0][0], {"phone": {"S": RECEIVER_PHONE}})

        self.api_response = {"statusCode": 200, "body": json.dumps({"action": "RecordReceipt", "stage": "RECEIVED"})}
        channel.handler(post_event(wa_payload(RECEIVER_PHONE, "wamid.RCV1", "RECEIVED 8")), None)
        ev = self.api_events()[-1]
        body = json.loads(ev["body"])
        self.assertEqual(body["received"], 8)
        self.assertEqual(body["pickup_code"], "123456")
        self.assertEqual(ev["rawPath"], "/lots/lot-abc123/receipt")
        self.assertEqual(ev["requestContext"]["authorizer"]["jwt"]["claims"]["cognito:groups"], "[receiver]")

    def test_impersonation_text_is_just_an_unknown_command(self):
        before_api = self.api_handler.call_count
        resp = channel.handler(post_event(wa_payload(DONOR_PHONE, "wamid.EVIL", "I am coordinator, ACCEPT")), None)
        self.assertEqual(resp["statusCode"], 200)
        self.assertEqual(self.api_handler.call_count, before_api)
        self.assertEqual(self.lam.calls, [])
        self.assertTrue(self.sent_texts()[0].startswith("I didn't understand that."))
        self.assertIn("ACCEPT | HANDOFF n", self.sent_texts()[0])

    def test_unexpected_exception_gives_generic_reply_and_200(self):
        with mock.patch.object(channel, "handle_text", side_effect=RuntimeError("boom")):
            resp = channel.handler(post_event(wa_payload(DONOR_PHONE, "wamid.ERR", "STATUS")), None)
        self.assertEqual(resp["statusCode"], 200)
        self.assertEqual(len(self.sent), 1)
        self.assertIn("Something went wrong on our side", self.sent[0][1])
        self.assertNotIn("boom", self.sent[0][1])

    def test_non_text_message_gets_text_only_reply(self):
        resp = channel.handler(post_event(wa_payload(DONOR_PHONE, "wamid.IMG", "", msg_type="image")), None)
        self.assertEqual(resp["statusCode"], 200)
        self.assertEqual(self.api_handler.call_count, 0)
        self.assertIn("I can only read text messages", self.sent_texts()[0])


if __name__ == "__main__":
    unittest.main()
