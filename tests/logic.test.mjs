// Run: node --test tests/
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  STAGES, nextAction, secondaryActions, exceptionKinds, qtySegments, invariantHolds,
  validateQty, clampQty, formatCountdown, secondsLeft, skewFromDate, friendlyError,
  roleFromClaims, ROLES, newIdemKey, remainingOf,
} from "../web/js/logic.js";
import { api, setSession, __tamperForTest, __advanceClockForTest } from "../web/js/mock.js";

const lot = (over = {}) => ({
  lot_id: "lot-t", stage: "RECEIVED", version: 3, donor_sub: "sub-donor", receiver_sub: "sub-receiver",
  offered: 10, donor_handoff: 10, received: 10, distributed: 0, returned: 0, disposed: 0,
  remaining: 10, count_dispute: false, callback_pending: false, ...over,
});

describe("nextAction: receiver", () => {
  const rows = [
    [{ stage: "OFFERED" }, "act", "accept"],
    [{ stage: "ACCEPTED" }, "wait", undefined],
    [{ stage: "HANDOFF_DECLARED" }, "act", "receipt"],
    [{ stage: "RECEIVED", remaining: 5 }, "act", "distribution"],
    [{ stage: "DISTRIBUTING", remaining: 5 }, "act", "distribution"],
    [{ stage: "RECEIVED", remaining: 0, distributed: 10 }, "act", "close"],
    [{ stage: "DISTRIBUTING", remaining: 0, distributed: 10 }, "act", "close"],
    [{ stage: "RECEIVED", remaining: 0, count_dispute: true }, "wait", undefined],
    [{ stage: "DISTRIBUTING", remaining: 0, count_dispute: true }, "wait", undefined],
    [{ stage: "RECEIVED", remaining: 4, count_dispute: true }, "act", "distribution"],
    [{ stage: "EXCEPTION" }, "wait", undefined],
    [{ stage: "ACCOUNTED_FOR", remaining: 0 }, "none", undefined],
  ];
  for (const [over, kind, action] of rows) {
    test(`${over.stage} remaining=${over.remaining} dispute=${!!over.count_dispute} -> ${kind} ${action ?? ""}`, () => {
      const out = nextAction(lot(over), "receiver");
      assert.equal(out.kind, kind);
      assert.equal(out.action, action);
    });
  }
});

describe("nextAction: donor", () => {
  const rows = [
    ["OFFERED", "wait", undefined],
    ["ACCEPTED", "act", "handoff"],
    ["HANDOFF_DECLARED", "wait", undefined],
    ["RECEIVED", "wait", undefined],
    ["DISTRIBUTING", "wait", undefined],
    ["EXCEPTION", "wait", undefined],
    ["ACCOUNTED_FOR", "none", undefined],
  ];
  for (const [stage, kind, action] of rows) {
    test(`${stage} -> ${kind} ${action ?? ""}`, () => {
      const out = nextAction(lot({ stage }), "donor");
      assert.equal(out.kind, kind);
      assert.equal(out.action, action);
    });
  }
});

describe("nextAction: coordinator", () => {
  const rows = [
    [{ stage: "EXCEPTION" }, "act", "review-exception"],
    [{ stage: "ACCOUNTED_FOR", count_dispute: true }, "none", undefined],
    [{ stage: "RECEIVED", count_dispute: true }, "act", "resolve-dispute"],
    [{ stage: "DISTRIBUTING", count_dispute: true, remaining: 3 }, "act", "resolve-dispute"],
    [{ stage: "RECEIVED", count_dispute: false }, "none", undefined],
    [{ stage: "OFFERED" }, "none", undefined],
  ];
  for (const [over, kind, action] of rows) {
    test(`${over.stage} dispute=${!!over.count_dispute} -> ${kind} ${action ?? ""}`, () => {
      const out = nextAction(lot(over), "coordinator");
      assert.equal(out.kind, kind);
      assert.equal(out.action, action);
    });
  }
});

describe("nextAction: non-participants and secondary actions", () => {
  test("non-participant receiver gets no action", () => {
    assert.deepEqual(nextAction(lot({ stage: "OFFERED" }), "receiver", false).kind, "none");
  });
  test("non-participant donor gets no action", () => {
    assert.deepEqual(nextAction(lot({ stage: "ACCEPTED" }), "donor", false).kind, "none");
  });
  test("receiver can dispose while remaining > 0 only", () => {
    assert.deepEqual(secondaryActions(lot({ stage: "RECEIVED", remaining: 2 }), "receiver"),
      [{ action: "disposition", label: "Return or dispose" }]);
    assert.deepEqual(secondaryActions(lot({ stage: "DISTRIBUTING", remaining: 0 }), "receiver"), []);
    assert.deepEqual(secondaryActions(lot({ stage: "RECEIVED", remaining: 2 }), "donor"), []);
  });
});

