// Payout details and the coordinator's payout list through the mock, and the volume bonus that feeds the fund.
// Paying out (POST /payouts/run) is covered in tests/pool.mock.test.mjs.
// Run: node --test tests/payouts.mock.test.mjs   (fresh subs per test, except the demo donor "sub-donor")
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { api, setSession } from "../web/js/mock.js";

const people = (t) => ({
  donor: { role: "donor", sub: `sub-donor-${t}`, name: "Dana" },
  receiver: { role: "receiver", sub: `sub-receiver-${t}`, name: "Rhys" },
  coordinator: { role: "coordinator", sub: `sub-coord-${t}`, name: "Cass" },
});
let seq = 0;
const fresh = () => people(`${process.pid}-${++seq}`);

const GOOD = { holder_name: "Dana Kaur", account_number: "123456789012", ifsc: "hdfc0001234", upi: "dana@okhdfc" };

async function offerAndAccept(p, offered = 8, extra = {}) {
  setSession(p.donor);
  const created = await api.createLot({ receiver_sub: p.receiver.sub, offered, ...extra });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.lot.lot_id;
  setSession(p.receiver);
  const acc = await api.accept(id, { idem_key: `acc-${id}`, expected_version: 1 });
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
  return id;
}

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
}

async function distributeAll(p, id, qty) {
  setSession(p.receiver);
  const r = await api.distribution(id, { idem_key: `dist-${id}`, expected_version: 4, distributed: qty });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

async function close(p, id) {
  setSession(p.receiver);
  const r = await api.close(id, { idem_key: `close-${id}`, expected_version: 5 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

// Accepted on time, handed off, received in person with matching counts, distributed, closed.
async function closedLot(p, offered = 8, extra = {}) {
  const id = await offerAndAccept(p, offered, extra);
  const code = await handOff(p, id, offered);
  await receive(p, id, offered, code);
  await distributeAll(p, id, offered);
  await close(p, id);
  return id;
}

async function rewardsAs(who) {
  setSession(who);
  const r = await api.rewards();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

describe("payout details: donor side", () => {
  test("a donor saves bank details; the response masks the account and never carries the full number", async () => {
    const p = fresh();
    setSession(p.donor);
    const saved = await api.savePayoutProfile(GOOD);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.configured, true);
    assert.equal(saved.body.holder_name, "Dana Kaur");
    assert.equal(saved.body.account, "XXXXXX9012");
    assert.equal(saved.body.ifsc, "HDFC0001234");
    assert.equal(saved.body.upi, "da***@okhdfc");
    assert.equal(typeof saved.body.updated, "number");
    assert.deepEqual(saved.body.payments, []);
    assert.ok(!JSON.stringify(saved.body).includes("123456789012"), "full account number is never returned");

    const got = await api.payoutProfile();
    assert.equal(got.status, 200);
    assert.equal(got.body.account, "XXXXXX9012");
    assert.ok(!JSON.stringify(got.body).includes("123456789012"));
  });

  test("a donor with no details yet sees configured false and an empty payments list", async () => {
    const p = fresh();
    setSession(p.donor);
    const r = await api.payoutProfile();
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { configured: false, payments: [] });
  });

  test("invalid name, account number, IFSC and UPI give 400 with the backend's messages", async () => {
    const p = fresh();
    setSession(p.donor);
    const cases = [
      [{ ...GOOD, holder_name: "D4na" }, "holder_name must be the name on the account (letters, spaces, . ' -)"],
      [{ ...GOOD, holder_name: "" }, "holder_name must be the name on the account (letters, spaces, . ' -)"],
      [{ ...GOOD, account_number: "12345678" }, "account_number must be 9 to 18 digits"],
      [{ ...GOOD, account_number: "1234567890123456789" }, "account_number must be 9 to 18 digits"],
      [{ ...GOOD, ifsc: "HDFC1001234" }, "ifsc must look like HDFC0001234"],
      [{ ...GOOD, upi: "dana" }, "upi must look like name@bank"],
    ];
    for (const [body, error] of cases) {
      const r = await api.savePayoutProfile(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.deepEqual(r.body, { error });
    }
    assert.equal((await api.payoutProfile()).body.configured, false, "nothing is stored on a refused save");
  });

  test("a valid save with no UPI is accepted and shows an empty UPI", async () => {
    const p = fresh();
    setSession(p.donor);
    const r = await api.savePayoutProfile({ ...GOOD, upi: "" });
    assert.equal(r.status, 200);
    assert.equal(r.body.upi, "");
  });

  test("a receiver cannot save or read payout details", async () => {
    const p = fresh();
    setSession(p.receiver);
    const saved = await api.savePayoutProfile(GOOD);
    assert.equal(saved.status, 403);
    assert.equal(saved.body.error, "only donors can add payout details");
    const got = await api.payoutProfile();
    assert.equal(got.status, 403);
    assert.equal(got.body.error, "only donors have payout details");
  });

  test("no session gets 401", async () => {
    setSession(null);
    assert.equal((await api.payoutProfile()).status, 401);
    assert.equal((await api.savePayoutProfile(GOOD)).status, 401);
  });
});

describe("payouts: coordinator list", () => {
  test("the coordinator lists the demo donor with masked details only, and the ledger owed", async () => {
    const demo = "sub-donor";
    setSession({ role: "donor", sub: demo, name: "Demo donor" });
    assert.equal((await api.savePayoutProfile(GOOD)).status, 200);

    setSession({ role: "coordinator", sub: "sub-coordinator", name: "Cass" });
    const list = await api.payouts();
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.equal(list.body.mode, "demo");
    assert.equal(list.body.period, "Demo month");
    assert.equal(list.body.pool_inr, 25000);
    assert.equal(list.body.payouts.length, 1, "only the real demo donor has a row");
    const row = list.body.payouts[0];
    assert.equal(row.donor_sub, demo);
    assert.equal(row.points, 45);
    assert.ok(row.estimated_inr > 0);
    assert.equal(row.direct_inr, 0);
    assert.equal(row.paid_inr, 0);
    assert.equal(row.owed_inr, row.estimated_inr);
    assert.equal(row.can_pay, true);
    assert.deepEqual(row.payments, []);
    assert.equal(row.profile.configured, true);
    assert.equal(row.profile.account, "XXXXXX9012");
    assert.equal("account_number" in row, false, "the coordinator's row carries no account number");
    assert.deepEqual(list.body.ledger, { collected_inr: 0, owed_inr: row.owed_inr, paid_inr: 0 });
    assert.ok(!JSON.stringify(list.body).includes("123456789012"), "the list never shows the full number");
    assert.equal("fee_pct" in list.body, false);
  });

  test("a donor cannot list payouts, and a receiver cannot either", async () => {
    const p = fresh();
    setSession(p.donor);
    await api.savePayoutProfile(GOOD);
    const list = await api.payouts();
    assert.equal(list.status, 403);
    assert.equal(list.body.error, "coordinator only");

    setSession(p.receiver);
    const other = await api.payouts();
    assert.equal(other.status, 403);
    assert.equal(other.body.error, "coordinator only");
  });
});

describe("volume bonus through the mock flow", () => {
  test("a verified lot of 10 packets is a ledger line worth 6 points and a volume row", async () => {
    const p = fresh();
    const id = await closedLot(p, 10);

    const don = await rewardsAs(p.donor);
    const line = don.ledger.find((e) => e.lot_id === id && e.reason === "Verified 10 packets moved");
    assert.ok(line, JSON.stringify(don.ledger));
    assert.equal(line.points, 6);
    assert.deepEqual(don.volume, [{ unit: "packets", quantity: 10, lots: 1 }]);
    assert.equal(don.verified_lots, 1);
    assert.equal(don.partners, 1);
    assert.equal(don.streak_weeks, 1);
    assert.equal(don.points, 21);

    setSession(p.donor);
    const events = (await api.getLot(id)).body.events;
    assert.ok(events.some((ev) => ev.hash === line.event_hash), "the volume line names a receipt in the chain");
  });

  test("a lot that is not accounted for earns no volume", async () => {
    const p = fresh();
    const id = await offerAndAccept(p, 10);
    const code = await handOff(p, id, 10);
    await receive(p, id, 10, code);
    const don = await rewardsAs(p.donor);
    assert.deepEqual(don.volume, []);
    assert.ok(!don.ledger.some((e) => e.lot_id === id && e.reason.startsWith("Verified")));
  });

  test("the level list reaches Champion at 150 points", async () => {
    const p = fresh();
    for (let i = 0; i < 6; i++) await closedLot(p);
    const before = await rewardsAs(p.receiver);
    assert.equal(before.points, 138);
    assert.equal(before.level, "Steward");
    assert.equal(before.next_level, "Champion");
    assert.equal(before.next_level_at, 150);

    await closedLot(p);
    const after = await rewardsAs(p.receiver);
    assert.equal(after.points, 161);
    assert.equal(after.level, "Champion");
    assert.equal(after.next_level, null);
  });
});

describe("fund: demo donor and rules", () => {
  test("the demo donor's fixed stats and the eligibility fields", async () => {
    setSession({ role: "donor", sub: "sub-donor", name: "Demo donor" });
    const r = await api.fund();
    assert.equal(r.status, 200);
    assert.equal(r.body.you.points, 45);
    assert.equal(r.body.you.eligible, true);
    assert.equal(r.body.you.verified_lots, 4);
    assert.equal(r.body.you.partners, 3);
    assert.deepEqual(r.body.you.needs, { lots: 3, partners: 2 });
    assert.deepEqual(r.body.top_donors, [{
      donor_sub: "sub-donor", points: 45, level: "Helper", volume: [{ unit: "kg", quantity: 140, lots: 4 }],
      streak_weeks: 2, verified_lots: 4, partners: 3, supporters: 0, supported_inr: 0,
    }]);
    assert.match(r.body.note, /No money moves in this demo\.$/);
    assert.equal(r.body.rules.length, 6);
  });
});
