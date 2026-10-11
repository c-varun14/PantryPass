"""Twilio WhatsApp adapter: signature check, form parsing, and the same guards as the web."""
import base64, hashlib, hmac, json, os, sys, types, unittest
from urllib.parse import urlencode

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
fake_boto3 = types.ModuleType("boto3"); fake_boto3.client = lambda *a, **k: object()
fake_bc = types.ModuleType("botocore"); fake_exc = types.ModuleType("botocore.exceptions")
class ClientError(Exception):
    def __init__(self, resp=None, op=None): self.response = resp or {}
fake_exc.ClientError = ClientError
for _n, _m in (("boto3", fake_boto3), ("botocore", fake_bc), ("botocore.exceptions", fake_exc)):
    sys.modules.setdefault(_n, _m)
for _k, _v in dict(LOTS_TABLE="lots", EVENTS_TABLE="events", POLICY_STORE_ID="x", STATE_MACHINE_ARN="y").items():
    os.environ.setdefault(_k, _v)
import chatlogic as cl  # noqa: E402
import channel  # noqa: E402

TOKEN = "tw-token"
URL = "https://example.execute-api.ap-south-1.amazonaws.com/webhook/whatsapp"


def sign(params, url=URL, token=TOKEN):
    return cl.twilio_signature(token, url, params)


def event(params, signature, url_domain="example.execute-api.ap-south-1.amazonaws.com"):
    return {"requestContext": {"http": {"method": "POST"}, "domainName": url_domain},
            "rawPath": "/webhook/whatsapp", "headers": {"X-Twilio-Signature": signature},
            "body": urlencode(params), "isBase64Encoded": False}


class SigTests(unittest.TestCase):
    def test_signature_is_documented_algorithm(self):
        p = {"b": "2", "a": "1"}
        want = base64.b64encode(hmac.new(b"k", (URL + "a1b2").encode(), hashlib.sha1).digest()).decode()
        self.assertEqual(cl.twilio_signature("k", URL, p), want)

    def test_verify_accepts_and_rejects(self):
        p = {"From": "whatsapp:+919800000001", "Body": "HELP"}
        s = sign(p)
        self.assertTrue(cl.verify_twilio(TOKEN, URL, p, s))
        self.assertFalse(cl.verify_twilio(TOKEN, URL, dict(p, Body="CLOSE"), s))
        self.assertFalse(cl.verify_twilio("other", URL, p, s))
        self.assertFalse(cl.verify_twilio(TOKEN, URL + "x", p, s))
        self.assertFalse(cl.verify_twilio(TOKEN, URL, p, ""))
        self.assertFalse(cl.verify_twilio(TOKEN, URL, p, "é"))
        self.assertFalse(cl.verify_twilio("", URL, p, s))

    def test_parse_form(self):
        self.assertEqual(cl.parse_form(b"Body=DISTRIBUTED+5&From=whatsapp%3A%2B91980"), {"Body": "DISTRIBUTED 5", "From": "whatsapp:+91980"})
        self.assertEqual(cl.parse_form(b"\xff\xfe"), {})


class HandlerTests(unittest.TestCase):
    def setUp(self):
        self.saved = (channel.chatio.secrets, channel.chatio.send_text, channel.handle_text, os.environ.get("CHANNEL_TRANSPORT"))
        os.environ["CHANNEL_TRANSPORT"] = "twilio"
        self.sent, self.calls = [], []
        channel.chatio.secrets = lambda: {"TWILIO_AUTH_TOKEN": TOKEN}
        channel.chatio.send_text = lambda to, text: self.sent.append((to, text)) or True
        def fake_text(phone, mid, text):
            self.calls.append((phone, mid, text)); return "ok:" + text
        channel.handle_text = fake_text

    def tearDown(self):
        channel.chatio.secrets, channel.chatio.send_text, channel.handle_text, old = self.saved
        if old is None:
            os.environ.pop("CHANNEL_TRANSPORT", None)
        else:
            os.environ["CHANNEL_TRANSPORT"] = old

    def test_bad_signature_is_rejected_and_nothing_processed(self):
        p = {"From": "whatsapp:+919800000001", "MessageSid": "SM1", "Body": "DISTRIBUTED 5"}
        r = channel.handler(event(p, "AAAA"), None)
        self.assertEqual(r["statusCode"], 403)
        self.assertEqual((self.calls, self.sent), ([], []))

    def test_missing_signature_header_is_rejected(self):
        ev = event({"Body": "x"}, "")
        ev["headers"] = {}
        self.assertEqual(channel.handler(ev, None)["statusCode"], 403)

    def test_valid_message_uses_sid_as_message_id_and_digits_phone(self):
        p = {"From": "whatsapp:+919800000001", "MessageSid": "SMabc", "Body": "STATUS"}
        r = channel.handler(event(p, sign(p)), None)
        self.assertEqual(r["statusCode"], 200)
        self.assertEqual(self.calls, [("919800000001", "SMabc", "STATUS")])
        self.assertEqual(self.sent, [("919800000001", "ok:STATUS")])

    def test_same_sid_redelivered_keeps_same_idempotency_id(self):
        p = {"From": "whatsapp:+919800000001", "MessageSid": "SMdup", "Body": "RECEIVED 8"}
        channel.handler(event(p, sign(p)), None); channel.handler(event(p, sign(p)), None)
        self.assertEqual({c[1] for c in self.calls}, {"SMdup"})

    def test_signature_uses_configured_webhook_url(self):
        os.environ["WEBHOOK_URL"] = "https://custom.example/webhook/whatsapp"
        try:
            p = {"From": "whatsapp:+919800000001", "MessageSid": "SM2", "Body": "HELP"}
            ok = channel.handler(event(p, sign(p, "https://custom.example/webhook/whatsapp")), None)
            bad = channel.handler(event(p, sign(p)), None)
            self.assertEqual((ok["statusCode"], bad["statusCode"]), (200, 403))
        finally:
            del os.environ["WEBHOOK_URL"]

    def test_get_is_harmless(self):
        r = channel.handler({"requestContext": {"http": {"method": "GET"}}}, None)
        self.assertEqual(r["statusCode"], 200)

    def test_exception_in_handling_still_returns_200_with_generic_reply(self):
        def boom(*a): raise RuntimeError("x")
        channel.handle_text = boom
        p = {"From": "whatsapp:+919800000001", "MessageSid": "SM3", "Body": "HELP"}
        self.assertEqual(channel.handler(event(p, sign(p)), None)["statusCode"], 200)
        self.assertIn("went wrong", self.sent[-1][1])


if __name__ == "__main__":
    unittest.main()