describe("ROLES and roleFromClaims", () => {
  test("ROLES lists the three roles", () => {
    assert.deepEqual(ROLES, ["donor", "receiver", "coordinator"]);
  });
  test("array claim", () => {
    assert.equal(roleFromClaims({ "cognito:groups": ["donor"] }), "donor");
    assert.equal(roleFromClaims({ "cognito:groups": ["coordinator"] }), "coordinator");
    assert.equal(roleFromClaims({ "cognito:groups": ["receiver", "coordinator"] }), "receiver");
  });
  test("string claim", () => {
    assert.equal(roleFromClaims({ "cognito:groups": "[donor]" }), "donor");
    assert.equal(roleFromClaims({ "cognito:groups": "coordinator, receiver" }), "receiver");
    assert.equal(roleFromClaims({ "cognito:groups": "donor receiver" }), "donor");
  });
  test("no or unknown groups -> user", () => {
    assert.equal(roleFromClaims({}), "user");
    assert.equal(roleFromClaims(), "user");
    assert.equal(roleFromClaims({ "cognito:groups": "nobody" }), "user");
  });
});

describe("quantities", () => {
  test("qtySegments percentages sum to ~100 and follow the stock split", () => {
    const segs = qtySegments(lot({ received: 10, distributed: 4, returned: 2, disposed: 1, remaining: 3 }));
    assert.deepEqual(segs.map((s) => s.key), ["distributed", "returned", "disposed", "remaining"]);
    assert.deepEqual(segs.map((s) => Math.round(s.pct)), [40, 20, 10, 30]);
    assert.ok(Math.abs(segs.reduce((sum, s) => sum + s.pct, 0) - 100) < 1e-9);
  });
  test("qtySegments sums to ~100 for several shapes", () => {
    const shapes = [
      { received: 7, distributed: 3, returned: 0, disposed: 0, remaining: 4 },
      { received: 9, distributed: 0, returned: 0, disposed: 0, remaining: 9 },
      { received: 13, distributed: 5, returned: 4, disposed: 2, remaining: 2 },
    ];
    for (const s of shapes) {
      const total = qtySegments(lot(s)).reduce((sum, seg) => sum + seg.pct, 0);
      assert.ok(Math.abs(total - 100) < 1e-9, `sum was ${total}`);
    }
  });
  test("qtySegments before receipt is one remaining segment over offered", () => {
    const segs = qtySegments(lot({ stage: "HANDOFF_DECLARED", offered: 8, received: null, remaining: null }));
    assert.equal(segs.length, 1);
    assert.equal(segs[0].key, "remaining");
    assert.equal(segs[0].pct, 100);
  });
  test("qtySegments is empty when there is nothing to show", () => {
    assert.deepEqual(qtySegments(lot({ received: 0, remaining: 0, distributed: 0 })), []);
    assert.deepEqual(qtySegments(lot({ stage: "OFFERED", offered: 0, received: null })), []);
  });
  test("invariantHolds true for consistent stock", () => {
    assert.equal(invariantHolds(lot({ received: 10, distributed: 4, returned: 2, disposed: 1, remaining: 3 })), true);
  });
  test("invariantHolds false when remaining disagrees", () => {
    assert.equal(invariantHolds(lot({ received: 10, distributed: 4, returned: 2, disposed: 1, remaining: 5 })), false);
  });
  test("invariantHolds true before receipt", () => {
    assert.equal(invariantHolds(lot({ received: null, remaining: null })), true);
  });
  test("remaining is derived when the field is missing", () => {
    const l = lot({ received: 10, distributed: 4, returned: 2, disposed: 1 });
    delete l.remaining;
    assert.equal(remainingOf(l), 3);
    assert.equal(invariantHolds(l), true);
  });
  test("validateQty: offered", () => {
    assert.equal(validateQty("offered", 0, lot()), "Offer at least 1.");
    assert.equal(validateQty("offered", 3, lot()), "");
    assert.equal(validateQty("offered", 2.5, lot()), "Enter a whole number.");
    assert.equal(validateQty("offered", NaN, lot()), "Enter a whole number.");
  });
  test("validateQty: donor_handoff is 0..offered", () => {
    assert.equal(validateQty("donor_handoff", 0, lot({ offered: 10 })), "");
    assert.equal(validateQty("donor_handoff", 10, lot({ offered: 10 })), "");
    assert.equal(validateQty("donor_handoff", 11, lot({ offered: 10 })), "Between 0 and 10.");
    assert.equal(validateQty("donor_handoff", -1, lot({ offered: 10 })), "Between 0 and 10.");
  });
  test("validateQty: received and disposition cannot be negative", () => {
    assert.equal(validateQty("received", -1, lot()), "Cannot be negative.");
    assert.equal(validateQty("received", 0, lot()), "");
    assert.equal(validateQty("disposition", -2, lot()), "Cannot be negative.");
    assert.equal(validateQty("disposition", 0, lot()), "");
  });
  test("validateQty: distributed is 1..remaining", () => {
    assert.equal(validateQty("distributed", 0, lot({ remaining: 4 })), "Report at least 1.");
    assert.equal(validateQty("distributed", 5, lot({ remaining: 4 })), "Only 4 remaining.");
    assert.equal(validateQty("distributed", 4, lot({ remaining: 4 })), "");
  });
  test("validateQty: unknown kind passes", () => {
    assert.equal(validateQty("unknown", 1, lot()), "");
  });
  test("clampQty clamps and truncates", () => {
    assert.equal(clampQty(5, 0, 3), 3);
    assert.equal(clampQty(-2, 0, 3), 0);
    assert.equal(clampQty(2.9, 0, 10), 2);
    assert.equal(clampQty(7, 0, 10), 7);
    assert.equal(clampQty(NaN, 1, 10), 1);
  });
});

