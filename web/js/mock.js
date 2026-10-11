// In-memory fake of the PantryPass API for the UI and for node tests.
// Rules mirror backend/api.py (authoritative for order of checks and error strings)
// and docs/api.md (contract). Exports the real client's surface: `api` and `setSession`.
// Money is simulated throughout: the mock behaves as the backend does with no Razorpay keys (mode "demo").
// Two test-only helpers are also exported (__tamperForTest, __advanceClockForTest); the
// UI never imports them. No DOM access, no network. Every method resolves (never throws)
// to { ok, status, body, serverDate } after a small random delay.

const FALLBACK_SUBS = { donor: "sub-donor", receiver: "sub-receiver", coordinator: "sub-coordinator" };
const DELAY_MIN_MS = 80;
const DELAY_MAX_MS = 250;
const RESPONSE_DEADLINE_SECONDS = 90;
const CUTOFF_SECONDS = 3600;
const PICKUP_TTL_SECONDS = 3600;
const PICKUP_MAX_ATTEMPTS = 5;
const ESCALATION_NOTE = "Unanswered pickup; assigned to coordinator. No distribution or disposal inferred.";

let session = null;        // { role, sub, name, idToken } set by setSession
let eventSeq = 0;          // monotonic: orders events, and lots by creation
let requestSeq = 0;
let clockOffsetMs = 0;     // test-only shift of the clock (see __advanceClockForTest)
const records = new Map(); // lot_id -> { lot, events: [], idem: Map, seq, pickup }
// Photo key -> image URL. In the browser an uploaded photo is an object URL; seeded placeholders are data URIs.
const photoSrc = new Map();
const PHOTO_MAX_BYTES = 5242880;
const PHOTO_EXPIRES_SECONDS = 300;
const MOCK_UPLOAD_URL = "https://mock-photos.invalid/upload";
// Same unit list as logic.js UNITS (the mock keeps its own copy: it must not import the UI rules).
const UNITS = ["kg", "litres", "plates", "packets", "boxes", "trays", "pieces"];
const FOOD_MAX = 60;

const nowSec = () => Math.floor((Date.now() + clockOffsetMs) / 1000);

// Mock chain hash: 64-bit FNV-1a over UTF-16 code units, as hex. Synchronous and
// dependency-free. This is NOT sha256 (the server uses sha256); it only lets the UI and
// tests exercise the same walk, and it is not a security control.
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = (1n << 64n) - 1n;
function fnv1a(text) {
  let h = FNV_OFFSET;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK64;
  }
  return h.toString(16).padStart(16, "0");
}

// Same field order as trust.event_hash in backend/trust.py.
const GENESIS = "";
const chainInput = (prev, ev) =>
  [prev, ev.lot_id, ev.event_id, ev.actor, ev.action, ev.decision, ev.result ?? "", String(ev.ts)].join("\n");
const chainHash = (prev, ev) => fnv1a(chainInput(prev, ev));
const clone = (v) => JSON.parse(JSON.stringify(v));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const UNAUTH = () => ({ status: 401, body: { error: "missing verified subject claim" } });
const fail = (status, body) => ({ status, body });

function nextRequestId() {
  requestSeq += 1;
  return `mock-req-${String(requestSeq).padStart(6, "0")}`;
}

