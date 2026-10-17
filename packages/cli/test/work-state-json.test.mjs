// `relo state --json` carries the plan: goal, status, current step, rounds and the open round's tree (workView).
import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { workView } from "../src/agent/work.mjs";

test("workView shows goal, status, current step, rounds and the open round's plan as a tree", () => {
  const work = {
    id: "wrk_1", lifecycle: "open", version: 4, goal: "Ship it", status: "Building",
    plan: {
      v: 1, next: 7,
      rounds: [{ n: 1, state: "closed", title: "First", outcome: "Done once" }, { n: 2, state: "open", title: "More" }],
      steps: [
        { id: "s1", label: "Old", state: "done", round: 1 },
        { id: "s2", label: "Build", state: "open", round: 2, detail: "all of it" },
        { id: "s3", label: "Parse", state: "done", parent: "s2", round: 2 },
        { id: "s4", label: "Write", state: "current", parent: "s2", round: 2 },
        { id: "s5", label: "Verify", state: "open", round: 2 },
      ],
    },
  };
  const view = workView(work);
  assert.equal(view.goal, "Ship it");
  assert.equal(view.status, "Building");
  assert.equal(view.current, "s4");
  assert.deepEqual(view.rounds, [{ n: 1, state: "closed", title: "First", outcome: "Done once" }, { n: 2, state: "open", title: "More" }]);
  assert.deepEqual(view.plan, [
    { id: "s2", label: "Build", state: "open", detail: "all of it", children: [{ id: "s3", label: "Parse", state: "done" }, { id: "s4", label: "Write", state: "current" }] },
    { id: "s5", label: "Verify", state: "open" },
  ]);
});

test("workView of a plan without rounds, or a delivered one", () => {
  const flat = workView({ id: "w", lifecycle: "open", goal: "G", plan: { v: 1, next: 3, steps: [{ id: "s1", label: "A", state: "current" }, { id: "s2", label: "B", state: "open" }] } });
  assert.equal(flat.current, "s1");
  assert.deepEqual(flat.rounds, []);
  assert.equal(flat.plan.length, 2);
  assert.equal("status" in flat, false);
  const delivered = workView({ id: "w", lifecycle: "open", goal: "G", plan: { v: 1, next: 2, rounds: [{ n: 1, state: "closed", outcome: "ok" }], steps: [{ id: "s1", label: "A", state: "done", round: 1 }] } });
  assert.deepEqual(delivered.plan, []);
  assert.equal(delivered.current, null);
});