describe("countdowns and clock skew", () => {
  test("formatCountdown", () => {
    assert.equal(formatCountdown(null), "");
    assert.equal(formatCountdown(0), "0:00");
    assert.equal(formatCountdown(-5), "0:00");
    assert.equal(formatCountdown(59), "0:59");
    assert.equal(formatCountdown(90), "1:30");
    assert.equal(formatCountdown(3600), "1:00:00");
    assert.equal(formatCountdown(3725), "1:02:05");
  });
  test("secondsLeft without skew", () => {
    assert.equal(secondsLeft(1_800_000_000, 0, 1_799_999_400_000), 600);
    assert.equal(secondsLeft(null), null);
  });
  test("secondsLeft floors fractional seconds", () => {
    assert.equal(secondsLeft(1_800_000_000, 0, 1_799_999_400_500), 599);
  });
  test("secondsLeft applies server skew (server ahead / behind)", () => {
    const client = 1_799_999_400_000;
    assert.equal(secondsLeft(1_800_000_000, 60_000, client), 540);
    assert.equal(secondsLeft(1_800_000_000, -120_000, client), 720);
  });
  test("skewFromDate reads the Date header against the client clock", () => {
    const now = Date.UTC(2026, 9, 10, 12, 0, 0);
    const header = new Date(now + 5000).toUTCString();
    assert.equal(skewFromDate(header, now), 5000);
  });
  test("skewFromDate falls back to 0 for missing or bad headers", () => {
    assert.equal(skewFromDate(undefined, 1000), 0);
    assert.equal(skewFromDate("not a date", 1000), 0);
  });
  test("skew + secondsLeft agree with the server's clock", () => {
    const now = Date.UTC(2026, 9, 10, 12, 0, 0);
    const serverNow = now - 30_000; // client is 30s ahead
    const header = new Date(serverNow).toUTCString();
    const epoch = Math.floor(serverNow / 1000) + 90;
    const skew = skewFromDate(header, now);
    assert.equal(secondsLeft(epoch, skew, now), 90);
  });
});

describe("exceptionKinds", () => {
  test("buckets", () => {
    assert.deepEqual(exceptionKinds(lot({ stage: "EXCEPTION" })), ["unanswered"]);
    assert.deepEqual(exceptionKinds(lot({ stage: "RECEIVED", count_dispute: true })), ["dispute"]);
    assert.deepEqual(exceptionKinds(lot({ stage: "RECEIVED", callback_pending: true })), ["callback"]);
    assert.deepEqual(exceptionKinds(lot({ stage: "EXCEPTION", count_dispute: true, callback_pending: true })),
      ["unanswered", "dispute", "callback"]);
    assert.deepEqual(exceptionKinds(lot({ stage: "ACCOUNTED_FOR", count_dispute: true })), []);
    assert.deepEqual(exceptionKinds(lot({ stage: "RECEIVED" })), []);
  });
});

