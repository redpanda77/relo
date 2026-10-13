import assert from "node:assert/strict";
import test from "node:test";
import { summarizeSpans } from "./relo-latency-report.mjs";

const span = (duration, overrides = {}) => ({
  stage: "commit_to_dispatch", scenario: "warm", sourceCommit: "a".repeat(40),
  process: "worker-1", clock: "monotonic", outcome: "ok",
  startNs: "100000000000000000", endNs: String(100000000000000000n + BigInt(duration) * 1000000n),
  ...overrides,
});

test("reports nearest-rank distributions without losing nanosecond precision", () => {
  const report = summarizeSpans([1, 2, 3, 4, 100].map(n => span(n)));
  assert.deepEqual(report.groups[0].durationMs, { p50: 3, p95: 100, p99: 100, maximum: 100 });
  assert.equal(report.groups[0].successful, 5);
  assert.ok(report.missingStages.includes("tap_to_request_start"));
});

test("keeps cold/warm and distinct commits separate and reports failed samples", () => {
  const report = summarizeSpans([
    span(10), span(999, { outcome: "failed" }), span(25, { scenario: "cold" }),
    span(30, { sourceCommit: "b".repeat(40) }),
  ]);
  assert.equal(report.groups.length, 3);
  assert.equal(report.groups[0].failed, 1);
  assert.equal(report.groups[0].durationMs.p95, 10);
  assert.equal(report.total, 4);
});

test("rejects wall-clock subtraction, malformed spans, negative elapsed time and unknown fields", () => {
  for (const bad of [
    span(1, { clock: "wall" }), span(1, { endNs: "0" }),
    span(1, { startNs: "NaN" }), span(1, { stage: "unknown" }),
    span(1, { payload: "must never be persisted" }), span(1, { scenario: "" }),
  ]) assert.throws(() => summarizeSpans([bad]));
});

test("absence and failure are not successful zero latency", () => {
  assert.equal(summarizeSpans([]).missingStages.length, 6);
  const report = summarizeSpans([span(5, { outcome: "cancelled" })]);
  assert.equal(report.groups[0].durationMs, null);
  assert.equal(report.groups[0].cancelled, 1);
});
