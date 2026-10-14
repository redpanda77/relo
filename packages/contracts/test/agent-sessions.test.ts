import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_SESSION_WAITING_AFTER_STOP_SECONDS,
  AGENT_SESSION_WAITING_ON_PROMPT_SECONDS,
  agentSessionListQuerySchema,
  agentSessionPhase,
} from "../src/agent-sessions.js";

const now = Date.parse("2026-10-14T05:00:00Z");
const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000).toISOString();

test("agentSessionPhase: working, waiting, idle, ended, lost", () => {
  assert.equal(agentSessionPhase({ state: "active", lastEvent: "tool", lastEventAt: at(5) }, now), "working");
  assert.equal(agentSessionPhase({ state: "active", lastEvent: "prompt", lastEventAt: at(5) }, now), "working");
  assert.equal(agentSessionPhase({ state: "active", lastEvent: "start", lastEventAt: at(5) }, now), "idle", "opened, not prompted");
  assert.equal(agentSessionPhase({ state: "idle", lastEvent: "stop", lastEventAt: at(60) }, now), "waiting");
  assert.equal(agentSessionPhase({ state: "idle", lastEvent: "stop", lastEventAt: at(AGENT_SESSION_WAITING_AFTER_STOP_SECONDS + 1) }, now), "idle");
  assert.equal(agentSessionPhase({ state: "idle", lastEvent: "wait", lastEventAt: at(AGENT_SESSION_WAITING_ON_PROMPT_SECONDS - 1) }, now), "waiting");
  assert.equal(agentSessionPhase({ state: "idle", lastEvent: "wait", lastEventAt: at(AGENT_SESSION_WAITING_ON_PROMPT_SECONDS + 1) }, now), "idle");
  assert.equal(agentSessionPhase({ state: "idle", lastEventAt: at(1) }, now), "idle", "no last event: idle");
  assert.equal(agentSessionPhase({ state: "ended", lastEvent: "end", lastEventAt: at(1) }, now), "ended");
  assert.equal(agentSessionPhase({ state: "lost", lastEvent: "tool", lastEventAt: at(1) }, now), "lost");
});

test("the list query takes a comma list of known phases", () => {
  assert.deepEqual(agentSessionListQuerySchema.parse({ phase: "working, waiting,working" }).phase, ["working", "waiting"]);
  assert.equal(agentSessionListQuerySchema.parse({}).phase, undefined);
  assert.equal(agentSessionListQuerySchema.parse({ phase: "" }).phase, undefined);
  assert.equal(agentSessionListQuerySchema.safeParse({ phase: "sleeping" }).success, false);
  assert.equal(agentSessionListQuerySchema.safeParse({ limit: "3" }).success, false);
});