describe("friendlyError", () => {
  test("401 asks to sign in again", () => {
    assert.equal(friendlyError(401).title, "Session expired");
  });
  test("403 names the actor, action and lot", () => {
    const e = friendlyError(403, { actor: "sub-donor", action: "ReportDistribution", lot_id: "lot-1" });
    assert.equal(e.title, "Refused by Verified Permissions");
    assert.match(e.detail, /sub-donor/);
    assert.match(e.detail, /ReportDistribution/);
    assert.match(e.detail, /lot-1/);
  });
  test("404", () => {
    assert.equal(friendlyError(404).title, "Lot not found");
  });
  test("409 invalid stage", () => {
    assert.equal(friendlyError(409, { error: "invalid stage" }).title, "This lot moved on");
  });
  test("409 stale version", () => {
    assert.equal(friendlyError(409, { error: "stale or missing expected_version" }).title,
      "This lot changed while you were looking");
  });
  test("409 other errors show the server text", () => {
    const e = friendlyError(409, { error: "cannot close: outstanding stock remains" });
    assert.equal(e.title, "Not allowed right now");
    assert.equal(e.detail, "cannot close: outstanding stock remains");
  });
  test("0 is offline and says nothing changed", () => {
    const e = friendlyError(0);
    assert.equal(e.title, "You look offline");
    assert.match(e.detail, /Nothing was changed/);
  });
  test("other statuses fall back to the server text or a default", () => {
    assert.deepEqual(friendlyError(500, { error: "boom" }), { title: "Something went wrong", detail: "boom" });
    assert.equal(friendlyError(500, {}).detail, "Please try again.");
  });
});

describe("stages and idempotency keys", () => {
  test("STAGES is the happy-path order", () => {
    assert.deepEqual(STAGES, ["OFFERED", "ACCEPTED", "HANDOFF_DECLARED", "RECEIVED", "DISTRIBUTING", "ACCOUNTED_FOR"]);
  });
  test("newIdemKey is prefixed and unique", () => {
    const a = newIdemKey("acc");
    const b = newIdemKey("acc");
    assert.ok(a.startsWith("acc-"));
    assert.notEqual(a, b);
  });
});

// ---------------------------------------------------------------- mock api

const DONOR = { role: "donor", sub: "sub-donor", name: "Dana" };
const RECEIVER = { role: "receiver", sub: "sub-receiver", name: "Rhys" };
const COORDINATOR = { role: "coordinator", sub: "sub-coordinator", name: "Cass" };

// Creates an offered lot, accepted and handed off at `offered`, received at `received`.
// Leaves the lot at RECEIVED with version 4 (or whatever the flow produces).
async function lotAtReceived({ offered = 8, declared = offered, received = offered } = {}) {
  setSession(DONOR);
  const created = await api.createLot({ receiver_sub: "sub-receiver", offered });
  const id = created.body.lot.lot_id;
  setSession(RECEIVER);
  await api.accept(id, { idem_key: `acc-${id}`, expected_version: 1 });
  setSession(DONOR);
  await api.handoff(id, { idem_key: `hand-${id}`, expected_version: 2, donor_handoff: declared });
  setSession(RECEIVER);
  const r = await api.receipt(id, { idem_key: `rec-${id}`, expected_version: 3, received });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return id;
}

