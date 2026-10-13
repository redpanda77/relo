import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  classifySubjectMutation, evaluateRelevance, normalizeRelevancePolicy,
  relevanceItemSchema, relevancePolicySchema, terminalCleanupDeadline,
} from "../src/relevance.js";
import { relevanceFixtureSchema } from "./relevance-fixture.js";

const fixtureBytes = readFileSync(new URL("../fixtures/relevance.json", import.meta.url), "utf8");
const fixture = relevanceFixtureSchema.parse(JSON.parse(fixtureBytes));

test("Swift consumes the exact same relevance fixtures", () => {
  assert.equal(readFileSync(new URL("../../../apps/ios/Tests/ReloCoreTests/Fixtures/relevance.json", import.meta.url), "utf8"), fixtureBytes);
});

for (const row of fixture.policies) {
  test(`policy: ${row.name}`, () => {
    assert.deepEqual(normalizeRelevancePolicy(row.policy, row.occurredAt, row.acceptedAt), row.expected);
  });
}
for (const row of fixture.evaluations) {
  test(`relevance: ${row.name}`, () => {
    assert.deepEqual(evaluateRelevance(row.item, row.now, row.clockTrusted, row.current), row.expected);
  });
}
for (const row of fixture.transitions) {
  test(`ordering: ${row.name}`, () => {
    assert.equal(classifySubjectMutation(row.actor, row.candidate, row.current, row.operation), row.expected);
  });
}
test("terminal cleanup has an independent one-hour deadline", () => {
  assert.equal(terminalCleanupDeadline("2026-09-30T12:16:00.000Z"), "2026-09-30T13:16:00.000Z");
});
test("reject contradictory, malformed, and future-clock policy input", () => {
  for (const value of [
    { kind: "notice", relevanceSeconds: 30, deliverySeconds: 60 },
    { kind: "decision", actionSeconds: 30, deliverySeconds: 60 },
    { kind: "progress", actionSeconds: 900 },
    { kind: "notice", relevanceSeconds: 0 },
    { kind: "notice", relevanceSeconds: 1.5 },
    { kind: "progress", heartbeat: { intervalSeconds: 0, lastHeartbeatAt: "2026-09-30T12:00:00.000Z" } },
    { kind: "incident", mode: "lease" },
    { kind: "incident", mode: "until_resolved", leaseUntil: "2026-09-30T12:10:00.000Z" },
    { kind: "terminal_cleanup" },
  ]) assert.equal(relevancePolicySchema.safeParse(value).success, false, JSON.stringify(value));
  assert.throws(() => normalizeRelevancePolicy({ kind: "notice" }, "2026-09-30T12:00:01.001Z", "2026-09-30T12:00:00.000Z"), /future/);
  assert.throws(() => normalizeRelevancePolicy({ kind: "progress", heartbeat: { intervalSeconds: 10, lastHeartbeatAt: "2026-09-30T12:00:01.001Z" } }, "2026-09-30T12:00:00.000Z", "2026-09-30T12:00:00.000Z"), /future/);
});

test("corrupt persistence cannot authorize a permanent or foreign decision", () => {
  const original = fixture.evaluations.find(row => row.item.deadlines.kind === "decision")!.item;
  const variants = [
    { ...original, deadlines: { ...original.deadlines, actionExpiresAt: null } },
    { ...original, identity: { ...original.identity, generation: 0 } },
    { ...original, identity: { ...original.identity, revision: Number.MAX_SAFE_INTEGER + 1 } },
    { ...original, supersededAt: original.deadlines.occurredAt },
    { ...original, supersededAt: original.deadlines.occurredAt, supersededBy: { ...original.identity, sourceId: "foreign_source", revision: 2 } },
  ];
  for (const item of variants) assert.equal(relevanceItemSchema.safeParse(item).success, false);
});
