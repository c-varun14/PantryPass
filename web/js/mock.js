// In-memory fake of the PantryPass API for the UI and for node tests.
// Rules mirror backend/api.py (authoritative for order of checks and error strings)
// and docs/api.md (contract). Exports the real client's surface: `api` and `setSession`.
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
  Accept: isReceiverOf,
  DeclareHandoff: isDonorOf,
  Receipt: isReceiverOf,
  ReportDistribution: isReceiverOf,
  ReportDisposition: isReceiverOf,
  Close: isReceiverOf,
  ResolveDispute: isCoordinator,
  RetryCallbacks: isCoordinator,
};

// Per-action state rules. Each returns either fail(status, body) or { patch, result }.
// Checks run in the same order as api.py.
const PERFORM = {
  Accept: () => ({ patch: { stage: "ACCEPTED" }, result: { stage: "ACCEPTED" } }),

  // Fresh handoffs issue a pickup code. The code goes only into `pickupCode` (returned once);
  // the stored result, and so any replay, never carries it.
  DeclareHandoff(lot, body) {
    const qty = asInt(body.donor_handoff);
    if (qty === null || qty < 0 || qty > lot.offered) {
      return fail(409, { error: "donor_handoff must be between 0 and offered", offered: lot.offered });
    }
    const expires = nowSec() + PICKUP_TTL_SECONDS;
    const { code, pickup } = newPickupCode();
    return {
      patch: { stage: "HANDOFF_DECLARED", donor_handoff: qty, pickup_expires_epoch: expires },
      result: { donor_handoff: qty, stage: "HANDOFF_DECLARED", pickup_expires_epoch: expires },
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
    return {
      patch: {
        stage: "RECEIVED", received, remaining: received,
        distributed: 0, returned: 0, disposed: 0, count_dispute, confirmed_in_person,
      },
      result: {
        received, remaining: received, distributed: 0, returned: 0, disposed: 0,
        count_dispute, confirmed_in_person, stage: "RECEIVED",
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

  const out = PERFORM[action](lot, body, rec);
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
function createLot(ctx, rawBody) {
  if (!ctx) return UNAUTH();
  const body = rawBody && typeof rawBody === "object" ? rawBody : {};
  if (ctx.role !== "donor") return deny(ctx, null, "CreateLot", undefined);
  const offered = asInt(body.offered);
  if (!body.receiver_sub || offered === null || offered <= 0) {
    return fail(400, { error: "receiver_sub and a positive offered are required" });
  }
  const t = nowSec();
  const lot = {
    lot_id: forcedId || randomLotId(),
    stage: "OFFERED",
    version: 1,
    donor_sub: ctx.sub,
    receiver_sub: String(body.receiver_sub),
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
    result: JSON.stringify({ offered, receiver_sub: lot.receiver_sub, cutoff_epoch: lot.cutoff_epoch }),
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

function listLots(ctx) {
  if (!ctx) return UNAUTH();
  const matches = [...records.values()].filter((rec) => visibleTo(ctx, rec.lot));
  matches.sort((a, b) => b.seq - a.seq);
  return { status: 200, body: { lots: matches.map((rec) => clone(rec.lot)) } };
}

const isParticipant = (ctx, lot) => ctx.role === "coordinator"
  || lot.donor_sub === ctx.sub
  || lot.receiver_sub === ctx.sub;

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
  return {
    status: 200,
    body: {
      lots: lots.length,
      offered: sum("offered"),
      received: sum("received"),
      distributed: sum("distributed"),
      returned: sum("returned"),
      disposed: sum("disposed"),
      accounted_for: lots.filter((l) => l.stage === "ACCOUNTED_FOR").length,
      disputes_caught: countEvents("ResolveDispute") + lots.filter((l) => l.count_dispute).length,
      exceptions_raised: countEvents("ResponseDeadlineMissed"),
      confirmed_in_person: lots.filter((l) => l.confirmed_in_person).length,
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
  const receiverSub = receiver.sub;

  // A: RECEIVED with a count dispute (donor declared 10, receiver reported 8).
  forcedId = "lot-c011de5d15a7";
  const a = createLot(donor, { receiver_sub: receiverSub, offered: 10 }).body.lot.lot_id;
  mutate(receiver, a, "Accept", { idem_key: "seed-a-accept", expected_version: 1 }, ["OFFERED"]);
  mutate(donor, a, "DeclareHandoff", { idem_key: "seed-a-handoff", expected_version: 2, donor_handoff: 10 }, ["ACCEPTED"]);
  mutate(receiver, a, "Receipt", { idem_key: "seed-a-receipt", expected_version: 3, received: 8 }, ["HANDOFF_DECLARED"]);

  // B: DISTRIBUTING, partly distributed (12 received, 5 distributed, 7 remaining).
  forcedId = "lot-a8f122b04e19";
  const b = createLot(donor, { receiver_sub: receiverSub, offered: 12 }).body.lot.lot_id;
  forcedId = null;
  mutate(receiver, b, "Accept", { idem_key: "seed-b-accept", expected_version: 1 }, ["OFFERED"]);
  mutate(donor, b, "DeclareHandoff", { idem_key: "seed-b-handoff", expected_version: 2, donor_handoff: 12 }, ["ACCEPTED"]);
  mutate(receiver, b, "Receipt", { idem_key: "seed-b-receipt", expected_version: 3, received: 12 }, ["HANDOFF_DECLARED"]);
  mutate(receiver, b, "ReportDistribution", { idem_key: "seed-b-dist", expected_version: 4, distributed: 5 }, ["RECEIVED", "DISTRIBUTING"]);
}

export const api = {
  listLots: endpoint((ctx) => listLots(ctx)),
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
