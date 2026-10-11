// Plain-language helpers for the v2 UI.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { roleJob, trackerSteps, plainStage, whatNext, equationText, splitRecent, TRACKER } from "../web/js/logic.js";

describe("roleJob", () => {
  test("every role has a sentence and the donor is told they cannot report distribution", () => {
    for (const r of ["donor", "receiver", "coordinator"]) assert.ok(roleJob(r).startsWith("Your job:"));
    assert.match(roleJob("donor"), /Only the receiver can/);
    assert.equal(roleJob("nobody"), "");
  });
});

describe("trackerSteps", () => {
  const states = (lot) => trackerSteps(lot).map((s) => s.state).join(",");
  test("marks done, current and todo", () => {
    assert.equal(states({ stage: "OFFERED" }), "current,todo,todo,todo,todo,todo");
    assert.equal(states({ stage: "HANDOFF_DECLARED" }), "done,done,current,todo,todo,todo");
    assert.equal(states({ stage: "DISTRIBUTING" }), "done,done,done,done,current,todo");
  });
  test("accounted for is all done; exception halts at the offer", () => {
    assert.equal(states({ stage: "ACCOUNTED_FOR" }), "done,done,done,done,done,done");
    assert.equal(states({ stage: "EXCEPTION" }), "current,todo,todo,todo,todo,todo");
  });
  test("six steps", () => assert.equal(TRACKER.length, 6));
});

describe("plainStage and whatNext", () => {
  test("no jargon for disputes and exceptions", () => {
    assert.equal(plainStage({ stage: "RECEIVED", count_dispute: true }), "Counts don't match");
    assert.equal(plainStage({ stage: "EXCEPTION" }), "Nobody answered");
    assert.equal(plainStage({ stage: "ACCOUNTED_FOR", count_dispute: false }), "Accounted for");
  });
  test("sentences are role specific", () => {
    assert.match(whatNext({ stage: "OFFERED" }, "receiver"), /Accept it/);
    assert.match(whatNext({ stage: "ACCEPTED" }, "donor"), /pickup code/);
    assert.match(whatNext({ stage: "RECEIVED", count_dispute: true }, "coordinator"), /Confirm the real number/);
    assert.match(whatNext({ stage: "RECEIVED", count_dispute: true }, "receiver"), /coordinator resolves/);
    assert.match(whatNext({ stage: "EXCEPTION" }, "coordinator"), /Follow up/);
    assert.equal(whatNext({ stage: "OFFERED" }, "stranger"), "");
  });
});

describe("equationText and splitRecent", () => {
  test("equation only after receipt", () => {
    assert.equal(equationText({ offered: 10 }), "");
    assert.equal(equationText({ received: 8, distributed: 8, returned: 0, disposed: 0, remaining: 0 }),
      "8 received = 8 given out + 0 returned + 0 thrown away + 0 still with the receiver");
  });
  test("splitRecent keeps the newest and collapses the rest", () => {
    const lots = Array.from({ length: 8 }, (_, i) => ({ lot_id: "l" + i, created_epoch: i }));
    const { recent, older } = splitRecent(lots, 3);
    assert.deepEqual(recent.map((l) => l.lot_id), ["l7", "l6", "l5"]);
    assert.equal(older.length, 5);
  });
});
