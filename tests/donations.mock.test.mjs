// Direct donations through the mock: validation, confirm, and what each side sees. There is no platform fee.
// Run: node --test tests/donations.mock.test.mjs   (fresh subs per test, except the demo donor "sub-donor",
// whose received records are shared by every test in this file, so assertions check increases only)
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
const DEMO_DONOR = { role: "donor", sub: "sub-donor", name: "Demo donor" };

async function donateAs(who, body) {
  setSession(who);
  return api.donate(body);
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

describe("donate: validation and eligibility", () => {
  test("a receiver donates 500 to the demo donor: a demo order with no key id and no fee fields", async () => {
    const p = fresh();
    const r = await donateAs(p.receiver, { donor_sub: "sub-donor", amount_inr: 500, note: "Thank you" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.order_id, /^order_demo_[0-9a-f]{14}$/);
    assert.equal(r.body.mode, "demo");
    assert.equal(r.body.amount_inr, 500);
    assert.equal(r.body.currency, "INR");
    assert.equal(r.body.donor_sub, "sub-donor");
    assert.equal(r.body.kind, "donation");
    assert.equal("key_id" in r.body, false);
    assert.equal("fee_inr" in r.body, false);
    assert.equal("net_inr" in r.body, false);
  });

  test("invalid amounts, a missing donor and a bad note give 400", async () => {
    const p = fresh();
    const cases = [
      [{ donor_sub: "sub-donor", amount_inr: 9 }, "amount_inr must be between 10 and 50000"],
      [{ donor_sub: "sub-donor", amount_inr: 50001 }, "amount_inr must be between 10 and 50000"],
      [{ donor_sub: "sub-donor", amount_inr: "abc" }, "amount_inr must be a whole number of rupees"],
      [{ donor_sub: "sub-donor", amount_inr: 1.5e400 }, "amount_inr must be a whole number of rupees"],
      [{ donor_sub: "sub-donor" }, "amount_inr must be a whole number of rupees"],
      [{ amount_inr: 100 }, "donor_sub is required"],
      [{ donor_sub: "sub-donor", amount_inr: 100, note: "<b>hi</b>" },
        "note can be up to 80 characters: letters, numbers and basic punctuation"],
      [{ donor_sub: "sub-donor", amount_inr: 100, note: "x".repeat(81) },
        "note can be up to 80 characters: letters, numbers and basic punctuation"],
    ];
    for (const [body, error] of cases) {
      const r = await donateAs(p.receiver, body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.deepEqual(r.body, { error });
    }
  });

  test("donating to a donor who is not a top donor gives 409", async () => {
    const p = fresh();
    const r = await donateAs(p.receiver, { donor_sub: p.donor.sub, amount_inr: 100 });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, "this donor is not a top donor yet, so they cannot receive donations");
  });

  test("donating to yourself gives 409, using the demo donor's own session", async () => {
    const r = await donateAs(DEMO_DONOR, { donor_sub: "sub-donor", amount_inr: 100 });
    assert.equal(r.status, 409);
    assert.deepEqual(r.body, { error: "you cannot donate to yourself" });
  });
});

describe("confirm: simulated settlement", () => {
  test("confirm marks the gift simulated, is idempotent, and a different user gets 404", async () => {
    const p = fresh();
    const made = await donateAs(p.receiver, { donor_sub: "sub-donor", amount_inr: 200 });
    assert.equal(made.status, 200);
    const orderId = made.body.order_id;

    const other = await confirmAs(p.coordinator, orderId);
    assert.equal(other.status, 404);
    assert.deepEqual(other.body, { error: "no such donation order" });

    const first = await confirmAs(p.receiver, orderId);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body, {
      order_id: orderId, status: "simulated", amount_inr: 200, mode: "demo", kind: "donation",
    });

    const again = await confirmAs(p.receiver, orderId);
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, { order_id: orderId, status: "simulated", amount_inr: 200 });

    // Only one received record for this order, however many times it was confirmed.
    setSession(DEMO_DONOR);
    const got = await api.donations();
    const matches = got.body.received.filter((r) => r.amount_inr === 200);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].status, "simulated");
    assert.equal("fee_inr" in matches[0], false);
    assert.equal("net_inr" in matches[0], false);
  });

  test("an unknown order gives 404", async () => {
    const p = fresh();
    const r = await confirmAs(p.receiver, "order_demo_does_not_exist");
    assert.equal(r.status, 404);
  });
});

