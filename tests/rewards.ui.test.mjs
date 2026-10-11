// Trust points through the mock: each rule, the level and badge arithmetic, and isolation.
// Run: node --test tests/   (every person here has a fresh sub, so seeded demo points do not interfere)
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { api, setSession, __tamperForTest, __advanceClockForTest } from "../web/js/mock.js";

const people = (t) => ({
  donor: { role: "donor", sub: `sub-donor-${t}`, name: "Dana" },
  receiver: { role: "receiver", sub: `sub-receiver-${t}`, name: "Rhys" },
  coordinator: { role: "coordinator", sub: `sub-coord-${t}`, name: "Cass" },
});
let seq = 0;
const fresh = () => people(`${process.pid}-${++seq}`);

async function offerAndAccept(p, offered = 8) {
  setSession(p.donor);
  const created = await api.createLot({ receiver_sub: p.receiver.sub, offered });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.lot.lot_id;
  setSession(p.receiver);
  const acc = await api.accept(id, { idem_key: `acc-${id}`, expected_version: 1 });
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
  return id;
}

// Returns the pickup code issued by the handoff (only the fresh response carries it).
async function handOff(p, id, declared) {
  setSession(p.donor);
  const r = await api.handoff(id, { idem_key: `hand-${id}`, expected_version: 2, donor_handoff: declared });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.pickup_code;
}

