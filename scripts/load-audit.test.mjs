import assert from "node:assert/strict";
import test from "node:test";
import { busy, judge, LIMITS } from "./load-audit.mjs";

const sample = (cores, extra = {}) => ({ at: 0, cores, load: 1, memoryFree: 70, thermal: false, ...extra });

test("busy share per core comes from the idle time between two snapshots", () => {
  const before = [{ times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }];
  const after = [{ times: { user: 30, nice: 0, sys: 10, idle: 60, irq: 0 } }];
  assert.deepEqual(busy(before, after), [40]);
});

test("a quiet run is within limits", () => {
  const verdict = judge(Array.from({ length: 10 }, () => sample([20, 20, 10, 10])), { performance: 2 });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.averageCpu, 15);
});

test("a run that pegs the machine breaks the average and the window limits", () => {
  const verdict = judge(Array.from({ length: 10 }, () => sample([100, 100, 95, 95])), { performance: 2 });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.broken.some((line) => line.startsWith("average CPU")));
  assert.ok(verdict.broken.some((line) => line.startsWith("performance cores spent a 10 s window")));
});

test("efficiency cores busy and performance cores free is the goal; busy performance cores break their limit", () => {
  const onEfficiency = judge(Array.from({ length: 10 }, () => sample([90, 90, 5, 5])), { performance: 2 });
  assert.ok(!onEfficiency.broken.some((line) => line.startsWith("performance cores")));
  const onPerformance = judge(Array.from({ length: 10 }, () => sample([5, 5, 90, 90])), { performance: 2 });
  assert.ok(onPerformance.broken.some((line) => line.startsWith("performance cores")));
});

test("memory pressure and thermal limits break the run", () => {
  const verdict = judge([sample([1], { memoryFree: LIMITS.memoryFree - 1 }), sample([1], { thermal: true })]);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.broken.length, 2);
});