describe("mock api: happy path", () => {
  test("create -> accept -> handoff -> receipt -> distribution -> disposition -> close -> ACCOUNTED_FOR", async () => {
    setSession(DONOR);
    const created = await api.createLot({ receiver_sub: "sub-receiver", offered: 8 });
    assert.equal(created.ok, true);
    assert.equal(created.status, 201);
    assert.ok(created.serverDate);
    const id = created.body.lot.lot_id;
    assert.equal(created.body.lot.stage, "OFFERED");
    assert.equal(created.body.lot.version, 1);
    assert.equal(created.body.lot.response_deadline_epoch - created.body.lot.created_epoch, 90);
    assert.equal(created.body.lot.cutoff_epoch - created.body.lot.created_epoch, 3600);

    setSession(RECEIVER);
    let r = await api.accept(id, { idem_key: "a1", expected_version: 1 });
    assert.equal(r.status, 200);
    assert.equal(r.body.stage, "ACCEPTED");
    assert.equal(r.body.version, 2);

    setSession(DONOR);
    r = await api.handoff(id, { idem_key: "h1", expected_version: 2, donor_handoff: 8 });
    assert.equal(r.body.stage, "HANDOFF_DECLARED");
    assert.equal(r.body.version, 3);

    setSession(RECEIVER);
    r = await api.receipt(id, { idem_key: "r1", expected_version: 3, received: 8 });
    assert.equal(r.body.stage, "RECEIVED");
    assert.equal(r.body.count_dispute, false);
    assert.equal(r.body.remaining, 8);
    assert.equal(r.body.version, 4);

    r = await api.distribution(id, { idem_key: "d1", expected_version: 4, distributed: 5 });
    assert.equal(r.body.distributed, 5);
    assert.equal(r.body.remaining, 3);
    assert.equal(r.body.stage, "DISTRIBUTING");
    assert.equal(r.body.version, 5);

    r = await api.disposition(id, { idem_key: "p1", expected_version: 5, returned: 1, disposed: 2 });
    assert.equal(r.status, 200);
    assert.equal(r.body.returned, 1);
    assert.equal(r.body.disposed, 2);
    assert.equal(r.body.remaining, 0);
    assert.equal(r.body.version, 6);

    r = await api.close(id, { idem_key: "c1", expected_version: 6 });
    assert.equal(r.body.stage, "ACCOUNTED_FOR");
    assert.equal(r.body.version, 7);

    const got = await api.getLot(id);
    assert.equal(got.status, 200);
    const final = got.body.lot;
    assert.equal(final.stage, "ACCOUNTED_FOR");
    assert.equal(final.received, 8);
    assert.equal(final.distributed + final.returned + final.disposed + final.remaining, final.received);
    assert.equal(invariantHolds(final), true);
    assert.deepEqual(got.body.events.map((e) => e.action),
      ["CreateLot", "Accept", "DeclareHandoff", "Receipt", "ReportDistribution", "ReportDisposition", "Close"]);
  });

  test("donor is refused on distribution: 403 VP_DENY and a DENY event on the lot", async () => {
    const id = await lotAtReceived({ offered: 8 });
    setSession(DONOR);
    const denied = await api.distribution(id, { idem_key: "x1", expected_version: 4, distributed: 1 });
    assert.equal(denied.ok, false);
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error, "VP_DENY");
    assert.equal(denied.body.action, "ReportDistribution");
    assert.equal(denied.body.actor, "sub-donor");
    assert.equal(denied.body.lot_id, id);
    assert.equal(denied.body.decision, "DENY");
    assert.equal(typeof denied.body.request_id, "string");

    const got = await api.getLot(id);
    const last = got.body.events.at(-1);
    assert.equal(last.decision, "DENY");
    assert.equal(last.action, "ReportDistribution");
    assert.equal(last.actor, "sub-donor");
    assert.equal(got.body.lot.distributed, 0);
    assert.equal(got.body.lot.version, 4);
  });

  test("idempotent replay returns the stored response and does not double count", async () => {
    const id = await lotAtReceived({ offered: 8 });
    setSession(RECEIVER);
    const first = await api.distribution(id, { idem_key: "dup-1", expected_version: 4, distributed: 5 });
    assert.equal(first.status, 200);
    assert.equal(first.body.distributed, 5);

    // Same key, stale expected_version: the stored result comes back, nothing changes.
    const replay = await api.distribution(id, { idem_key: "dup-1", expected_version: 4, distributed: 5 });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.distributed, 5);
    assert.equal(replay.body.version, 5);

    const got = await api.getLot(id);
    assert.equal(got.body.lot.distributed, 5);
    assert.equal(got.body.lot.remaining, 3);
    assert.equal(got.body.events.filter((e) => e.action === "ReportDistribution").length, 1);
  });

  test("stale expected_version is a 409 and leaves the lot alone", async () => {
    setSession(DONOR);
    const created = await api.createLot({ receiver_sub: "sub-receiver", offered: 5 });
    const id = created.body.lot.lot_id;
    setSession(RECEIVER);
    assert.equal((await api.accept(id, { idem_key: "s-acc", expected_version: 1 })).status, 200);

    setSession(DONOR);
    const stale = await api.handoff(id, { idem_key: "s-hand-old", expected_version: 1, donor_handoff: 5 });
    assert.equal(stale.ok, false);
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, "stale or missing expected_version");
    assert.equal(stale.body.version, 2);

    const ok = await api.handoff(id, { idem_key: "s-hand", expected_version: 2, donor_handoff: 5 });
    assert.equal(ok.status, 200);
  });

  test("wrong stage is a 409 invalid stage", async () => {
    setSession(DONOR);
    const created = await api.createLot({ receiver_sub: "sub-receiver", offered: 5 });
    setSession(RECEIVER);
    const r = await api.distribution(created.body.lot.lot_id, { idem_key: "ws", expected_version: 1, distributed: 1 });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "invalid stage");
    assert.equal(r.body.stage, "OFFERED");
  });

  test("distribution cannot exceed remaining stock", async () => {
    const id = await lotAtReceived({ offered: 8 });
    setSession(RECEIVER);
    const r = await api.distribution(id, { idem_key: "over", expected_version: 4, distributed: 9 });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "distributed exceeds remaining received stock");
    assert.equal(r.body.remaining, 8);
  });

  test("close is blocked while stock remains", async () => {
    const id = await lotAtReceived({ offered: 8 });
    setSession(RECEIVER);
    const r = await api.close(id, { idem_key: "early", expected_version: 4 });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "cannot close: outstanding stock remains");
  });

  test("count dispute: receipt flags it, close waits, coordinator resolves", async () => {
    // Donor declared 8 but receiver reported 7: dispute.
    const id = await lotAtReceived({ offered: 8, declared: 8, received: 7 });
    setSession(RECEIVER);
    let got = await api.getLot(id);
    assert.equal(got.body.lot.count_dispute, true);

    let r = await api.distribution(id, { idem_key: "dd", expected_version: 4, distributed: 7 });
    assert.equal(r.status, 200);

    r = await api.close(id, { idem_key: "dc", expected_version: 5 });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "cannot close: unresolved count dispute");

    setSession(RECEIVER);
    r = await api.resolveDispute(id, { idem_key: "rx", expected_version: 5, reconciled_received: 8 });
    assert.equal(r.status, 403);
    assert.equal(r.body.action, "ResolveDispute");

    setSession(COORDINATOR);
    r = await api.resolveDispute(id, { idem_key: "rb", expected_version: 5, reconciled_received: 6 });
    assert.equal(r.status, 409);
    assert.equal(r.body.minimum, 7);

    r = await api.resolveDispute(id, { idem_key: "ok", expected_version: 5, reconciled_received: 8 });
    assert.equal(r.status, 200);
    assert.equal(r.body.count_dispute, false);
    assert.equal(r.body.remaining, 1);

    setSession(RECEIVER);
    r = await api.distribution(id, { idem_key: "last", expected_version: 6, distributed: 1 });
    assert.equal(r.status, 200);
    r = await api.close(id, { idem_key: "fin", expected_version: 7 });
    assert.equal(r.body.stage, "ACCOUNTED_FOR");
  });

  test("only donors create lots; other roles get a VP_DENY", async () => {
    setSession(RECEIVER);
    const r = await api.createLot({ receiver_sub: "sub-receiver", offered: 3 });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "VP_DENY");
    assert.equal(r.body.action, "CreateLot");
  });

  test("lists are filtered per role; coordinator sees seeded demo lots, newest first", async () => {
    setSession(COORDINATOR);
    const all = await api.listLots();
    assert.equal(all.ok, true);
    assert.ok(all.body.lots.length >= 2);
    assert.ok(all.body.lots.some((l) => l.stage === "RECEIVED" && l.count_dispute === true));
    assert.ok(all.body.lots.some((l) => l.stage === "DISTRIBUTING" && l.remaining > 0));
    const epochs = all.body.lots.map((l) => l.created_epoch);
    assert.ok(epochs.every((e, i) => i === 0 || epochs[i - 1] >= e));

    setSession(DONOR);
    const mine = await api.listLots();
    assert.ok(mine.body.lots.every((l) => l.donor_sub === "sub-donor"));
  });

  test("non-participants are refused on getLot; no session gives 401 and never throws", async () => {
    const id = await lotAtReceived({ offered: 2 });
    setSession({ role: "donor", sub: "sub-someone-else" });
    const other = await api.getLot(id);
    assert.equal(other.status, 403);

    setSession(null);
    const anon = await api.listLots();
    assert.equal(anon.ok, false);
    assert.equal(anon.status, 401);
    const anonGet = await api.getLot(id);
    assert.equal(anonGet.status, 401);
  });
});

