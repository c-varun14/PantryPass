// Real API client. Every method resolves to {ok, status, body, serverDate}; none throw.
// status 0 means the network failed (request never completed).
let session = null;
export function setSession(s) { session = s; }

function base() { return (window.PP_CONFIG && window.PP_CONFIG.apiUrl || "").replace(/\/$/, ""); }

async function call(method, path, payload) {
  const headers = { Accept: "application/json" };
  if (session && session.idToken) headers.Authorization = `Bearer ${session.idToken}`;
  const init = { method, headers };
  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(payload);
  }
  try {
    const r = await fetch(base() + path, init);
    let body = {};
    try { body = await r.json(); } catch { /* empty or non-JSON body */ }
    return { ok: r.ok, status: r.status, body, serverDate: r.headers.get("date") };
  } catch {
    return { ok: false, status: 0, body: {}, serverDate: null };
  }
}

const enc = encodeURIComponent;
const post = (id, action, b) => call("POST", `/lots/${enc(id)}/${action}`, b);

// ---- photo evidence ----
// Photos are optional. The handoff and receipt bodies may carry `photo_key`; everything else is unchanged.
const PHOTO_MAX_SIDE = 1280;
const PHOTO_QUALITY = 0.82;

// Decodes a picked file to something drawable. Falls back to an <img> where createImageBitmap is missing.
async function loadBitmap(file) {
  if (typeof createImageBitmap === "function") return createImageBitmap(file);
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Re-encodes as JPEG, longest side at most 1280 px. Any failure returns the original file.
async function downscaleJpeg(file) {
  try {
    const src = await loadBitmap(file);
    const w = src.naturalWidth || src.width;
    const h = src.naturalHeight || src.height;
    if (!w || !h) return file;
    const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.fillStyle = "#ffffff"; // JPEG has no alpha: transparent pixels would turn black
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(src, 0, 0, cw, ch);
    if (typeof src.close === "function") src.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", PHOTO_QUALITY));
    return blob || file;
  } catch {
    return file;
  }
}

// Posts the file straight to S3 with the presigned POST fields. No app Authorization header, no api helper.
async function postToS3(upload, blob) {
  const form = new FormData();
  for (const [name, value] of Object.entries(upload.fields || {})) form.append(name, value); // fields first
  form.append("file", blob, "photo.jpg"); // file last
  try {
    const r = await fetch(upload.url, { method: "POST", body: form, credentials: "omit" });
    return { ok: r.ok, status: r.status, body: {} };
  } catch {
    return { ok: false, status: 0, body: {} };
  }
}

// Downscale, ask for a key, upload. Resolves {ok, status, body, key}; key is set only when ok.
export async function uploadPhoto(lotId, kind, file) {
  const blob = await downscaleJpeg(file);
  const made = await photoUpload(lotId, kind, "image/jpeg");
  if (!made.ok) return { ok: false, status: made.status, body: made.body };
  const info = made.body || {};
  if (info.max_bytes && blob.size > info.max_bytes) {
    return { ok: false, status: 0, body: { error: "The photo is too large to upload." } };
  }
  const sent = await postToS3(info.upload || {}, blob);
  if (!sent.ok) return { ok: false, status: sent.status, body: sent.body };
  return { ok: true, status: sent.status, body: {}, key: info.key };
}

export const photoUpload = (lotId, kind, contentType) =>
  call("POST", `/lots/${enc(lotId)}/photo-upload`, { kind, content_type: contentType });
export const photoUrl = (lotId, key) => call("GET", `/lots/${enc(lotId)}/photo?key=${enc(key)}`);

export const api = {
  listLots: () => call("GET", "/lots"),
  // Unclaimed lots any receiver may claim, newest first. Receivers and coordinators only.
  openOffers: () => call("GET", "/open-offers"),
  getLot: (id) => call("GET", `/lots/${enc(id)}`),
  createLot: (b) => call("POST", "/lots", b),
  accept: (id, b) => post(id, "accept", b),
  handoff: (id, b) => post(id, "handoff", b), // b may carry photo_key; passed through as is
  receipt: (id, b) => post(id, "receipt", b), // b may carry photo_key; passed through as is
  distribution: (id, b) => post(id, "distribution", b),
  disposition: (id, b) => post(id, "disposition", b),
  close: (id, b) => post(id, "close", b),
  resolveDispute: (id, b) => post(id, "resolve-dispute", b),
  retryCallbacks: (lot_id) => call("POST", "/retry-callbacks", lot_id ? { lot_id } : {}),
  verifyLot: (id) => call("GET", `/lots/${enc(id)}/verify`),
  impact: () => call("GET", "/impact"),
  rewards: () => call("GET", "/rewards"),
  photoUpload,
  photoUrl,
  uploadPhoto,
};

// ---- fund ----
// GET /fund for any signed-in role. The response is the donor pool; `you` and `allocations` depend on role.
api.fund = () => call("GET", "/fund");

// ---- payouts ----
// Donor: their own bank details (masked on the way back) and the payments made to them.
api.payoutProfile = () => call("GET", "/payout-profile");
api.savePayoutProfile = (b) => call("PUT", "/payout-profile", b);
// Coordinator: who is owed what from the fund (no account numbers), and one click to pay everyone due.
api.payouts = () => call("GET", "/payouts");
api.runPayouts = () => call("POST", "/payouts/run");

// ---- donations ----
// Direct gifts to a top donor, and pool contributions (no donor named). Signed-in roles. The mock simulates
// the payment (mode "demo"). There is no platform fee.
api.donate = (b) => call("POST", "/donations", b);
api.contribute = (b) => call("POST", "/pool", b);
api.confirmDonation = (b) => call("POST", "/donations/confirm", b);
api.donations = () => call("GET", "/donations");
