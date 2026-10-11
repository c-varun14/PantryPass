// Pool contributions (POST /pool) and the coordinator's one-click payout run, through the mock.
// Run: node --test tests/pool.mock.test.mjs
// Order matters inside the payouts describe: the demo donor ("sub-donor") has no bank details until the test
// that saves them, and a saved profile cannot be removed, so the no-details test is written first.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { api, setSession } from "../web/js/mock.js";

const DEMO = "sub-donor";
const DEMO_DONOR = { role: "donor", sub: DEMO, name: "Demo donor" };
const COORD = { role: "coordinator", sub: "sub-coordinator", name: "Cass" };
const GOOD = { holder_name: "Dana Kaur", account_number: "123456789012", ifsc: "HDFC0001234", upi: "dana@okhdfc" };
const NOTE_ERROR = "note can be up to 80 characters: letters, numbers and basic punctuation";

let seq = 0;
const fresh = () => {
  const t = `${process.pid}-${++seq}`;
  return {
    donor: { role: "donor", sub: `sub-donor-${t}`, name: "Dana" },
    receiver: { role: "receiver", sub: `sub-receiver-${t}`, name: "Rhys" },
    coordinator: { role: "coordinator", sub: `sub-coord-${t}`, name: "Cass" },
  };
};

async function contributeAs(who, body) {
  setSession(who);
  return api.contribute(body);
}

async function confirmAs(who, orderId) {
  setSession(who);
  return api.confirmDonation({ order_id: orderId, razorpay_payment_id: "pay_demo" });
}

async function fundAs(who) {
  setSession(who);
  const r = await api.fund();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

describe("payouts run: coordinator only", () => {
  test("donors and receivers get 403, and no session gets 401", async () => {
    const p = fresh();
    for (const who of [p.donor, p.receiver]) {
      setSession(who);
      const r = await api.runPayouts();
      assert.equal(r.status, 403, who.role);
      assert.equal(r.body.error, "coordinator only");
    }
    setSession(null);
    assert.equal((await api.runPayouts()).status, 401);
  });
});

describe("payouts run: one click", () => {
  test("the demo donor with no bank details is skipped with 'no bank details'", async () => {
    setSession(COORD);
    const r = await api.runPayouts();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, {
      mode: "demo", paid: [], skipped: [{ donor_sub: DEMO, reason: "no bank details" }], more: false,
    });
    const list = await api.payouts();
    assert.equal(list.body.payouts[0].can_pay, false);
    assert.equal(list.body.payouts[0].profile.configured, false);
  });

  test("with bank details the run pays the demo donor once; the donor sees it; a second run skips", async () => {
    setSession(DEMO_DONOR);
    assert.equal((await api.savePayoutProfile(GOOD)).status, 200);

    setSession(COORD);
    const before = await api.payouts();
    const row = before.body.payouts[0];
    assert.equal(row.can_pay, true);
    assert.ok(row.owed_inr >= 100, JSON.stringify(row));
    const owed = row.owed_inr;

    const run = await api.runPayouts();
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.deepEqual(run.body, {
      mode: "demo",
      paid: [{ donor_sub: DEMO, amount_inr: owed, status: "simulated" }],
      skipped: [],
      more: false,
    });

    const after = (await api.payouts()).body;
    const paidRow = after.payouts[0];
    assert.equal(paidRow.owed_inr, 0);
    assert.equal(paidRow.paid_inr, owed);
    assert.equal(paidRow.can_pay, false);
    assert.deepEqual(after.ledger, { collected_inr: 0, owed_inr: 0, paid_inr: owed });

    const again = await api.runPayouts();
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, {
      mode: "demo", paid: [], skipped: [{ donor_sub: DEMO, reason: "nothing owed" }], more: false,
    });

    setSession(DEMO_DONOR);
    const mine = await api.payoutProfile();
    assert.equal(mine.status, 200);
    const payment = mine.body.payments[0];
    assert.deepEqual(Object.keys(payment).sort(), ["amount_inr", "mode", "status", "ts", "utr"]);
    assert.equal(payment.amount_inr, owed);
    assert.equal(payment.status, "simulated");
    assert.equal(payment.mode, "simulated");
    assert.equal(payment.utr, null);
    assert.equal(typeof payment.ts, "number");
    assert.equal(mine.body.payments.length, 1, "the second run added nothing");
  });
});