describe("friendlyError: pickup codes", () => {
  test("invalid code says how many attempts are left", () => {
    const e = friendlyError(409, { error: "pickup code invalid", attempts_left: 3 });
    assert.equal(e.title, "Pickup code does not match");
    assert.match(e.detail, /3 attempts left/);
  });
  test("expired and locked codes say the receipt can still be recorded without one", () => {
    assert.match(friendlyError(409, { error: "pickup code expired" }).detail, /not confirmed in person/);
    assert.equal(friendlyError(409, { error: "pickup code attempt limit reached" }).title, "Too many wrong codes");
  });
});

// ---------------------------------------------------------------- trust record

// Creates and accepts a lot, then declares the handoff as the donor. Leaves it at HANDOFF_DECLARED.
// Returns the lot id and the one-time pickup code from the handoff response.
async function lotAtHandoff({ offered = 6 } = {}) {
  setSession(DONOR);
  const created = await api.createLot({ receiver_sub: "sub-receiver", offered });
  const id = created.body.lot.lot_id;
  setSession(RECEIVER);
  await api.accept(id, { idem_key: `acc-${id}`, expected_version: 1 });
  setSession(DONOR);
  const h = await api.handoff(id, { idem_key: `hand-${id}`, expected_version: 2, donor_handoff: offered });
  assert.equal(h.status, 200, JSON.stringify(h.body));
  return { id, code: h.body.pickup_code, handoff: h };
}

