import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAgentLifecycle,buildCodexLifecycle,parseLifecycleStatus,terminalLifecycleInput,
} from "../src/lifecycle.mjs";

const payload = { "thread-id": "thread-123","turn-id": "turn-456" };
const sourceInstance = `codex-notify-${"a".repeat(32)}`;

test("builds a privacy-safe stable lifecycle origin from Codex task identity",() => {
  const first = buildCodexLifecycle(payload,{ sourceInstance,project: "Relo" });
  const retry = buildCodexLifecycle(payload,{ sourceInstance,project: "Relo" });
  assert.deepEqual(first,retry);
  assert.match(first.origin.thread,/^codex-task-[a-f0-9]{40}$/u);
  assert.match(first.lifecycle.runId,/^codex-run-[a-f0-9]{40}$/u);
  assert.equal(first.lifecycle.provider,"codex");
  assert.match(first.operationKeys.start,/^codex-lifecycle-start:[a-f0-9]{40}$/u);
  assert.equal(JSON.stringify(first).includes("thread-123"),false);
  assert.equal(first.origin.channel,"task-progress");
  assert.notEqual(buildCodexLifecycle({ ...payload,"turn-id": "turn-789" },{
    sourceInstance,project: "Relo",
  }).completionIdempotencyKey,first.completionIdempotencyKey);
});

test("builds provider-neutral identities without exposing provider session or run values",() => {
  const lifecycle = buildAgentLifecycle({
    provider: "claude-code",sourceInstance: "installation-safe-0123456789",
    project: "Relo",sessionId: "private-session",providerRunId: "private-run",
  });
  assert.equal(lifecycle.lifecycle.provider,"claude-code");
  assert.match(lifecycle.origin.thread,/^claude-code-task-[a-f0-9]{40}$/u);
  assert.match(lifecycle.lifecycle.runId,/^claude-code-run-[a-f0-9]{40}$/u);
  assert.match(lifecycle.operationKeys.verifying,/^claude-code-lifecycle-verifying:/u);
  assert.match(lifecycle.operationKeys.finishing,/^claude-code-lifecycle-finishing:/u);
  assert.equal(JSON.stringify(lifecycle).includes("private-session"),false);
  assert.equal(JSON.stringify(lifecycle).includes("private-run"),false);
});

test("parses only the stable CLI lifecycle status envelope",() => {
  assert.deepEqual(parseLifecycleStatus(JSON.stringify({
    ok: true,command: "activity.status",data: { found: false,activity: null },
  })),{ found: false,activity: null });
  const activity = { id: "act_123",generation: 1,sequence: 2,state: "active" };
  assert.deepEqual(parseLifecycleStatus(JSON.stringify({
    ok: true,command: "activity.status",data: { found: true,activity },
  })),{ found: true,activity });
  assert.throws(() => parseLifecycleStatus("not-json"),/invalid lifecycle status JSON/);
});

test("maps completion to a bounded terminal presentation",() => {
  const lifecycle = buildCodexLifecycle(payload,{ sourceInstance }).lifecycle;
  assert.deepEqual(terminalLifecycleInput(lifecycle,{ body: "Finished — Done." }),{
    lifecycle,status: "Complete",symbol: "success",dismissAfterSeconds: 30,
  });
  assert.equal(terminalLifecycleInput(lifecycle,{ body: "Needs attention — Choose." }).status,"Needs attention");
});
