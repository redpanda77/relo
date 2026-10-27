// Antigravity's hooks.json keys hooks by name: Relo's entries are the one hook "relo", written in Antigravity's own
// shape (plain handler lists for its non-tool events), and every other hook stays as it was.
import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { ADAPTERS } from "../src/harness/adapters/index.mjs";
import { inferLevel, planLevel } from "../src/harness/core/install.mjs";
import { normalize } from "../src/harness/core/events.mjs";

const adapter = ADAPTERS.antigravity;
const OTHER = { "my-linter-hook": { PostToolUse: [{ matcher: "run_command", hooks: [{ type: "command", command: "./lint.sh", timeout: 10 }] }] } };

test("presence writes one relo hook in Antigravity's shape and keeps the owner's hooks", () => {
  const plan = planLevel("hooks.json", JSON.stringify(OTHER, null, 2), "presence", adapter, {});
  const written = JSON.parse(plan.content);
  assert.deepEqual(written["my-linter-hook"], OTHER["my-linter-hook"]);
  const hook = (role) => ({ type: "command", command: `relo hook ${role} --agent antigravity`, timeout: 5 });
  assert.deepEqual(written.relo, {
    SessionStart: [hook("start")],
    PreInvocation: [hook("prompt")],
    Stop: [hook("stop")],
  });
  assert.equal(inferLevel(written, adapter).level, "presence");
  assert.equal(planLevel("hooks.json", plan.content, "presence", adapter, {}).action, "unchanged");
});

test("off removes only the relo hook, keeping the owner's enabled switch while it exists", () => {
  const installed = planLevel("hooks.json", JSON.stringify(OTHER), "presence", adapter, {}).content;
  const disabled = JSON.parse(installed);
  disabled.relo.enabled = false;
  const refreshed = planLevel("hooks.json", JSON.stringify(disabled), "presence", adapter, {});
  const kept = refreshed.content ?? JSON.stringify(disabled);
  assert.equal(JSON.parse(kept).relo.enabled, false);
  assert.equal(planLevel("hooks.json", kept, "presence", adapter, {}).action, "unchanged");
  const removed = planLevel("hooks.json", installed, "off", adapter, {});
  assert.equal(removed.action, "removed");
  assert.deepEqual(JSON.parse(removed.content), OTHER);
});

test("a request is the first model call of a run, and a run with background work still going has not stopped", () => {
  const base = { conversationId: "ec33ebf9-0cba-4100-8142-c61503f6c587", workspacePaths: ["/workspace/project"] };
  assert.equal(normalize({ adapter, input: { ...base, invocationNum: 0 }, named: "prompt" }).event, "prompt");
  assert.equal(normalize({ adapter, input: { ...base, invocationNum: 3 }, named: "prompt" }).drop, "not_accepted");
  assert.equal(normalize({ adapter, input: { ...base, fullyIdle: true }, named: "stop" }).event, "stop");
  assert.equal(normalize({ adapter, input: { ...base, fullyIdle: false }, named: "stop" }).drop, "not_accepted");
  assert.equal(normalize({ adapter, input: { workspacePaths: ["/w"] }, named: "start" }).drop, "no_session");
  assert.equal(normalize({ adapter, input: base, named: "start" }).cwd, "/workspace/project");
});

test("no role renders at presence", () => {
  assert.equal(adapter.render({ role: "turn", context: "Relo: open work" }), undefined);
});
