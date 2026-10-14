import assert from "node:assert/strict";
import test from "node:test";
import * as contracts from "../src/index.js";
import { agentSessionListQuerySchema,harnessCredentialCreateRequestSchema } from "../src/agent-sessions.js";

test("the list query takes a comma list of known phases", () => {
  assert.deepEqual(agentSessionListQuerySchema.parse({ phase: "working, waiting,working" }).phase, ["working", "waiting"]);
  assert.equal(agentSessionListQuerySchema.parse({}).phase, undefined);
  assert.equal(agentSessionListQuerySchema.parse({ phase: "" }).phase, undefined);
  assert.equal(agentSessionListQuerySchema.safeParse({ phase: "sleeping" }).success, false);
  assert.equal(agentSessionListQuerySchema.safeParse({ phase: "lost" }).success, false, "lost is not a phase");
  assert.equal(agentSessionListQuerySchema.safeParse({ limit: "3" }).success, false);
});

test("one derivation: the contracts carry no session phase rule or raw event list", () => {
  for (const name of ["agentSessionPhase", "AGENT_SESSION_EVENTS", "OBSERVED_SESSION_EVENTS", "agentSessionEventRequestSchema",
    "AGENT_SESSION_WAITING_AFTER_STOP_SECONDS", "AGENT_SESSION_WAITING_ON_PROMPT_SECONDS"]) {
    assert.equal(name in contracts, false, name);
  }
});

test("a harness credential is named with a bounded label", () => {
  assert.equal(harnessCredentialCreateRequestSchema.safeParse({ name: "Studio Mac hooks" }).success, true);
  assert.equal(harnessCredentialCreateRequestSchema.safeParse({ name: "" }).success, false);
  assert.equal(harnessCredentialCreateRequestSchema.safeParse({ name: "x".repeat(121) }).success, false);
  assert.equal(harnessCredentialCreateRequestSchema.safeParse({ name: "a", scopes: ["activities:write"] }).success, false);
});
