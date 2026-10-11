#!/usr/bin/env python3
"""Live check of photo evidence against the deployed stack. Signs in as the three demo users with DEMO_PASSWORD
(it does NOT change any password), runs one lot with a handoff photo and a count photo, and prints PASS/FAIL.

    source infra/00_env.sh && export DEMO_PASSWORD=... && python3 tests/live_photos.py
"""
import hashlib, json, os, struct, subprocess, sys, urllib.error, urllib.request, uuid, zlib

API = os.environ["API_URL"]
CLIENT = os.environ["COGNITO_CLIENT_ID"]
PW = os.environ["DEMO_PASSWORD"]
fails = 0


def check(name, ok, detail=""):
    global fails
    fails += 0 if ok else 1
    print("%s | %s %s" % ("PASS" if ok else "FAIL", name, str(detail)[:200] if detail else ""))


def token(user):
    out = subprocess.run(["aws", "cognito-idp", "initiate-auth", "--auth-flow", "USER_PASSWORD_AUTH", "--client-id", CLIENT,
                          "--auth-parameters", "USERNAME=%s,PASSWORD=%s" % (user, PW), "--query", "AuthenticationResult.IdToken",
                          "--output", "text"], capture_output=True, text=True)
    if out.returncode:
        sys.exit("sign-in failed for %s (is DEMO_PASSWORD current? run infra/25_demo_passwords.sh)" % user)
    return out.stdout.strip()


def call(method, path, tok, body=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def png(w, h, rgb):
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def s3_post(upload, data, ctype):
    b = uuid.uuid4().hex
    parts = b"".join(('--%s\r\nContent-Disposition: form-data; name="%s"\r\n\r\n%s\r\n' % (b, k, v)).encode() for k, v in upload["fields"].items())
    parts += ('--%s\r\nContent-Disposition: form-data; name="file"; filename="p"\r\nContent-Type: %s\r\n\r\n' % (b, ctype)).encode() + data + ("\r\n--%s--\r\n" % b).encode()
    req = urllib.request.Request(upload["url"], method="POST", data=parts, headers={"Content-Type": "multipart/form-data; boundary=" + b})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


donor, recv, coord = token("donor1"), token("receiver1"), token("coordinator1")
rsub = json.loads(__import__("base64").urlsafe_b64decode(recv.split(".")[1] + "==")).get("sub")
st, lot = call("POST", "/lots", donor, {"receiver_sub": rsub, "offered": 10})
check("create lot", st == 201, lot)
lid = lot["lot"]["lot_id"]
st, a = call("POST", "/lots/%s/accept" % lid, recv, {"idem_key": "a-" + lid, "expected_version": 1})
check("accept", st == 200, a)

# the receiver may not add the donor's handoff photo; the donor may
st, d = call("POST", "/lots/%s/photo-upload" % lid, recv, {"kind": "handoff", "content_type": "image/png"})
check("receiver cannot add the donor's photo", st == 403, d)
st, up = call("POST", "/lots/%s/photo-upload" % lid, donor, {"kind": "handoff", "content_type": "image/png"})
check("donor gets a presigned upload", st == 200 and "upload" in up, up)
img1 = png(64, 48, (30, 120, 200))
check("upload to S3 with the presigned form", s3_post(up["upload"], img1, "image/png") in (200, 201, 204))
# a second form must refuse an oversized object (content-length-range)
st, up_big = call("POST", "/lots/%s/photo-upload" % lid, donor, {"kind": "handoff", "content_type": "image/png"})
check("oversized upload is refused by S3 (EntityTooLarge)", s3_post(up_big["upload"], b"\x89PNG\r\n\x1a\n" + b"0" * (5 * 1024 * 1024 + 10), "image/png") == 400)

st, h = call("POST", "/lots/%s/handoff" % lid, donor, {"idem_key": "h-" + lid, "expected_version": 2, "donor_handoff": 10, "photo_key": up["key"]})
check("handoff with photo", st == 200 and h.get("photo_sha256") == hashlib.sha256(img1).hexdigest(), h)
code = h.get("pickup_code")

st, bad = call("POST", "/lots/%s/receipt" % lid, recv, {"idem_key": "rb-" + lid, "expected_version": 3, "received": 8, "pickup_code": code, "photo_key": up["key"]})
check("a handoff photo cannot be reused as the count photo", st == 409, bad)
st, up2 = call("POST", "/lots/%s/photo-upload" % lid, recv, {"kind": "receipt", "content_type": "image/png"})
img2 = png(64, 48, (200, 90, 40))
check("receiver uploads the count photo", st == 200 and s3_post(up2["upload"], img2, "image/png") in (200, 201, 204), up2)
st, r = call("POST", "/lots/%s/receipt" % lid, recv, {"idem_key": "r-" + lid, "expected_version": 3, "received": 8, "pickup_code": code, "photo_key": up2["key"]})
check("receipt with photo flags the mismatch", st == 200 and r.get("count_dispute") is True and r.get("photo_sha256") == hashlib.sha256(img2).hexdigest(), r)

st, g = call("GET", "/lots/%s" % lid, coord)
L = g.get("lot", {})
check("coordinator sees both photo keys", L.get("handoff_photo_key") == up["key"] and L.get("receipt_photo_key") == up2["key"], L)
for name, key, img in (("handoff", up["key"], img1), ("receipt", up2["key"], img2)):
    st, v = call("GET", "/lots/%s/photo?key=%s" % (lid, key.replace("/", "%2F")), coord)
    ok = False
    if st == 200:
        with urllib.request.urlopen(v["url"], timeout=30) as resp:
            ok = resp.read() == img
    check("coordinator views the %s photo through a signed URL" % name, ok, v)
st, v = call("GET", "/lots/%s/photo?key=%s" % (lid, "lots%2F" + lid + "%2Fhandoff-" + "0" * 32 + ".png"), coord)
check("an unrecorded key is not served", st == 404, v)
st, v = call("GET", "/lots/%s/verify" % lid, donor)
check("hash chain verifies with photos in it", st == 200 and v.get("ok") is True, v)
print("RESULT:", "ALL PASS" if not fails else "%d FAILED" % fails)
sys.exit(1 if fails else 0)