describe("POST /pool: contributions", () => {
  test("invalid amounts and notes give 400 with the same messages as a donation", async () => {
    const p = fresh();
    const cases = [
      [{ amount_inr: 9 }, "amount_inr must be between 10 and 50000"],
      [{ amount_inr: 50001 }, "amount_inr must be between 10 and 50000"],
      [{ amount_inr: "abc" }, "amount_inr must be a whole number of rupees"],
      [{}, "amount_inr must be a whole number of rupees"],
      [{ amount_inr: 100, note: "<b>hi</b>" }, NOTE_ERROR],
      [{ amount_inr: 100, note: "x".repeat(81) }, NOTE_ERROR],
    ];
    for (const [body, error] of cases) {
      const r = await contributeAs(p.receiver, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.deepEqual(r.body, { error });
    }
  });

  test("no session gets 401", async () => {
    setSession(null);
    assert.equal((await api.contribute({ amount_inr: 100 })).status, 401);
  });

  test("any signed-in role may contribute; the reply is a demo pool order with no donor", async () => {
    const p = fresh();
    for (const who of [p.donor, p.receiver, p.coordinator]) {
      const r = await contributeAs(who, { amount_inr: 150, note: "For the fund" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.match(r.body.order_id, /^order_demo_[0-9a-f]{14}$/);
      assert.deepEqual(Object.keys(r.body).sort(), ["amount_inr", "currency", "kind", "mode", "order_id"]);
      assert.equal(r.body.mode, "demo");
      assert.equal(r.body.amount_inr, 150);
      assert.equal(r.body.currency, "INR");
      assert.equal(r.body.kind, "pool");
    }
  });

  test("confirm marks the contribution simulated, is idempotent, and another user gets 404", async () => {
    const p = fresh();
    const made = await contributeAs(p.receiver, { amount_inr: 333 });
    const orderId = made.body.order_id;

    const other = await confirmAs(p.coordinator, orderId);
    assert.equal(other.status, 404);
    assert.deepEqual(other.body, { error: "no such donation order" });

    const first = await confirmAs(p.receiver, orderId);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body, {
      order_id: orderId, status: "simulated", amount_inr: 333, mode: "demo", kind: "pool",
    });

    const again = await confirmAs(p.receiver, orderId);
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, { order_id: orderId, status: "simulated", amount_inr: 333 });

    const given = (await api.donations()).body.given.filter((g) => g.amount_inr === 333);
    assert.equal(given.length, 1, "only the first confirm writes a record");
    assert.equal(given[0].donor_sub, null);
    assert.equal(given[0].kind, "pool");
    assert.equal(given[0].status, "simulated");
  });

  test("a confirmed contribution leaves the demo pool and every donor's totals unchanged", async () => {
    const p = fresh();
    const pool = (await fundAs(DEMO_DONOR));
    const rowBefore = pool.top_donors.find((d) => d.donor_sub === DEMO);

    const made = await contributeAs(p.receiver, { amount_inr: 4321 });
    await confirmAs(p.receiver, made.body.order_id);

    const after = await fundAs(p.receiver);
    assert.equal(after.pool_inr, 25000, "the configured demo pool stays put");
    assert.deepEqual(after.pool, { mode: "demo", collected_inr: 0, contributors: 0 });
    const rowAfter = after.top_donors.find((d) => d.donor_sub === DEMO);
    assert.equal(rowAfter.supporters, rowBefore.supporters);
    assert.equal(rowAfter.supported_inr, rowBefore.supported_inr);

    setSession(DEMO_DONOR);
    const donor = await api.donations();
    assert.equal(donor.body.received.some((r) => r.amount_inr === 4321), false, "a pool gift is not a donation to a donor");
  });
});