// Every leaf value in a JSON-like object, as strings.
function leafValues(v, out = []) {
  if (v && typeof v === "object") Object.values(v).forEach((x) => leafValues(x, out));
  else out.push(String(v));
  return out;
}

const wrongCodeFor = (code) => (code === "000000" ? "000001" : "000000");

describe("trust record: pickup code", () => {
  test("handoff returns a 6-digit code and an expiry one hour out; a replay returns neither the code nor a new one", async () => {
    const { id, code, handoff } = await lotAtHandoff({ offered: 4 });
    assert.match(code, /^\d{6}$/);
    const now = Math.floor(Date.now() / 1000);
    assert.ok(Math.abs(handoff.body.pickup_expires_epoch - (now + 3600)) <= 5);

    setSession(DONOR);
    const replay = await api.handoff(id, { idem_key: `hand-${id}`, expected_version: 2, donor_handoff: 4 });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.pickup_code, undefined);
    assert.equal(replay.body.pickup_expires_epoch, handoff.body.pickup_expires_epoch);
  });

  test("the code is not in any lot or event response, for donor or receiver", async () => {
    const { id, code } = await lotAtHandoff({ offered: 4 });
    for (const who of [DONOR, RECEIVER]) {
      setSession(who);
      const got = await api.getLot(id);
      assert.equal(got.status, 200);
      assert.equal(JSON.stringify(got.body).includes('"pickup_code"'), false);
      assert.equal(leafValues(got.body).includes(code), false);
      assert.equal(JSON.stringify(got.body).includes("pickup_hash"), false);
      assert.equal(JSON.stringify(got.body).includes("pickup_salt"), false);
    }
    setSession(COORDINATOR);
    const list = await api.listLots();
    assert.equal(leafValues(list.body).includes(code), false);
  });

  test("a valid code confirms the receipt in person on the lot and the event", async () => {
    const { id, code } = await lotAtHandoff({ offered: 5 });
    setSession(RECEIVER);
    const r = await api.receipt(id, { idem_key: `rec-${id}`, expected_version: 3, received: 5, pickup_code: code });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.confirmed_in_person, true);
    assert.equal(r.body.stage, "RECEIVED");

    const got = await api.getLot(id);
    assert.equal(got.body.lot.confirmed_in_person, true);
    const receiptEvent = got.body.events.find((e) => e.action === "Receipt");
    assert.equal(JSON.parse(receiptEvent.result).confirmed_in_person, true);
  });

  test("a receipt without a code still works and records confirmed_in_person false", async () => {
    const { id } = await lotAtHandoff({ offered: 5 });
    setSession(RECEIVER);
    const r = await api.receipt(id, { idem_key: `rec-${id}`, expected_version: 3, received: 5 });
    assert.equal(r.status, 200);
    assert.equal(r.body.confirmed_in_person, false);
    assert.equal((await api.getLot(id)).body.lot.confirmed_in_person, false);
  });

  test("wrong codes count down attempts_left, then the limit is reached and even the right code is refused", async () => {
    const { id, code } = await lotAtHandoff({ offered: 5 });
    setSession(RECEIVER);
    for (let k = 1; k <= 5; k++) {
      const r = await api.receipt(id, { idem_key: `bad-${k}`, expected_version: 3, received: 5, pickup_code: wrongCodeFor(code) });
      assert.equal(r.status, 409);
      assert.equal(r.body.error, "pickup code invalid");
      assert.equal(r.body.attempts_left, 5 - k);
    }
    const limit = await api.receipt(id, { idem_key: "bad-6", expected_version: 3, received: 5, pickup_code: wrongCodeFor(code) });
    assert.equal(limit.status, 409);
    assert.equal(limit.body.error, "pickup code attempt limit reached");

    const right = await api.receipt(id, { idem_key: "right-late", expected_version: 3, received: 5, pickup_code: code });
    assert.equal(right.body.error, "pickup code attempt limit reached");

    // Refused attempts changed nothing on the lot: the version is still 3 and the stage is unchanged.
    const got = await api.getLot(id);
    assert.equal(got.body.lot.stage, "HANDOFF_DECLARED");
    assert.equal(got.body.lot.version, 3);
    assert.equal(got.body.events.filter((e) => e.action === "Receipt").length, 0);

    const plain = await api.receipt(id, { idem_key: "plain", expected_version: 3, received: 5 });
    assert.equal(plain.status, 200);
    assert.equal(plain.body.confirmed_in_person, false);
  });

  test("an expired code is refused with 409 and nothing changes", async () => {
    const { id, code } = await lotAtHandoff({ offered: 5 });
    setSession(RECEIVER);
    __advanceClockForTest(3601);
    try {
      const r = await api.receipt(id, { idem_key: "late", expected_version: 3, received: 5, pickup_code: code });
      assert.equal(r.status, 409);
      assert.equal(r.body.error, "pickup code expired");
    } finally {
      __advanceClockForTest(-3601);
    }
    assert.equal((await api.getLot(id)).body.lot.stage, "HANDOFF_DECLARED");
  });
});