function randomLotId() {
  let id;
  do {
    id = "lot-" + Array.from({ length: 12 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  } while (records.has(id));
  return id;
}

// Strict integer parse, matching api.py bint(): null when absent or not an integer.
function asInt(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) ? n : null;
}

// Missing optional increments count as 0; present ones must be integers.
function optionalInt(v) {
  return v === undefined || v === null ? 0 : asInt(v);
}

function configuredPeople() {
  try {
    const cfg = globalThis.PP_CONFIG;
    return cfg && Array.isArray(cfg.people) ? cfg.people : [];
  } catch (_) {
    return [];
  }
}

function subFor(role) {
  const hit = configuredPeople().find((p) => p && p.role === role && typeof p.sub === "string" && p.sub);
  return hit ? hit.sub : FALLBACK_SUBS[role];
}

// Appends an event. Every event except DENY and CallbackRetried joins the hash chain and
// moves the lot's chain_head / chain_len, as docs/api.md describes.
function appendEvent(rec, fields) {
  eventSeq += 1;
  const ev = {
    event_id: `${String(nowSec()).padStart(12, "0")}#${String(eventSeq).padStart(8, "0")}`,
    ts: nowSec(),
    lot_id: rec.lot.lot_id,
    ...fields,
  };
  if (ev.decision !== "DENY" && ev.action !== "CallbackRetried") {
    ev.prev_hash = rec.lot.chain_head;
    ev.hash = chainHash(ev.prev_hash, ev);
    rec.lot.chain_head = ev.hash;
    rec.lot.chain_len += 1;
  }
  rec.events.push(ev);
}

// Mock stand-in for trust.new_pickup_code: only a salted digest is kept on the record.
// The code itself leaves the module once, in the handoff response.
function newPickupCode() {
  const code = String(Math.floor(Math.random() * 1000000)).padStart(6, "0");
  const salt = Math.random().toString(16).slice(2, 10);
  return { code, pickup: { salt, digest: fnv1a(`${salt}:${code}`), attempts: 0 } };
}

// Receipt-side pickup check, in api.py order. Returns { confirmed } or fail(). A wrong code
// costs one attempt (kept on the private record, not the lot). Mirrors check_pickup_code.
function checkPickup(lot, rec, raw) {
  if (raw === undefined || raw === null || (typeof raw === "string" && !raw.trim())) return { confirmed: false };
  let code = null;
  if (typeof raw === "string") code = raw.trim();
  else if (Number.isInteger(raw)) code = String(raw).padStart(6, "0");
  if (code === null) return fail(409, { error: "pickup code invalid", attempts_left: null });
  const p = rec.pickup;
  if (!p) return fail(409, { error: "no pickup code is active for this lot" });
  if (p.attempts >= PICKUP_MAX_ATTEMPTS) {
    return fail(409, { error: "pickup code attempt limit reached", attempts_left: 0 });
  }
  if (nowSec() >= lot.pickup_expires_epoch) {
    return fail(409, { error: "pickup code expired", pickup_expires_epoch: lot.pickup_expires_epoch });
  }
  if (fnv1a(`${p.salt}:${code}`) === p.digest) return { confirmed: true };
  p.attempts += 1;
  return fail(409, { error: "pickup code invalid", attempts_left: Math.max(PICKUP_MAX_ATTEMPTS - p.attempts, 0) });
}

// Refusal in the contract shape. Attributed DENY event goes on the lot when there is one.
function deny(ctx, rec, action, lotId) {
  const request_id = nextRequestId();
  if (rec) {
    appendEvent(rec, { actor: ctx.sub, action, decision: "DENY", source: "VerifiedPermissions", request_id });
  }
  return {
    status: 403,
    body: { error: "VP_DENY", action, actor: ctx.sub, lot_id: lotId, decision: "DENY", request_id },
  };
}

// Who may perform each action (the mock's stand-in for Verified Permissions).
const isReceiverOf = (ctx, lot) => ctx.role === "receiver" && lot.receiver_sub === ctx.sub;
const isDonorOf = (ctx, lot) => ctx.role === "donor" && lot.donor_sub === ctx.sub;
const isCoordinator = (ctx) => ctx.role === "coordinator";
const MAY = {
  // Any receiver may claim an open offer; after that only its receiver may accept.
  Accept: (ctx, lot) => ctx.role === "receiver" && (lot.open_offer === true || lot.receiver_sub === ctx.sub),
  DeclareHandoff: isDonorOf,
  Receipt: isReceiverOf,
  ReportDistribution: isReceiverOf,
  ReportDisposition: isReceiverOf,
  Close: isReceiverOf,
  ResolveDispute: isCoordinator,
  RetryCallbacks: isCoordinator,
};

// Optional photo evidence. A `photo_key` in the body is stored on the lot as <kind>_photo_key, with a
// placeholder sha256, and echoed in the result so the timeline event carries it. Without a key, nothing changes.
function photoFields(kind, body) {
  const key = body && body.photo_key;
  if (!key) return { patch: {}, result: {} };
  return {
    patch: { [`${kind}_photo_key`]: key, [`${kind}_photo_sha256`]: fnv1a(key).repeat(4) },
    result: { photo_key: key },
  };
}

// Per-action state rules. Each returns either fail(status, body) or { patch, result }.
// Checks run in the same order as api.py.
const PERFORM = {
  // Claiming an open offer makes the claimant the receiver. A plain accept only moves the stage.
  Accept: (lot, body, rec, ctx) => {
    if (lot.open_offer !== true) return { patch: { stage: "ACCEPTED" }, result: { stage: "ACCEPTED" } };
    return {
      patch: { stage: "ACCEPTED", receiver_sub: ctx.sub, open_offer: false },
      result: { stage: "ACCEPTED", receiver_sub: ctx.sub, open_offer: false },
    };
  },

  // Fresh handoffs issue a pickup code. The code goes only into `pickupCode` (returned once);
  // the stored result, and so any replay, never carries it.
  DeclareHandoff(lot, body) {
    const qty = asInt(body.donor_handoff);
    if (qty === null || qty < 0 || qty > lot.offered) {
      return fail(409, { error: "donor_handoff must be between 0 and offered", offered: lot.offered });
    }
    const expires = nowSec() + PICKUP_TTL_SECONDS;
    const { code, pickup } = newPickupCode();
    const photo = photoFields("handoff", body);
    return {
      patch: { stage: "HANDOFF_DECLARED", donor_handoff: qty, pickup_expires_epoch: expires, ...photo.patch },
      result: { donor_handoff: qty, stage: "HANDOFF_DECLARED", pickup_expires_epoch: expires, ...photo.result },
      pickup,
      pickupCode: code,
    };
  },

  Receipt(lot, body, rec) {
    const received = asInt(body.received);
    if (received === null || received < 0) {
      return fail(409, { error: "received must be a non-negative integer" });
    }
    const check = checkPickup(lot, rec, body.pickup_code);
    if (check.status) return check;
    const count_dispute = lot.donor_handoff !== null && received !== lot.donor_handoff;
    rec.pickup = null; // destroyed on every receipt, as in api.py, so it cannot be reused
    const confirmed_in_person = check.confirmed;
    const photo = photoFields("receipt", body);
    return {
      patch: {
        stage: "RECEIVED", received, remaining: received,
        distributed: 0, returned: 0, disposed: 0, count_dispute, confirmed_in_person, ...photo.patch,
      },
      result: {
        received, remaining: received, distributed: 0, returned: 0, disposed: 0,
        count_dispute, confirmed_in_person, stage: "RECEIVED", ...photo.result,
      },
    };
  },

  ReportDistribution(lot, body) {
    const now = nowSec();
    if (now >= lot.cutoff_epoch) {
      return fail(409, {
        error: "cutoff passed; new distribution blocked by server time",
        cutoff_epoch: lot.cutoff_epoch, server_now: now,
      });
    }
    const qty = asInt(body.distributed);
    if (qty === null || qty <= 0) {
      return fail(409, { error: "distributed increment must be a positive integer" });
    }
    if (qty > lot.remaining) {
      return fail(409, { error: "distributed exceeds remaining received stock", requested: qty, remaining: lot.remaining });
    }
    const distributed = lot.distributed + qty;
    const remaining = lot.remaining - qty;
    return {
      patch: { stage: "DISTRIBUTING", distributed, remaining },
      result: { distributed, remaining, received: lot.received, stage: "DISTRIBUTING" },
    };
  },

  ReportDisposition(lot, body) {
    const returned = optionalInt(body.returned);
    const disposed = optionalInt(body.disposed);
    if (returned === null || disposed === null || returned < 0 || disposed < 0) {
      return fail(409, { error: "returned and disposed must be non-negative integers" });
    }
    const taken = returned + disposed;
    if (taken === 0) return fail(409, { error: "disposition needs returned or disposed above 0" });
    if (taken > lot.remaining) {
      return fail(409, { error: "returned plus disposed exceeds remaining received stock", requested: taken, remaining: lot.remaining });
    }
    const totalReturned = lot.returned + returned;
    const totalDisposed = lot.disposed + disposed;
    const remaining = lot.remaining - taken;
    return {
      patch: { returned: totalReturned, disposed: totalDisposed, remaining },
      result: {
        returned: totalReturned, disposed: totalDisposed, remaining,
        distributed: lot.distributed, received: lot.received, stage: lot.stage,
      },
    };
  },

  Close(lot) {
    if (lot.remaining !== 0) {
      return fail(409, { error: "cannot close: outstanding stock remains", remaining: lot.remaining });
    }
    if (lot.count_dispute) return fail(409, { error: "cannot close: unresolved count dispute" });
    if (nowSec() >= lot.cutoff_epoch) {
      return fail(409, { error: "cutoff passed; close blocked by server time", cutoff_epoch: lot.cutoff_epoch });
    }
    return { patch: { stage: "ACCOUNTED_FOR" }, result: { stage: "ACCOUNTED_FOR" } };
  },

  ResolveDispute(lot, body) {
    if (!lot.count_dispute) return fail(409, { error: "no count dispute to resolve" });
    const reconciled = asInt(body.reconciled_received);
    if (reconciled === null || reconciled < 0) {
      return fail(409, { error: "reconciled_received must be a non-negative integer" });
    }
    const committed = lot.distributed + lot.returned + lot.disposed;
    if (reconciled < committed) {
      return fail(409, {
        error: "reconciled_received is below stock already distributed or accounted for",
        minimum: committed,
      });
    }
    const remaining = reconciled - committed;
    return {
      patch: { received: reconciled, remaining, count_dispute: false },
      result: { received: reconciled, remaining, count_dispute: false, stage: lot.stage },
    };
  },
};

// Shared path for every mutating lot action. Order: lot exists -> authorized (DENY is
// logged) -> idem_key present -> replay of a stored idem response -> stage -> expected_version.
function mutate(ctx, lotId, action, rawBody, stages) {
  if (!ctx) return UNAUTH();
  const body = rawBody && typeof rawBody === "object" ? rawBody : {};
  const rec = records.get(lotId);
  if (!rec) return fail(404, { error: "lot not found", lot_id: lotId });
  if (!MAY[action](ctx, rec.lot)) return deny(ctx, rec, action, lotId);

  const key = body.idem_key;
  if (!key) return fail(400, { error: "idem_key is required" });
  if (rec.idem.has(key)) return { status: 200, body: clone(rec.idem.get(key)) };

  const lot = rec.lot;
  if (!stages.includes(lot.stage)) {
    return fail(409, { error: "invalid stage", stage: lot.stage, expected: stages });
  }
  const expected = asInt(body.expected_version);
  if (expected === null || expected !== lot.version) {
    return fail(409, { error: "stale or missing expected_version", version: lot.version });
  }

  const out = PERFORM[action](lot, body, rec, ctx);
  if (out.status) return out;

  Object.assign(lot, out.patch);
  if (out.pickup) rec.pickup = out.pickup;
  lot.version += 1;
  const result = { lot_id: lot.lot_id, action, ...out.result, version: lot.version };
  appendEvent(rec, { actor: ctx.sub, action, decision: "ALLOW", result: JSON.stringify(result) });
  rec.idem.set(key, clone(result));
  // Only this fresh response can carry the pickup code. Replays come from rec.idem, which never has it.
  const response = clone(result);
  if (out.pickupCode) response.pickup_code = out.pickupCode;
  return { status: 200, body: response };
}

// Unanswered offers escalate to EXCEPTION. unref() keeps node from waiting on it.
function armDeadline(rec) {
  const timer = setTimeout(() => {
    const lot = rec.lot;
    if (lot.stage !== "OFFERED") return;
    lot.stage = "EXCEPTION";
    lot.version += 1;
    appendEvent(rec, {
      actor: "system", action: "ResponseDeadlineMissed", decision: "ESCALATED",
      note: ESCALATION_NOTE, source: "system",
    });
  }, RESPONSE_DEADLINE_SECONDS * 1000);
  if (timer && typeof timer.unref === "function") timer.unref();
}

let forcedId = null; // fixed ids for the seed lots, so screenshots and docs can link to them
// A new lot is an open offer: announced to every receiver, with no receiver_sub until one claims it.
// The UI never sends receiver_sub. A caller that does (the older API shape, and the node tests) still gets
// an assigned lot, as before. food and unit are optional here; a lot without them is a legacy lot
// (shown as surplus food, in packets).
function createLot(ctx, rawBody) {
  if (!ctx) return UNAUTH();
  const body = rawBody && typeof rawBody === "object" ? rawBody : {};
  if (ctx.role !== "donor") return deny(ctx, null, "CreateLot", undefined);
  const offered = asInt(body.offered);
  if (offered === null || offered <= 0) {
    return fail(400, { error: "offered must be a positive whole number" });
  }
  const food = body.food === undefined ? null : String(body.food).trim();
  if (food !== null && (food.length < 1 || food.length > FOOD_MAX)) {
    return fail(400, { error: `food must be 1 to ${FOOD_MAX} characters` });
  }
  const assignee = body.receiver_sub ? String(body.receiver_sub) : null;
  const unit = body.unit === undefined ? null : body.unit;
  if (unit !== null && !UNITS.includes(unit)) {
    return fail(400, { error: `unit must be one of ${UNITS.join(", ")}` });
  }
  const t = nowSec();
  const lot = {
    lot_id: forcedId || randomLotId(),
    stage: "OFFERED",
    version: 1,
    donor_sub: ctx.sub,
    open_offer: !assignee,
    ...(assignee ? { receiver_sub: assignee } : {}),
    ...(food !== null ? { food } : {}),
    ...(unit !== null ? { unit } : {}),
    offered,
    donor_handoff: null,
    received: null,
    distributed: 0,
    returned: 0,
    disposed: 0,
    remaining: null,
    count_dispute: false,
    callback_pending: false,
    confirmed_in_person: false,
    pickup_expires_epoch: null,
    chain_head: GENESIS,
    chain_len: 0,
    response_deadline_epoch: t + RESPONSE_DEADLINE_SECONDS,
    cutoff_epoch: t + CUTOFF_SECONDS,
    created_epoch: t,
  };
  eventSeq += 1;
  const rec = { lot, events: [], idem: new Map(), seq: eventSeq, pickup: null };
  records.set(lot.lot_id, rec);
  appendEvent(rec, {
    actor: ctx.sub, action: "CreateLot", decision: "ALLOW",
    result: JSON.stringify({ offered, food: lot.food, unit: lot.unit, open_offer: lot.open_offer, cutoff_epoch: lot.cutoff_epoch }),
  });
  armDeadline(rec);
  return {
    status: 201,
    body: { lot: clone(lot), decision: "ALLOW", action: "CreateLot", request_id: nextRequestId() },
  };
}

function visibleTo(ctx, lot) {
  if (ctx.role === "coordinator") return true;
  if (ctx.role === "donor") return lot.donor_sub === ctx.sub;
  if (ctx.role === "receiver") return lot.receiver_sub === ctx.sub;
  return false;
}

// Unclaimed lots still waiting for a receiver, newest first. Receivers and coordinators only.
function openOffers(ctx) {
  if (!ctx) return UNAUTH();
  if (ctx.role !== "receiver" && ctx.role !== "coordinator") {
    return fail(403, { error: "not allowed to see open offers", actor: ctx.sub });
  }
  const matches = [...records.values()].filter((rec) => rec.lot.open_offer === true && rec.lot.stage === "OFFERED");
  matches.sort((a, b) => b.seq - a.seq);
  return { status: 200, body: { lots: matches.map((rec) => clone(rec.lot)) } };
}

function listLots(ctx) {
  if (!ctx) return UNAUTH();
  const matches = [...records.values()].filter((rec) => visibleTo(ctx, rec.lot));
  matches.sort((a, b) => b.seq - a.seq);
  return { status: 200, body: { lots: matches.map((rec) => clone(rec.lot)) } };
}

// A receiver may open an open offer before claiming it.
const isParticipant = (ctx, lot) => ctx.role === "coordinator"
  || lot.donor_sub === ctx.sub
  || lot.receiver_sub === ctx.sub
  || (ctx.role === "receiver" && lot.open_offer === true);

function getLot(ctx, lotId) {
  if (!ctx) return UNAUTH();
  const rec = records.get(lotId);
  if (!rec) return fail(404, { error: "lot not found", lot_id: lotId });
  if (!isParticipant(ctx, rec.lot)) {
    return fail(403, { error: "not a participant of this lot", actor: ctx.sub, lot_id: lotId });
  }
  return { status: 200, body: { lot: clone(rec.lot), events: clone(rec.events) } };
}

// Recomputes every hash by following prev_hash links, as trust.verify_chain does.
// Returns the docs/api.md shape: { ok, length, head, lot_head, legacy, broken_at, reason }.
function verifyChain(rec) {
  const chained = rec.events.filter((e) => e.hash);
  const legacy = rec.events.filter((e) => !e.hash && e.decision !== "DENY" && e.action !== "CallbackRetried").length;
  const byPrev = new Map();
  for (const e of chained) {
    const k = e.prev_hash ?? GENESIS;
    byPrev.set(k, [...(byPrev.get(k) || []), e]);
  }
  const out = (ok, length, head, broken_at, reason) => ({
    ok, length, head, lot_head: rec.lot.chain_head, legacy, broken_at, reason,
  });

  let prev = GENESIS;
  let length = 0;
  const seen = new Set();
  for (;;) {
    const next = byPrev.get(prev) || [];
    if (!next.length) break;
    if (next.length > 1) return out(false, length, prev, next[0].event_id, "chain forks: two events share a predecessor");
    const e = next[0];
    if (chainHash(prev, e) !== e.hash || seen.has(e.hash)) {
      return out(false, length, prev, e.event_id, "event content does not match its hash");
    }
    seen.add(e.hash);
    prev = e.hash;
    length += 1;
  }
  if (length !== chained.length) {
    const stray = chained.find((e) => !seen.has(e.hash));
    return out(false, length, prev, stray.event_id, "event not reachable from the start of the chain");
  }
  if (rec.lot.chain_head !== prev || rec.lot.chain_len !== length) {
    return out(false, length, prev, null, "chain head differs from the lot record (event removed or lot edited)");
  }
  return out(true, length, prev, null, null);
}

function verifyLot(ctx, lotId) {
  if (!ctx) return UNAUTH();
  const rec = records.get(lotId);
  if (!rec) return fail(404, { error: "lot not found", lot_id: lotId });
  if (!isParticipant(ctx, rec.lot)) {
    return fail(403, { error: "not a participant of this lot", actor: ctx.sub, lot_id: lotId });
  }
  return { status: 200, body: verifyChain(rec) };
}

// Coordinator-only totals, same fields as GET /impact in docs/api.md.
function impact(ctx) {
  if (!ctx) return UNAUTH();
  if (ctx.role !== "coordinator") {
    return fail(403, { error: "coordinator only", actor: ctx.sub, request_id: nextRequestId() });
  }
  const recs = [...records.values()];
  const lots = recs.map((rec) => rec.lot);
  const sum = (key) => lots.reduce((n, l) => n + (l[key] || 0), 0);
  const countEvents = (action) => recs.reduce((n, rec) => n + rec.events.filter((e) => e.action === action).length, 0);
  // Per unit. Legacy lots (no unit) count as packets. The top-level sums are across units: only show them
  // when mixed_units is false.
  const byUnit = {};
  for (const l of lots) {
    const u = UNITS.includes(l.unit) ? l.unit : "packets";
    const row = byUnit[u] || (byUnit[u] = { lots: 0, offered: 0, received: 0, distributed: 0, returned: 0, disposed: 0 });
    row.lots += 1;
    for (const k of ["offered", "received", "distributed", "returned", "disposed"]) row[k] += l[k] || 0;
  }
  return {
    status: 200,
    body: {
      lots: lots.length,
      offered: sum("offered"),
      received: sum("received"),
      distributed: sum("distributed"),
      returned: sum("returned"),
      disposed: sum("disposed"),
      by_unit: byUnit,
      mixed_units: Object.keys(byUnit).length > 1,
      accounted_for: lots.filter((l) => l.stage === "ACCOUNTED_FOR").length,
      disputes_caught: countEvents("ResolveDispute") + lots.filter((l) => l.count_dispute).length,
      exceptions_raised: countEvents("ResponseDeadlineMissed"),
      confirmed_in_person: lots.filter((l) => l.confirmed_in_person).length,
    },
  };
}

// Trust points, mirroring backend/rewards.py (authoritative) and docs/api.md "Rewards".
// Recognition only: points come from confirmed handoffs, and nothing is deducted. A lot earns
// nothing unless its chain verifies, and never when donor == receiver. Quantity counts only once
// verified: the receiver's confirmed count on an accounted-for lot whose counts matched earns a
// donor bonus (log-shaped, capped per lot, shrinking for repeat handoffs to the same receiver).
// Units are never added together across units.
const REWARD_LEVELS = [["Seedling", 0], ["Helper", 20], ["Steward", 60], ["Champion", 150]];
const REWARD_BADGES = [
  ["first_clean_handoff", "First clean handoff", "Get a lot accounted for", "accounted", 1],
  ["face_to_face", "Face to face", "Confirm 5 handoffs in person", "in_person", 5],
  ["quick_responder", "Quick responder", "Accept 3 offers before the deadline", "on_time", 3],
  ["closer", "Closer", "Close 3 lots as accounted for", "accounted", 3],
  ["tie_breaker", "Tie-breaker", "Resolve 3 count disputes", "resolved", 3],
];
const VOLUME_CAP = 12;                  // most volume points one lot can earn
const PAIR_FACTORS = [1.0, 0.5, 0.0];   // 1st, 2nd, 3rd+ accounted lot with the same counterparty
const WEEK = 7 * 24 * 3600;
const BIG_MOVER_GOAL = 100;             // verified units in one unit of measure
const STREAK_GOAL = 3;
const REWARD_LOTS_CAP = 200;

function resultOf(event) {
  try {
    const r = JSON.parse((event && event.result) || "{}");
    return r && typeof r === "object" && !Array.isArray(r) ? r : {};
  } catch (_) {
    return {};
  }
}

function levelFor(points) {
  let idx = 0;
  REWARD_LEVELS.forEach(([, floor], i) => { if (points >= floor) idx = i; });
  const next = REWARD_LEVELS[idx + 1] || null;
  return { level: REWARD_LEVELS[idx][0], next_level: next ? next[0] : null, next_level_at: next ? next[1] : null };
}

// [kind, reason, points, event_hash] earned by `sub` on one lot. Port of rewards._lot_entries.
function lotRewardEntries(sub, role, rec) {
  const lot = rec.lot;
  const verdict = verifyChain(rec);
  if (!verdict.ok || verdict.length === 0) return [];
  const donor = lot.donor_sub;
  const receiver = lot.receiver_sub;
  if (donor && donor === receiver) return [];

  const byAction = new Map();
  for (const e of rec.events) {
    if (!e.hash || e.decision !== "ALLOW") continue;
    byAction.set(e.action, [...(byAction.get(e.action) || []), e]);
  }
  const first = (action) => (byAction.get(action) || [])[0] || null;
  const out = [];
  const accounted = lot.stage === "ACCOUNTED_FOR";
  const receipt = first("Receipt");
  const rres = receipt ? resultOf(receipt) : {};
  const matched = Boolean(receipt) && rres.count_dispute === false;

  if (sub === receiver) {
    for (const e of byAction.get("Accept") || []) {
      if (e.actor === sub && lot.response_deadline_epoch != null && e.ts <= lot.response_deadline_epoch) {
        out.push(["on_time", "Accepted before the deadline", 3, e.hash]);
      }
    }
    if (receipt && receipt.actor === sub) {
      if (rres.confirmed_in_person === true) out.push(["in_person", "Receipt confirmed in person", 5, receipt.hash]);
      if (matched) out.push(["matched", "Count matched the donor's", 5, receipt.hash]);
    }
    for (const e of byAction.get("Close") || []) {
      if (accounted && e.actor === sub) out.push(["accounted", "Lot closed as accounted for", 10, e.hash]);
    }
  }
  if (sub === donor) {
    if (accounted && matched) {
      const close = first("Close") || receipt;
      out.push(["accounted", "Lot accounted for with matching counts", 10, close.hash]);
    }
    if (receipt && rres.confirmed_in_person === true) out.push(["in_person", "Handoff confirmed in person", 5, receipt.hash]);
  }
  if (role === "coordinator") {
    for (const e of byAction.get("ResolveDispute") || []) {
      if (e.actor === sub) out.push(["resolved", "Resolved a count dispute", 3, e.hash]);
    }
  }
  return out;
}

// Port of rewards.volume_points: grows with the log of the quantity, capped per lot. 1 -> 2, 10 -> 6, 100+ -> 12.
function volumePoints(qty) {
  return Math.min(VOLUME_CAP, Math.floor(2 * Math.log2(1 + Math.max(qty, 0))));
}

// Port of rewards._verified_quantity: the receiver's confirmed count, or null unless the whole record backs it.
function verifiedQuantity(rec) {
  const lot = rec.lot;
  const verdict = verifyChain(rec);
  if (!verdict.ok || verdict.length === 0 || lot.stage !== "ACCOUNTED_FOR") return null;
  if (!lot.donor_sub || !lot.receiver_sub || lot.donor_sub === lot.receiver_sub) return null;
  const receipt = rec.events.find((e) => e.hash && e.decision === "ALLOW" && e.action === "Receipt");
  if (!receipt) return null;
  const r = resultOf(receipt);
  const qty = r.received;
  if (r.count_dispute === false && Number.isInteger(qty) && qty > 0) return qty;
  return null;
}

// Port of rewards._streak: consecutive weeks (ending this week or last) that each had a verified donation.
function streakWeeks(weeks, now) {
  if (weeks.size === 0) return 0;
  const cur = Math.floor(now / WEEK);
  let last = null;
  if (weeks.has(cur)) last = cur;
  else if (weeks.has(cur - 1)) last = cur - 1;
  if (last === null) return 0;
  let n = 0;
  while (weeks.has(last - n)) n += 1;
  return n;
}

// Port of rewards.compute_rewards, with the lot scan done over the in-memory records.
// Lots are read newest first (capped), then processed oldest first, as the backend does.
function rewardsFor(ctx) {
  if (!ctx) return UNAUTH();
  const recs = [...records.values()];
  const mine = recs.filter((rec) => (ctx.role === "coordinator"
    ? rec.events.some((e) => e.action === "ResolveDispute" && e.actor === ctx.sub)
    : rec.lot.donor_sub === ctx.sub || rec.lot.receiver_sub === ctx.sub));
  mine.sort((a, b) => (b.lot.created_epoch || 0) - (a.lot.created_epoch || 0));
  const capped = mine.slice(0, REWARD_LOTS_CAP);
  capped.sort((a, b) => (a.lot.created_epoch || 0) - (b.lot.created_epoch || 0));

  const ledger = [];
  const counts = {};
  const volume = new Map();   // unit -> { unit, quantity, lots }
  const weeks = new Set();
  const pairSeen = new Map(); // receiver_sub -> verified lots so far
  for (const rec of capped) {
    const lot = rec.lot;
    for (const [kind, reason, points, hash] of lotRewardEntries(ctx.sub, ctx.role, rec)) {
      ledger.push({ lot_id: lot.lot_id, reason, points, event_hash: hash });
      counts[kind] = (counts[kind] || 0) + 1;
    }
    if (ctx.sub !== lot.donor_sub) continue;
    const qty = verifiedQuantity(rec);
    if (qty === null) continue;
    const unit = lot.unit || "packets";
    const row = volume.get(unit) || { unit, quantity: 0, lots: 0 };
    volume.set(unit, row);
    row.quantity += qty;
    row.lots += 1;
    if (lot.created_epoch) weeks.add(Math.floor(lot.created_epoch / WEEK));
    const seen = pairSeen.get(lot.receiver_sub) || 0;
    pairSeen.set(lot.receiver_sub, seen + 1);
    const pts = Math.trunc(volumePoints(qty) * PAIR_FACTORS[Math.min(seen, PAIR_FACTORS.length - 1)]);
    if (pts > 0) {
      const hash = rec.events.find((e) => e.action === "Receipt" && e.hash).hash;
      ledger.push({ lot_id: lot.lot_id, reason: `Verified ${qty} ${unit} moved`, points: pts, event_hash: hash });
    }
  }

  const points = ledger.reduce((n, x) => n + x.points, 0);
  const badges = REWARD_BADGES.map(([id, name, rule, kind, goal]) => {
    const have = counts[kind] || 0;
    return { id, name, rule, earned: have >= goal, progress: Math.min(have, goal), goal };
  });
  const vol = [...volume.values()].sort((a, b) => b.quantity - a.quantity);
  const best = vol.reduce((m, r) => Math.max(m, r.quantity), 0);
  const streak = streakWeeks(weeks, nowSec());
  badges.push({
    id: "big_mover", name: "Big mover", rule: `Move ${BIG_MOVER_GOAL} verified units in one unit of measure`,
    earned: best >= BIG_MOVER_GOAL, progress: Math.min(best, BIG_MOVER_GOAL), goal: BIG_MOVER_GOAL,
  });
  badges.push({
    id: "steady_giver", name: "Steady giver", rule: `Verified donations ${STREAK_GOAL} weeks in a row`,
    earned: streak >= STREAK_GOAL, progress: Math.min(streak, STREAK_GOAL), goal: STREAK_GOAL,
  });
  const accountedLots = recs.filter((rec) => rec.lot.stage === "ACCOUNTED_FOR").length;
  return {
    status: 200,
    body: {
      points,
      ...levelFor(points),
      badges,
      ledger,
      volume: vol,
      streak_weeks: streak,
      verified_lots: vol.reduce((n, r) => n + r.lots, 0),
      partners: pairSeen.size,
      community: { lots_accounted_for: accountedLots },
    },
  };
}

function retryCallbacks(ctx, arg) {
  if (!ctx) return UNAUTH();
  const lotId = typeof arg === "string" ? arg : (arg && typeof arg === "object" ? arg.lot_id : undefined);
  if (ctx.role !== "coordinator") {
    const rec = lotId ? records.get(lotId) || null : null;
    return deny(ctx, rec, "RetryCallbacks", lotId);
  }
  const targets = lotId ? [records.get(lotId)].filter(Boolean) : [...records.values()];
  const reconciled = [];
  for (const rec of targets) {
    if (!rec.lot.callback_pending) continue;
    rec.lot.callback_pending = false;
    appendEvent(rec, { actor: "system", action: "CallbackRetried", decision: "ALLOW" });
    reconciled.push(rec.lot.lot_id);
  }
  return { status: 200, body: { reconciled } };
}

// Mirrors POST /lots/{id}/photo-upload. The browser never reaches S3 in mock mode: uploadPhoto()
// keeps the picked file in memory under the key it was issued.
function hex32() {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

function photoUpload(ctx, lotId, body) {
  if (!ctx) return UNAUTH();
  const rec = records.get(lotId);
  if (!rec) return fail(404, { error: "lot not found", lot_id: lotId });
  const b = body && typeof body === "object" ? body : {};
  if (b.kind !== "handoff" && b.kind !== "receipt") return fail(400, { error: "kind must be handoff or receipt" });
  if (b.content_type !== "image/jpeg") return fail(400, { error: "content_type must be image/jpeg" });
  const allowed = b.kind === "handoff" ? MAY.DeclareHandoff(ctx, rec.lot) : MAY.Receipt(ctx, rec.lot);
  if (!allowed) return fail(403, { error: "not allowed to add this photo", actor: ctx.sub, lot_id: lotId });
  const want = b.kind === "handoff" ? "ACCEPTED" : "HANDOFF_DECLARED";
  if (rec.lot.stage !== want) return fail(409, { error: "invalid stage", stage: rec.lot.stage, expected: [want] });
  const key = `lots/${lotId}/${b.kind}-${hex32()}.jpg`;
  return {
    status: 200,
    body: {
      key,
      upload: { url: MOCK_UPLOAD_URL, fields: { key, "Content-Type": "image/jpeg" } },
      max_bytes: PHOTO_MAX_BYTES,
      expires_in: PHOTO_EXPIRES_SECONDS,
    },
  };
}

// Mirrors GET /lots/{id}/photo. An unknown key gets a generic placeholder instead of an error.
function photoUrl(ctx, lotId, key) {
  if (!ctx) return UNAUTH();
  const rec = records.get(lotId);
  if (!rec) return fail(404, { error: "lot not found", lot_id: lotId });
  if (!isParticipant(ctx, rec.lot)) {
    return fail(403, { error: "not a participant of this lot", actor: ctx.sub, lot_id: lotId });
  }
  const url = photoSrc.get(key) || placeholderUrl("Photo");
  return { status: 200, body: { url, expires_in: PHOTO_EXPIRES_SECONDS } };
}

// Browser side of a photo upload, mock edition: issues a key, then remembers the file's object URL.
export async function uploadPhoto(lotId, kind, file) {
  const made = await api.photoUpload(lotId, kind, "image/jpeg");
  if (!made.ok) return { ok: false, status: made.status, body: made.body };
  const key = made.body.key;
  if (file && typeof URL !== "undefined" && URL.createObjectURL) photoSrc.set(key, URL.createObjectURL(file));
  return { ok: true, status: 200, body: {}, key };
}

// Generated picture for demo photos. A grid of boxes, one per unit counted, so 10 against 8 reads at a glance.
function svgUrl(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function countPhotoUrl(count, caption, tint) {
  // 4:3, like the tiles, so nothing is cropped. Boxes are centred under the caption.
  const W = 400;
  const H = 300;
  const cols = 5;
  const cell = 54;
  const gap = 10;
  const rows = Math.ceil(count / cols);
  const gridW = cols * cell + (cols - 1) * gap;
  const gridH = rows * cell + (rows - 1) * gap;
  const x0 = (W - gridW) / 2;
  const y0 = 80 + (H - 80 - gridH) / 2;
  let boxes = "";
  for (let i = 0; i < count; i += 1) {
    const x = x0 + (i % cols) * (cell + gap);
    const y = y0 + Math.floor(i / cols) * (cell + gap);
    boxes += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="8" fill="${tint}" stroke="#7a5a3a" stroke-width="3"/>`;
  }
  return svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<rect width="100%" height="100%" fill="#f5f7f6"/>` +
    `<text x="${W / 2}" y="52" text-anchor="middle" font-family="Manrope, Arial, sans-serif" font-size="28" font-weight="700" fill="#0f1714">${caption}</text>` +
    boxes + `</svg>`);
}

function placeholderUrl(label) {
  return svgUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">` +
    `<rect width="100%" height="100%" fill="#eceff0"/>` +
    `<text x="200" y="158" text-anchor="middle" font-family="Manrope, Arial, sans-serif" font-size="26" font-weight="700" fill="#56625d">${label}</text>` +
    `</svg>`);
}

function currentCtx() {
  if (!session) return null;
  return { role: session.role, sub: session.sub };
}

// Wraps a synchronous rule function as an async client method. The caller's identity
// is captured at call time, as a real token would be. Never throws.
function endpoint(op) {
  return async (...args) => {
    const ctx = currentCtx();
    await sleep(DELAY_MIN_MS + Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS));
    let status = 500;
    let body = { error: "mock internal error" };
    try {
      const res = op(ctx, ...args);
      status = typeof res.status === "number" ? res.status : 500;
      body = clone(res.body ?? {});
    } catch (_) {
      status = 500;
      body = { error: "mock internal error" };
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      body,
      serverDate: new Date().toUTCString(),
    };
  };
}

// Demo data, built through the same rules so events and invariants are real.
function seedDemoLots() {
  const donor = { role: "donor", sub: subFor("donor") };
  const receiver = { role: "receiver", sub: subFor("receiver") };

  // A: RECEIVED with a count dispute (donor declared 10, receiver reported 8).
  forcedId = "lot-c011de5d15a7";
  const a = createLot(donor, { food: "Dal and rice", unit: "plates", offered: 10 }).body.lot.lot_id;
  mutate(receiver, a, "Accept", { idem_key: "seed-a-accept", expected_version: 1 }, ["OFFERED"]);
  // Both sides attach a photo, so the comparison UI has something to show: 10 handed over, 8 counted.
  const aHandoffKey = `lots/${a}/handoff-5f0c2a7e9b1d4c63a8e2f1b07d94c3a1.jpg`;
  const aReceiptKey = `lots/${a}/receipt-9d2e4b6a1c7f48e0b3d5a2c8e6f10b47.jpg`;
  photoSrc.set(aHandoffKey, countPhotoUrl(10, "Handed over: 10", "#f2c98a"));
  photoSrc.set(aReceiptKey, countPhotoUrl(8, "Counted: 8", "#b9d7f5"));
  mutate(donor, a, "DeclareHandoff", { idem_key: "seed-a-handoff", expected_version: 2, donor_handoff: 10, photo_key: aHandoffKey }, ["ACCEPTED"]);
  mutate(receiver, a, "Receipt", { idem_key: "seed-a-receipt", expected_version: 3, received: 8, photo_key: aReceiptKey }, ["HANDOFF_DECLARED"]);

  // B: DISTRIBUTING, partly distributed (12 received, 5 distributed, 7 remaining).
  forcedId = "lot-a8f122b04e19";
  const b = createLot(donor, { food: "Milk", unit: "litres", offered: 12 }).body.lot.lot_id;
  forcedId = null;
  mutate(receiver, b, "Accept", { idem_key: "seed-b-accept", expected_version: 1 }, ["OFFERED"]);
  const bHandoff = mutate(donor, b, "DeclareHandoff", { idem_key: "seed-b-handoff", expected_version: 2, donor_handoff: 12 }, ["ACCEPTED"]);
  // The receipt uses the pickup code from the handoff, so it is confirmed in person (trust points).
  mutate(receiver, b, "Receipt", { idem_key: "seed-b-receipt", expected_version: 3, received: 12, pickup_code: bHandoff.body.pickup_code }, ["HANDOFF_DECLARED"]);
  mutate(receiver, b, "ReportDistribution", { idem_key: "seed-b-dist", expected_version: 4, distributed: 5 }, ["RECEIVED", "DISTRIBUTING"]);

  // C: a count dispute the coordinator settled (gives the coordinator a resolve on record).
  const c = createLot(donor, { food: "Bread", unit: "trays", offered: 6 }).body.lot.lot_id;
  mutate(receiver, c, "Accept", { idem_key: "seed-c-accept", expected_version: 1 }, ["OFFERED"]);
  mutate(donor, c, "DeclareHandoff", { idem_key: "seed-c-handoff", expected_version: 2, donor_handoff: 6 }, ["ACCEPTED"]);
  mutate(receiver, c, "Receipt", { idem_key: "seed-c-receipt", expected_version: 3, received: 5 }, ["HANDOFF_DECLARED"]);
  mutate({ role: "coordinator", sub: subFor("coordinator") }, c, "ResolveDispute", { idem_key: "seed-c-resolve", expected_version: 4, reconciled_received: 6 }, ["RECEIVED", "DISTRIBUTING"]);

  // D and E: open offers, announced to every receiver and not yet claimed (the receiver's Open offers list).
  createLot(donor, { food: "Cooked rice", unit: "kg", offered: 12 });
  createLot(donor, { food: "Vegetable khichdi", unit: "plates", offered: 40 });
}

export const api = {
  listLots: endpoint((ctx) => listLots(ctx)),
  openOffers: endpoint((ctx) => openOffers(ctx)),
  getLot: endpoint((ctx, id) => getLot(ctx, id)),
  createLot: endpoint((ctx, body) => createLot(ctx, body)),
  accept: endpoint((ctx, id, body) => mutate(ctx, id, "Accept", body, ["OFFERED"])),
  handoff: endpoint((ctx, id, body) => mutate(ctx, id, "DeclareHandoff", body, ["ACCEPTED"])),
  receipt: endpoint((ctx, id, body) => mutate(ctx, id, "Receipt", body, ["HANDOFF_DECLARED"])),
  distribution: endpoint((ctx, id, body) => mutate(ctx, id, "ReportDistribution", body, ["RECEIVED", "DISTRIBUTING"])),
  disposition: endpoint((ctx, id, body) => mutate(ctx, id, "ReportDisposition", body, ["RECEIVED", "DISTRIBUTING"])),
  close: endpoint((ctx, id, body) => mutate(ctx, id, "Close", body, ["RECEIVED", "DISTRIBUTING"])),
  resolveDispute: endpoint((ctx, id, body) => mutate(ctx, id, "ResolveDispute", body, ["RECEIVED", "DISTRIBUTING"])),
  retryCallbacks: endpoint((ctx, arg) => retryCallbacks(ctx, arg)),
  verifyLot: endpoint((ctx, id) => verifyLot(ctx, id)),
  impact: endpoint((ctx) => impact(ctx)),
  rewards: endpoint((ctx) => rewardsFor(ctx)),
  photoUpload: endpoint((ctx, lotId, kind, contentType) => photoUpload(ctx, lotId, { kind, content_type: contentType })),
  photoUrl: endpoint((ctx, lotId, key) => photoUrl(ctx, lotId, key)),
  uploadPhoto,
};

// Test-only. Changes the first chained event's actor so the chain no longer verifies.
export function __tamperForTest(lotId) {
  const rec = records.get(lotId);
  const target = rec && rec.events.find((e) => e.hash);
  if (target) target.actor = "sub-mallory";
  return Boolean(target);
}

// Test-only. Shifts the mock clock (seconds, may be negative) to exercise expiry and cutoffs.
export function __advanceClockForTest(seconds) {
  clockOffsetMs += seconds * 1000;
}

// session = { role, sub, name, idToken } or null to sign out.
export function setSession(next) {
  if (!next || typeof next !== "object" || !next.sub) {
    session = null;
    return;
  }
  session = {
    role: next.role,
    sub: String(next.sub),
    name: next.name || "",
    idToken: next.idToken || "",
  };
}

seedDemoLots();

// ---- fund ----
// Demo pool for GET /fund, mirroring the live contract. Simulation only: no money moves.
// Shares are points over all points, with no donor above FUND_CAP_PCT of the pool. A capped donor's
// excess is shared out again among the others (repeat until nobody is over the cap).
// Three simulated peers are included so the sharing and the cap are visible; each row says which it is.
const FUND_POOL_INR = 25000;
const FUND_CAP_PCT = 30;
const FUND_PERIOD = "Demo month";
const FUND_MIN_LOTS = 3;     // same as rewards.TOP_MIN_LOTS in backend/rewards.py
const FUND_MIN_PARTNERS = 2; // same as rewards.TOP_MIN_PARTNERS
const FUND_NOTE = "Demo pool. 3 simulated peer donors are included so the sharing and the cap are visible. No money moves in this demo.";
// Copied from the `rules` list in backend h_fund, with the same numbers filled in.
const FUND_RULES = [
  "Points come from verified, receiver-confirmed handoffs: matching counts, handoffs confirmed in person, lots accounted for.",
  "The amount counts only once verified: a bonus that grows with the confirmed quantity, capped per lot, and shrinking for repeat handoffs between the same two people.",
  "A lot whose record fails Verify earns nothing.",
  `To share the pool you need ${FUND_MIN_LOTS} verified lots handed to at least ${FUND_MIN_PARTNERS} different receivers.`,
  `No donor can take more than ${FUND_CAP_PCT}% of the pool.`,
  "The pool is shared in proportion to points. Payouts are made by a coordinator to the bank details you provide.",
];
// Fixed demo stats for the demo donor (subFor("donor")). Their 45 points are fixed too.
const DEMO_DONOR_POINTS = 45;
const DEMO_DONOR_LEVEL = "Helper";
const DEMO_DONOR_VOLUME = [{ unit: "kg", quantity: 140, lots: 4 }];
const DEMO_DONOR_STREAK = 2;
const DEMO_DONOR_VERIFIED_LOTS = 4;
const DEMO_DONOR_PARTNERS = 3;

// Each entry is a real donor (donor_sub) or a simulated peer (name). Points are the period's totals.
function fundEntries() {
  return [
    { donor_sub: subFor("donor"), points: DEMO_DONOR_POINTS, simulated: false },
    { name: "Priya's kitchen", points: 70, simulated: true },
    { name: "Green Leaf Cafe", points: 55, simulated: true },
    { name: "St Mary's mess", points: 40, simulated: true },
  ];
}

// Water-filling: any entry whose share would pass the cap is fixed at the cap, and the rest is
// shared out again by points until nobody is over. Returns one row per entry, in order.
function fundAllocations(entries) {
  const capped = new Set();
  const freeOf = () => entries.map((e, i) => i).filter((i) => !capped.has(i));
  for (;;) {
    const free = freeOf();
    const freePoints = free.reduce((n, i) => n + entries[i].points, 0);
    const left = 100 - capped.size * FUND_CAP_PCT;
    const over = free.find((i) => freePoints && (left * entries[i].points) / freePoints > FUND_CAP_PCT);
    if (over === undefined) break;
    capped.add(over);
  }
  const freePoints = freeOf().reduce((n, i) => n + entries[i].points, 0);
  const left = 100 - capped.size * FUND_CAP_PCT;
  return entries.map((e, i) => {
    const isCapped = capped.has(i);
    const raw = isCapped ? FUND_CAP_PCT : (freePoints ? (left * e.points) / freePoints : 0);
    const sharePct = Math.round(raw * 10) / 10;
    const row = {
      simulated: e.simulated,
      points: e.points,
      share_pct: sharePct,
      estimated_inr: Math.round((FUND_POOL_INR * sharePct) / 100),
      capped: isCapped,
    };
    return e.simulated ? { name: e.name, ...row } : { donor_sub: e.donor_sub, ...row };
  });
}

function fundFor(ctx) {
  if (!ctx) return UNAUTH();
  const entries = fundEntries();
  const rows = fundAllocations(entries);
  const demoSub = subFor("donor");
  const mine = ctx.role === "donor" ? rows.find((r) => r.donor_sub === ctx.sub) : undefined;
  const you = mine
    ? {
      role: "donor",
      points: mine.points,
      share_pct: mine.share_pct,
      estimated_inr: mine.estimated_inr,
      capped: mine.capped,
      eligible: ctx.sub === demoSub,
      verified_lots: ctx.sub === demoSub ? DEMO_DONOR_VERIFIED_LOTS : 0,
      partners: ctx.sub === demoSub ? DEMO_DONOR_PARTNERS : 0,
      needs: { lots: FUND_MIN_LOTS, partners: FUND_MIN_PARTNERS },
    }
    : null;
  const topDonors = [{
    donor_sub: demoSub,
    points: DEMO_DONOR_POINTS,
    level: DEMO_DONOR_LEVEL,
    volume: DEMO_DONOR_VOLUME.map((r) => ({ ...r })),
    streak_weeks: DEMO_DONOR_STREAK,
    verified_lots: DEMO_DONOR_VERIFIED_LOTS,
    partners: DEMO_DONOR_PARTNERS,
    ...supportTotals(demoSub),
  }];
  return {
    status: 200,
    body: {
      demo: true,
      note: FUND_NOTE,
      period: FUND_PERIOD,
      pool_inr: FUND_POOL_INR,
      cap_pct: FUND_CAP_PCT,
      total_points: entries.reduce((n, e) => n + e.points, 0),
      donors: entries.length,
      simulated_peers: entries.filter((e) => e.simulated).length,
      you,
      allocations: ctx.role === "coordinator" ? rows : [],
      top_donors: topDonors,
      donations: {
        enabled: true, fee_pct: DONATION_FEE_PCT, min_inr: DONATION_MIN_INR, max_inr: DONATION_MAX_INR, mode: "demo",
      },
      rules: FUND_RULES.slice(),
    },
  };
}

api.fund = endpoint((ctx) => fundFor(ctx));

// ---- donations ----
// Direct gifts from a signed-in person to a top donor. Simulation only, as the backend with no Razorpay keys:
// nothing is charged, and a confirmed gift is stored as "simulated", which never counts as money received or
// owed. Validation and fee math are ports of backend/payments.py (same limits, same error strings).
const DONATION_FEE_PCT = 5;
const DONATION_MIN_INR = 10;
const DONATION_MAX_INR = 50000;
const DONATION_NOTE_RE = /^[A-Za-z0-9 .,!?'()-]{0,80}$/;
const DONATION_LIST_MAX = 50;
const donationOrders = new Map();    // order_id -> { donor_sub, supporter_sub, amount_inr, fee_inr, net_inr, note, mode, status }
const donationsReceived = new Map(); // donor sub -> [{ amount_inr, fee_inr, net_inr, note, status, mode, ts }], in the order recorded
const donationsGiven = new Map();    // supporter sub -> [{ donor_sub, amount_inr, note, status, mode, ts }], in the order recorded

// Port of payments.clean_donation. Returns [donation, null] or [null, error].
function cleanDonation(body) {
  const b = body && typeof body === "object" ? body : {};
  const donor = asText(b.donor_sub).trim();
  const raw = b.amount_inr;
  let amount = NaN;
  if (typeof raw === "number" && Number.isFinite(raw)) amount = Math.trunc(raw);
  else if (typeof raw === "string" && /^\s*[+-]?[0-9]+\s*$/.test(raw)) amount = parseInt(raw, 10);
  else if (typeof raw === "boolean") amount = raw ? 1 : 0;
  if (!Number.isFinite(amount)) return [null, "amount_inr must be a whole number of rupees"];
  const note = collapseSpaces(asText(b.note));
  if (!donor) return [null, "donor_sub is required"];
  if (amount < DONATION_MIN_INR || amount > DONATION_MAX_INR) {
    return [null, `amount_inr must be between ${DONATION_MIN_INR} and ${DONATION_MAX_INR}`];
  }
  if (!DONATION_NOTE_RE.test(note)) {
    return [null, "note can be up to 80 characters: letters, numbers and basic punctuation"];
  }
  return [{ donor_sub: donor, amount_inr: amount, note }, null];
}

// Port of payments.split_fee: the fee is rounded down and the donor's net is the rest.
function splitFee(amount, pct) {
  const fee = Math.floor((amount * Math.max(pct, 0)) / 100);
  return [fee, amount - fee];
}

// Only the demo donor is a top donor in the mock (the same one GET /fund lists).
const isTopDonor = (sub) => sub === subFor("donor");

// Confirmed gifts only, as support_totals in the backend.
function supportTotals(donorSub) {
  const rows = (donationsReceived.get(donorSub) || []).filter((r) => r.status === "simulated" || r.status === "paid");
  return { supporters: rows.length, supported_inr: rows.reduce((n, r) => n + r.amount_inr, 0) };
}

function addRecord(map, key, rec) {
  const list = map.get(key) || [];
  list.push(rec);
  map.set(key, list);
}

// Port of h_donate in demo mode. The amount, fee and recipient are decided here.
function donateFor(ctx, rawBody) {
  if (!ctx) return UNAUTH();
  const [don, err] = cleanDonation(rawBody);
  if (err) return fail(400, { error: err });
  if (don.donor_sub === ctx.sub) return fail(409, { error: "you cannot donate to yourself" });
  if (!isTopDonor(don.donor_sub)) {
    return fail(409, { error: "this donor is not a top donor yet, so they cannot receive donations" });
  }
  const [fee, net] = splitFee(don.amount_inr, DONATION_FEE_PCT);
  const orderId = "order_demo_" + hex32().slice(0, 14);
  donationOrders.set(orderId, {
    donor_sub: don.donor_sub, supporter_sub: ctx.sub, amount_inr: don.amount_inr, fee_inr: fee, net_inr: net,
    note: don.note, mode: "demo", status: "created",
  });
  return {
    status: 200,
    body: {
      order_id: orderId, mode: "demo", amount_inr: don.amount_inr, fee_inr: fee, net_inr: net,
      currency: "INR", donor_sub: don.donor_sub,
    },
  };
}

// Port of h_donate_confirm in demo mode. Idempotent: only the first confirm writes records.
function confirmDonationFor(ctx, rawBody) {
  if (!ctx) return UNAUTH();
  const b = rawBody && typeof rawBody === "object" ? rawBody : {};
  const orderId = asText(b.order_id);
  const order = donationOrders.get(orderId);
  if (!order || order.supporter_sub !== ctx.sub) return fail(404, { error: "no such donation order" });
  if (order.status !== "created") {
    return { status: 200, body: { order_id: orderId, status: order.status, amount_inr: order.amount_inr } };
  }
  order.status = "simulated";
  const ts = nowSec();
  addRecord(donationsReceived, order.donor_sub, {
    amount_inr: order.amount_inr, fee_inr: order.fee_inr, net_inr: order.net_inr, note: order.note,
    status: "simulated", mode: "demo", ts,
  });
  addRecord(donationsGiven, ctx.sub, {
    donor_sub: order.donor_sub, amount_inr: order.amount_inr, note: order.note, status: "simulated", mode: "demo", ts,
  });
  return {
    status: 200,
    body: { order_id: orderId, status: "simulated", amount_inr: order.amount_inr, net_inr: order.net_inr, mode: "demo" },
  };
}

// Port of h_donations. Newest first, at most 50 each. `received` is for donors only.
function donationsFor(ctx) {
  if (!ctx) return UNAUTH();
  const newestFirst = (list) => [...(list || [])].reverse()
    .sort((a, b) => b.ts - a.ts)
    .slice(0, DONATION_LIST_MAX);
  const given = newestFirst(donationsGiven.get(ctx.sub)).map((r) => clone(r));
  const received = ctx.role === "donor" ? newestFirst(donationsReceived.get(ctx.sub)).map((r) => clone(r)) : [];
  return { status: 200, body: { mode: "demo", fee_pct: DONATION_FEE_PCT, given, received, received_inr: 0 } };
}

// ---- payouts ----
// Bank details a donor gives so a coordinator can pay them. Demo only: nothing moves money, and the
// transfers are the coordinator's own statement. Validation is a port of backend/payouts.py (same
// patterns, same error strings). The full account number is kept only in `profiles`; every other
// response carries the last four digits.
const PAYOUT_NAME_RE = /^[A-Za-z][A-Za-z .'-]{1,79}$/;
const PAYOUT_ACCOUNT_RE = /^[0-9]{9,18}$/;
const PAYOUT_IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const PAYOUT_UPI_RE = /^[A-Za-z0-9._-]{2,64}@[A-Za-z][A-Za-z0-9]{1,31}$/;
const PAYOUT_REFERENCE_RE = /^[A-Za-z0-9 ._/-]{3,40}$/;
const PAYOUT_MAX_TRANSFER_INR = 1000000;
const PAYOUT_NOTE = "PantryPass records details and transfers. It does not move money: make the transfer in your bank, then record its reference.";
const profiles = new Map();  // donor sub -> { holder_name, account_number, ifsc, upi, updated }
const transfers = new Map(); // donor sub -> [{ amount_inr, reference, ts }], in the order recorded

// Python str(x or "") semantics for an optional body field.
const asText = (v) => (v ? String(v) : "");
const collapseSpaces = (s) => s.split(/\s+/).filter(Boolean).join(" ");

// Port of payouts.clean_profile. Returns [profile, null] or [null, error].
function cleanProfile(body) {
  const b = body && typeof body === "object" ? body : {};
  const name = collapseSpaces(asText(b.holder_name));
  const account = asText(b.account_number).split(/\s+/).join("");
  const ifsc = asText(b.ifsc).trim().toUpperCase();
  const upi = asText(b.upi).trim();
  if (!PAYOUT_NAME_RE.test(name)) return [null, "holder_name must be the name on the account (letters, spaces, . ' -)"];
  if (!PAYOUT_ACCOUNT_RE.test(account)) return [null, "account_number must be 9 to 18 digits"];
  if (!PAYOUT_IFSC_RE.test(ifsc)) return [null, "ifsc must look like HDFC0001234"];
  if (upi && !PAYOUT_UPI_RE.test(upi)) return [null, "upi must look like name@bank"];
  return [{ holder_name: name, account_number: account, ifsc, upi }, null];
}

// Port of payouts.clean_transfer. Returns [transfer, null] or [null, error].
function cleanTransfer(body) {
  const b = body && typeof body === "object" ? body : {};
  const raw = b.amount_inr;
  let amount = NaN;
  if (typeof raw === "number" && Number.isFinite(raw)) amount = Math.trunc(raw);
  else if (typeof raw === "string" && /^\s*[+-]?[0-9]+\s*$/.test(raw)) amount = parseInt(raw, 10);
  else if (typeof raw === "boolean") amount = raw ? 1 : 0;
  if (!Number.isFinite(amount)) return [null, "amount_inr must be a whole number of rupees"];
  const ref = collapseSpaces(asText(b.reference));
  if (amount <= 0 || amount > PAYOUT_MAX_TRANSFER_INR) {
    return [null, `amount_inr must be between 1 and ${PAYOUT_MAX_TRANSFER_INR}`];
  }
  if (!PAYOUT_REFERENCE_RE.test(ref)) {
    return [null, "reference must be the bank or UPI transaction reference (3 to 40 characters)"];
  }
  return [{ amount_inr: amount, reference: ref }, null];
}

// Port of payouts.mask_upi: first two characters of the local part, then *** and the bank handle.
function maskUpi(upi) {
  if (!upi || !upi.includes("@")) return "";
  const at = upi.indexOf("@");
  return upi.slice(0, Math.min(2, at)) + "***@" + upi.slice(at + 1);
}

// Port of payouts.public_profile. Never includes the account number.
function maskedProfile(item) {
  if (!item) return { configured: false };
  return {
    configured: true,
    holder_name: item.holder_name,
    account: "XXXXXX" + item.account_number.slice(-4),
    ifsc: item.ifsc,
    upi: maskUpi(item.upi),
    updated: item.updated,
  };
}

// Newest first, as payments_for in the backend (at most 20).
function paymentsFor(sub) {
  return [...(transfers.get(sub) || [])].reverse()
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 20)
    .map(({ amount_inr, reference, ts }) => ({ amount_inr, reference, ts }));
}

function payoutProfileFor(ctx) {
  if (!ctx) return UNAUTH();
  if (ctx.role !== "donor") return fail(403, { error: "only donors have payout details", actor: ctx.sub });
  return { status: 200, body: { ...maskedProfile(profiles.get(ctx.sub)), payments: paymentsFor(ctx.sub) } };
}

function savePayoutProfileFor(ctx, rawBody) {
  if (!ctx) return UNAUTH();
  if (ctx.role !== "donor") return fail(403, { error: "only donors can add payout details", actor: ctx.sub });
  const [prof, err] = cleanProfile(rawBody);
  if (err) return fail(400, { error: err });
  profiles.set(ctx.sub, { ...prof, updated: nowSec() });
  return { status: 200, body: { ...maskedProfile(profiles.get(ctx.sub)), payments: paymentsFor(ctx.sub) } };
}

// Coordinator: the demo donor's row only, with the estimate from the fund allocation.
function payoutsFor(ctx) {
  if (!ctx) return UNAUTH();
  if (ctx.role !== "coordinator") return fail(403, { error: "coordinator only", actor: ctx.sub });
  const demoSub = subFor("donor");
  const row = fundAllocations(fundEntries()).find((r) => r.donor_sub === demoSub);
  const rows = [];
  if (row && row.estimated_inr > 0) {
    const paid = paymentsFor(demoSub);
    const paidInr = paid.reduce((n, p) => n + (p.amount_inr || 0), 0);
    rows.push({
      donor_sub: demoSub,
      points: row.points,
      estimated_inr: row.estimated_inr,
      direct_inr: 0, // simulated gifts never count as owed
      owed_inr: Math.max(row.estimated_inr - paidInr, 0),
      profile: maskedProfile(profiles.get(demoSub)),
      paid_inr: paidInr,
      payments: paid.slice(0, 5),
    });
  }
  return {
    status: 200,
    body: { demo: true, period: FUND_PERIOD, pool_inr: FUND_POOL_INR, payouts: rows, note: PAYOUT_NOTE },
  };
}

function payoutDetailsFor(ctx, donorSub) {
  if (!ctx) return UNAUTH();
  if (ctx.role !== "coordinator") return fail(403, { error: "coordinator only", actor: ctx.sub });
  const item = profiles.get(donorSub);
  if (!item) return fail(404, { error: "this donor has not added bank details" });
  return {
    status: 200,
    body: {
      donor_sub: donorSub,
      holder_name: item.holder_name,
      ifsc: item.ifsc,
      upi: item.upi,
      account_number: item.account_number,
    },
  };
}

function recordTransferFor(ctx, donorSub, rawBody) {
  if (!ctx) return UNAUTH();
  if (ctx.role !== "coordinator") return fail(403, { error: "coordinator only", actor: ctx.sub });
  if (!profiles.has(donorSub)) return fail(409, { error: "this donor has not added bank details" });
  const [tr, err] = cleanTransfer(rawBody);
  if (err) return fail(400, { error: err });
  const list = transfers.get(donorSub) || [];
  list.push({ amount_inr: tr.amount_inr, reference: tr.reference, ts: nowSec() });
  transfers.set(donorSub, list);
  return { status: 200, body: { donor_sub: donorSub, recorded: tr, payments: paymentsFor(donorSub).slice(0, 5) } };
}

api.payoutProfile = endpoint((ctx) => payoutProfileFor(ctx));
api.savePayoutProfile = endpoint((ctx, body) => savePayoutProfileFor(ctx, body));
api.payouts = endpoint((ctx) => payoutsFor(ctx));
api.payoutDetails = endpoint((ctx, donorSub) => payoutDetailsFor(ctx, donorSub));
api.recordTransfer = endpoint((ctx, donorSub, body) => recordTransferFor(ctx, donorSub, body));

// ---- donations: endpoints ----
api.donate = endpoint((ctx, body) => donateFor(ctx, body));
api.confirmDonation = endpoint((ctx, body) => confirmDonationFor(ctx, body));
api.donations = endpoint((ctx) => donationsFor(ctx));