async function receive(p, id, received, pickup_code) {
  setSession(p.receiver);
  const body = { idem_key: `rec-${id}`, expected_version: 3, received };
  if (pickup_code !== undefined) body.pickup_code = pickup_code;
  const r = await api.receipt(id, body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r;
}

async function distributeAll(p, id, qty, version = 4) {
  setSession(p.receiver);
  const r = await api.distribution(id, { idem_key: `dist-${id}`, expected_version: version, distributed: qty });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

async function close(p, id, version) {
  setSession(p.receiver);
  const r = await api.close(id, { idem_key: `close-${id}`, expected_version: version });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

// Full happy path: accepted on time, handed off, received in person with matching counts, closed.
async function closedLot(p, offered = 8) {
  const id = await offerAndAccept(p, offered);
  const code = await handOff(p, id, offered);
  await receive(p, id, offered, code);
  await distributeAll(p, id, offered);
  await close(p, id, 5);
  return id;
}

async function rewardsAs(who) {
  setSession(who);
  const r = await api.rewards();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

const reasonsFor = (body, lotId) => body.ledger.filter((e) => e.lot_id === lotId).map((e) => `${e.points} ${e.reason}`).sort();

describe("trust points: each rule through the mock flow", () => {
  test("a full clean lot gives the receiver +3 +5 +5 +10 and the donor +10 +5", async () => {
    const p = fresh();
    const id = await closedLot(p);

    const rec = await rewardsAs(p.receiver);
    assert.deepEqual(reasonsFor(rec, id), [
      "3 Accepted before the deadline",
      "10 Lot closed as accounted for",
      "5 Count matched the donor's",
      "5 Receipt confirmed in person",
    ].sort());
    assert.equal(rec.points, 23);
    assert.equal(rec.level, "Helper");
    assert.equal(rec.next_level, "Steward");
    assert.equal(rec.next_level_at, 60);

    const don = await rewardsAs(p.donor);
    assert.deepEqual(reasonsFor(don, id), [
      "10 Lot accounted for with matching counts",
      "5 Handoff confirmed in person",
    ].sort());
    assert.equal(don.points, 15);
    assert.equal(don.level, "Seedling");
  });

  test("an accept after the response deadline earns nothing", async () => {
    const p = fresh();
    setSession(p.donor);
    const created = await api.createLot({ receiver_sub: p.receiver.sub, offered: 4 });
    const id = created.body.lot.lot_id;
    __advanceClockForTest(100);
    try {
      setSession(p.receiver);
      const acc = await api.accept(id, { idem_key: `late-${id}`, expected_version: 1 });
      assert.equal(acc.status, 200);
    } finally {
      __advanceClockForTest(-100);
    }
    const rec = await rewardsAs(p.receiver);
    assert.equal(rec.points, 0);
    assert.deepEqual(rec.ledger, []);
  });

  test("a receipt without the pickup code earns no in-person points", async () => {
    const p = fresh();
    const id = await offerAndAccept(p, 5);
    await handOff(p, id, 5);
    await receive(p, id, 5);
    const rec = await rewardsAs(p.receiver);
    assert.deepEqual(reasonsFor(rec, id), ["3 Accepted before the deadline", "5 Count matched the donor's"].sort());
    const don = await rewardsAs(p.donor);
    assert.equal(don.points, 0);
  });

  test("mismatched counts: no matched or accounted points for either side, and the lot cannot close", async () => {
    const p = fresh();
    const id = await offerAndAccept(p, 10);
    const code = await handOff(p, id, 10);
    await receive(p, id, 8, code);

    const rec = await rewardsAs(p.receiver);
    assert.deepEqual(reasonsFor(rec, id), ["3 Accepted before the deadline", "5 Receipt confirmed in person"].sort());
    const don = await rewardsAs(p.donor);
    assert.deepEqual(reasonsFor(don, id), ["5 Handoff confirmed in person"]);

    setSession(p.receiver);
    const refused = await api.close(id, { idem_key: "early-close", expected_version: 4 });
    assert.equal(refused.status, 409);
  });

  test("a dispute settled by the coordinator still does not count as matched, but the coordinator earns +3", async () => {
    const p = fresh();
    const id = await offerAndAccept(p, 10);
    const code = await handOff(p, id, 10);
    await receive(p, id, 8, code);
    setSession(p.coordinator);
    const settled = await api.resolveDispute(id, { idem_key: `settle-${id}`, expected_version: 4, reconciled_received: 8 });
    assert.equal(settled.status, 200, JSON.stringify(settled.body));
    await distributeAll(p, id, 8, 5);
    await close(p, id, 6);

    const rec = await rewardsAs(p.receiver);
    assert.deepEqual(reasonsFor(rec, id), [
      "3 Accepted before the deadline",
      "5 Receipt confirmed in person",
      "10 Lot closed as accounted for",
    ].sort());
    assert.equal(rec.points, 18);

    const don = await rewardsAs(p.donor);
    assert.equal(don.points, 5, "donor gets only the in-person handoff, not the accounted-for bonus");

    const coord = await rewardsAs(p.coordinator);
    assert.deepEqual(coord.ledger.map((e) => [e.lot_id, e.points, e.reason]), [[id, 3, "Resolved a count dispute"]]);
    assert.equal(coord.points, 3);
  });

  test("a donor and receiver who are the same person earn nothing", async () => {
    const p = fresh();
    setSession(p.donor);
    const created = await api.createLot({ receiver_sub: p.donor.sub, offered: 3 });
    assert.equal(created.status, 201);
    const rec = await rewardsAs(p.donor);
    assert.equal(rec.points, 0);
    assert.deepEqual(rec.ledger, []);
  });

  test("a tampered chain earns nothing for that lot", async () => {
    const p = fresh();
    const id = await closedLot(p);
    assert.equal((await rewardsAs(p.receiver)).points, 23);
    assert.equal(__tamperForTest(id), true);
    const rec = await rewardsAs(p.receiver);
    assert.equal(rec.points, 0);
    assert.deepEqual(rec.ledger, []);
    assert.equal((await rewardsAs(p.donor)).points, 0);
  });
});

describe("trust points: levels, badges and community", () => {
  test("levels: Seedling below 20, Helper from 20, Steward from 60 with no next level", async () => {
    const p = fresh();
    await offerAndAccept(p, 2);
    const seedling = await rewardsAs(p.receiver);
    assert.equal(seedling.points, 3);
    assert.equal(seedling.level, "Seedling");
    assert.equal(seedling.next_level, "Helper");
    assert.equal(seedling.next_level_at, 20);

    const q = fresh();
    await closedLot(q);
    const helper = await rewardsAs(q.receiver);
    assert.equal(helper.level, "Helper");
    assert.equal(helper.next_level_at, 60);

    const s = fresh();
    await closedLot(s);
    await closedLot(s);
    await closedLot(s);
    const steward = await rewardsAs(s.receiver);
    assert.equal(steward.points, 69);
    assert.equal(steward.level, "Steward");
    assert.equal(steward.next_level, null);
    assert.equal(steward.next_level_at, null);
  });

  test("badges: earned at the goal, otherwise progress n/goal; community counts accounted lots", async () => {
    const p = fresh();
    for (let i = 0; i < 3; i++) await closedLot(p);
    const rec = await rewardsAs(p.receiver);
    const badge = (id) => rec.badges.find((b) => b.id === id);
    assert.deepEqual(Object.keys(badge("closer")).sort(), ["earned", "goal", "id", "name", "progress", "rule"]);
    assert.deepEqual(badge("closer"), {
      id: "closer", name: "Closer", rule: "Close 3 lots as accounted for", earned: true, progress: 3, goal: 3,
    });
    assert.equal(badge("quick_responder").earned, true);
    assert.equal(badge("quick_responder").progress, 3);
    // Three in-person receipts out of five: visible progress, not yet earned.
    assert.deepEqual(badge("face_to_face"), {
      id: "face_to_face", name: "Face to face", rule: "Confirm 5 handoffs in person", earned: false, progress: 3, goal: 5,
    });
    assert.equal(badge("tie_breaker").earned, false);
    assert.equal(badge("tie_breaker").progress, 0);
    assert.deepEqual(rec.badges.map((b) => b.id), [
      "first_clean_handoff", "face_to_face", "quick_responder", "closer", "tie_breaker",
    ]);

    const don = await rewardsAs(p.donor);
    assert.equal(don.badges.find((b) => b.id === "first_clean_handoff").earned, true);
    assert.equal(don.badges.find((b) => b.id === "closer").progress, 3);

    assert.ok(rec.community.lots_accounted_for >= 3);
  });

  test("response shape matches docs/api.md and every ledger entry names an event in its lot's chain", async () => {
    const p = fresh();
    const id = await closedLot(p);
    const rec = await rewardsAs(p.receiver);
    assert.deepEqual(Object.keys(rec).sort(), ["badges", "community", "ledger", "level", "next_level", "next_level_at", "points"]);
    assert.ok(rec.ledger.length > 0);
    setSession(p.donor);
    const events = (await api.getLot(id)).body.events;
    for (const e of rec.ledger) {
      assert.equal(typeof e.event_hash, "string");
      assert.ok(e.event_hash.length > 0);
      assert.equal(e.lot_id, id);
      assert.ok(events.some((ev) => ev.hash === e.event_hash), `hash ${e.event_hash} is in the chain`);
    }
  });
});

describe("trust points: isolation and sessions", () => {
  test("a stranger, or the wrong role on someone else's lot, sees nothing of it", async () => {
    const p = fresh();
    const id = await closedLot(p);
    const stranger = await rewardsAs({ role: "receiver", sub: `sub-stranger-${p.receiver.sub}` });
    assert.equal(stranger.points, 0);
    assert.deepEqual(stranger.ledger, []);
    const otherDonor = await rewardsAs({ role: "donor", sub: `sub-other-donor-${p.donor.sub}` });
    assert.equal(otherDonor.points, 0);
    assert.ok(!otherDonor.ledger.some((e) => e.lot_id === id));
  });

  test("a coordinator sees only the lots they resolved, and never a donor's or receiver's lot", async () => {
    const p = fresh();
    const id = await offerAndAccept(p, 10);
    await handOff(p, id, 10);
    setSession(p.coordinator);
    const other = fresh().coordinator;
    assert.equal((await rewardsAs(other)).points, 0);
    assert.equal((await rewardsAs(p.coordinator)).points, 0, "no resolve yet, no points");
  });

  test("no session gets 401", async () => {
    setSession(null);
    assert.equal((await api.rewards()).status, 401);
  });

  test("the demo seed leaves each demo person with some points", async () => {
    const demo = await rewardsAs({ role: "receiver", sub: "sub-receiver" });
    const donor = await rewardsAs({ role: "donor", sub: "sub-donor" });
    const coord = await rewardsAs({ role: "coordinator", sub: "sub-coordinator" });
    assert.ok(demo.points > 0 && demo.ledger.length > 0);
    assert.ok(donor.points > 0 && donor.ledger.length > 0);
    assert.ok(coord.points > 0 && coord.ledger.length > 0);
  });
});