describe("donations: what each side sees", () => {
  test("the donor sees the gift in received with received_inr 0; the payer sees it in given", async () => {
    const p = fresh();
    const made = await donateAs(p.receiver, { donor_sub: "sub-donor", amount_inr: 300, note: "For the kitchen" });
    await confirmAs(p.receiver, made.body.order_id);

    setSession(p.receiver);
    const payer = await api.donations();
    assert.equal(payer.status, 200);
    assert.equal(payer.body.mode, "demo");
    assert.equal("fee_pct" in payer.body, false);
    assert.deepEqual(payer.body.received, []);
    assert.equal(payer.body.received_inr, 0);
    assert.equal(payer.body.given.length, 1);
    const given = payer.body.given[0];
    assert.deepEqual(Object.keys(given).sort(), ["amount_inr", "donor_sub", "kind", "mode", "note", "status", "ts"]);
    assert.equal(given.donor_sub, "sub-donor");
    assert.equal(given.kind, "donation");
    assert.equal(given.amount_inr, 300);
    assert.equal(given.note, "For the kitchen");
    assert.equal(given.status, "simulated");
    assert.equal(given.mode, "demo");
    assert.equal(Number.isInteger(given.ts), true);

    setSession(DEMO_DONOR);
    const donor = await api.donations();
    assert.equal(donor.status, 200);
    assert.equal(donor.body.received_inr, 0, "simulated money is never counted as received");
    const got = donor.body.received.find((r) => r.amount_inr === 300);
    assert.ok(got, "the gift is in the donor's received list");
    assert.deepEqual(Object.keys(got).sort(), ["amount_inr", "mode", "note", "status", "ts"]);
    assert.equal(got.note, "For the kitchen");
    assert.equal(got.status, "simulated");
    assert.equal(got.mode, "demo");
    assert.deepEqual(donor.body.given, [], "a donor who gave nothing has no given records");
  });

  test("the fund body carries the donations settings and the pool block, and the donor's row counts the gift", async () => {
    const before = await fundAs(DEMO_DONOR);
    assert.deepEqual(before.donations, {
      enabled: true, min_inr: 10, max_inr: 50000, mode: "demo", pool_enabled: true,
    });
    assert.deepEqual(before.pool, { mode: "demo", collected_inr: 0, contributors: 0 });
    const rowBefore = before.top_donors.find((d) => d.donor_sub === "sub-donor");
    assert.ok(rowBefore, "the demo donor is a top donor");

    const p = fresh();
    const made = await donateAs(p.receiver, { donor_sub: "sub-donor", amount_inr: 500 });
    await confirmAs(p.receiver, made.body.order_id);

    const after = await fundAs(p.receiver);
    const row = after.top_donors.find((d) => d.donor_sub === "sub-donor");
    assert.equal(row.supporters, rowBefore.supporters + 1);
    assert.equal(row.supported_inr, rowBefore.supported_inr + 500);
  });

  test("an unconfirmed order does not count towards the donor's supporters", async () => {
    const before = (await fundAs(DEMO_DONOR)).top_donors.find((d) => d.donor_sub === "sub-donor");
    const p = fresh();
    await donateAs(p.receiver, { donor_sub: "sub-donor", amount_inr: 400 });
    const after = (await fundAs(DEMO_DONOR)).top_donors.find((d) => d.donor_sub === "sub-donor");
    assert.equal(after.supporters, before.supporters);
    assert.equal(after.supported_inr, before.supported_inr);
  });
});