describe("trust record: hash chain verification", () => {
  test("a clean chain verifies, DENY events sit outside it, and tampering is detected", async () => {
    const id = await lotAtReceived({ offered: 8 });
    setSession(DONOR);
    const denied = await api.distribution(id, { idem_key: "vdeny", expected_version: 4, distributed: 1 });
    assert.equal(denied.status, 403);

    setSession(RECEIVER);
    const ok = await api.verifyLot(id);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.reason, null);
    assert.equal(ok.body.broken_at, null);
    assert.equal(ok.body.legacy, 0);

    const got = await api.getLot(id);
    const chained = got.body.events.filter((e) => e.hash);
    assert.equal(ok.body.length, chained.length);
    assert.equal(ok.body.lot_head, got.body.lot.chain_head);
    assert.equal(ok.body.head, got.body.lot.chain_head);
    assert.equal(chained[0].prev_hash, "");
    assert.equal(chained[1].prev_hash, chained[0].hash);

    assert.equal(__tamperForTest(id), true);
    const bad = await api.verifyLot(id);
    assert.equal(bad.status, 200);
    assert.equal(bad.body.ok, false);
    assert.equal(typeof bad.body.reason, "string");
    assert.ok(bad.body.broken_at);
  });

  test("verify is refused to a non-participant and to a donor of someone else's lot", async () => {
    const id = await lotAtReceived({ offered: 2 });
    setSession({ role: "donor", sub: "sub-someone-else" });
    const r = await api.verifyLot(id);
    assert.equal(r.status, 403);
    setSession(RECEIVER);
    assert.equal((await api.verifyLot("lot-does-not-exist")).status, 404);
  });
});

describe("impact", () => {
  test("coordinator gets the documented fields; a confirmed receipt moves the counts", async () => {
    setSession(COORDINATOR);
    const before = await api.impact();
    assert.equal(before.status, 200);
    assert.deepEqual(Object.keys(before.body).sort(), [
      "accounted_for", "by_unit", "confirmed_in_person", "disposed", "disputes_caught", "distributed",
      "exceptions_raised", "lots", "mixed_units", "offered", "received", "returned",
    ]);

    const { id, code } = await lotAtHandoff({ offered: 3 });
    setSession(RECEIVER);
    await api.receipt(id, { idem_key: "imp-rec", expected_version: 3, received: 3, pickup_code: code });
    setSession(COORDINATOR);
    const after = await api.impact();
    assert.equal(after.body.lots, before.body.lots + 1);
    assert.equal(after.body.confirmed_in_person, before.body.confirmed_in_person + 1);
    assert.equal(after.body.offered, before.body.offered + 3);
  });

  test("donor and receiver get 403 coordinator only; no session gets 401", async () => {
    setSession(DONOR);
    const d = await api.impact();
    assert.equal(d.status, 403);
    assert.equal(d.body.error, "coordinator only");
    setSession(RECEIVER);
    assert.equal((await api.impact()).status, 403);
    setSession(null);
    assert.equal((await api.impact()).status, 401);
  });
});
