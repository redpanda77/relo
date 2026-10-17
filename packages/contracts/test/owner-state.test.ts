import assert from "node:assert/strict";
import { existsSync,readFileSync } from "node:fs";
import test from "node:test";
import { z } from "zod";
import {
  LOCK_SCREEN_MAX_CARDS,OWNER_STATE_EVALUATION_ORDER,OWNER_STATE_QUIET_SECONDS,OWNER_STATE_SURFACES,OWNER_STATE_TIMING,
  OWNER_STATES,nowSummarySchema,ownerStateInputSchema,ownerStateResultSchema,ownerStateSurfaceSchema,
  sessionRowDerivedSchema,sessionRowInputSchema,
} from "../src/owner-state.js";

const fixtureUrl = new URL("../fixtures/owner-state-v1.json",import.meta.url);
const fixtureBytes = readFileSync(fixtureUrl,"utf8");
const fixture = z.object({
  version: z.literal(1),
  timing: z.object({ freshSeconds: z.number(),retireSeconds: z.number(),doneSeconds: z.number(),historySeconds: z.number(),yourTurnSeconds: z.number(),deliveredYourTurnSeconds: z.number() }).strict(),
  quietSeconds: z.number(),
  lockScreenMaxCards: z.number(),
  evaluationOrder: z.array(z.string()),
  surfaces: z.record(z.string(),ownerStateSurfaceSchema),
  derive: z.array(z.object({ name: z.string(),input: ownerStateInputSchema,expected: ownerStateResultSchema }).strict()).min(1),
  sessions: z.array(z.object({ name: z.string(),input: sessionRowInputSchema,expected: sessionRowDerivedSchema }).strict()).min(1),
  nowSummary: nowSummarySchema,
}).strict().parse(JSON.parse(fixtureBytes));

test("the six constants are the owner's decision (spec 10, decision 6)",() => {
  assert.deepEqual({ ...OWNER_STATE_TIMING },{ freshSeconds: 1200,retireSeconds: 3600,doneSeconds: 900,historySeconds: 28800,yourTurnSeconds: 300,deliveredYourTurnSeconds: 3600 });
  assert.equal(OWNER_STATE_QUIET_SECONDS,600);
  assert.equal(LOCK_SCREEN_MAX_CARDS,3);
});

test("the fixture carries the exact constants, order and table the contract exports",() => {
  assert.deepEqual(fixture.timing,{ ...OWNER_STATE_TIMING });
  assert.equal(fixture.quietSeconds,OWNER_STATE_QUIET_SECONDS);
  assert.equal(fixture.lockScreenMaxCards,LOCK_SCREEN_MAX_CARDS);
  assert.deepEqual(fixture.evaluationOrder,[...OWNER_STATE_EVALUATION_ORDER]);
  assert.deepEqual(fixture.surfaces,{ ...OWNER_STATE_SURFACES });
});

test("the table covers every state once and follows spec 6.2",() => {
  assert.deepEqual(Object.keys(OWNER_STATE_SURFACES).sort(),[...OWNER_STATES].sort());
  const levels = Object.fromEntries(OWNER_STATES.map((state) => [state,OWNER_STATE_SURFACES[state].interruptionLevel]));
  assert.deepEqual(levels,{ needs_you: "time-sensitive",failed: "active",done: "passive",dropped: null,left_unfinished: null,
    paused: null,waiting_on_you: null,moving: null,working_quietly: null,stopped_responding: null,no_signal: null,stale: null });
  for (const state of OWNER_STATES) {
    const surface = OWNER_STATE_SURFACES[state];
    assert.equal(surface.alertConfiguration,state === "needs_you",state);
    assert.equal(surface.apnsPriority,["needs_you","failed","done"].includes(state) ? 10 : 5,state);
    // Stale is the only quiet state still on the Lock Screen, and only dimmed; nothing quiet is "Running".
    if (surface.now === "quiet") assert.ok(["none","dimmed"].includes(surface.lockScreen),state);
  }
  assert.equal(OWNER_STATE_SURFACES.stale.now,"quiet");
});

test("every derive case's expected output agrees with the table",() => {
  for (const row of fixture.derive) {
    const surface = OWNER_STATE_SURFACES[row.expected.state];
    assert.equal(row.expected.relevance,surface.relevance,row.name);
    assert.equal(row.expected.interruptionLevel,surface.interruptionLevel,row.name);
    assert.equal(row.expected.apnsPriority,surface.apnsPriority,row.name);
    assert.ok(row.expected.lockScreen === surface.lockScreen || row.expected.lockScreen === "none",row.name);
    assert.ok(row.expected.now === surface.now || row.expected.now === null,row.name);
    assert.equal(row.expected.needsYou !== null,row.expected.state === "needs_you",row.name);
    assert.ok(Date.parse(row.expected.staleDate) >= Date.parse(row.expected.evidenceAt) + OWNER_STATE_TIMING.freshSeconds * 1000,row.name);
  }
  // Every state appears in the fixtures at least once.
  assert.deepEqual([...new Set(fixture.derive.map((row) => row.expected.state))].sort(),[...OWNER_STATES].sort());
});

test("the Now example lists at most three Lock Screen cards",() => {
  assert.ok(fixture.nowSummary.lockScreen.cards.length <= LOCK_SCREEN_MAX_CARDS);
});

// The iOS app and the Dashboard keep byte-identical copies of this fixture for their own tests.
for (const copy of [
  "../../../apps/ios/Tests/ReloCoreTests/Fixtures/owner-state-v1.json",
  "../../../apps/dashboard/src/lib/owner-state/owner-state-v1.json",
]) {
  const url = new URL(copy,import.meta.url);
  test(`client copy ${copy.split("/apps/")[1]} is byte-identical when present`,{ skip: !existsSync(url) },() => {
    assert.equal(readFileSync(url,"utf8"),fixtureBytes);
  });
}
