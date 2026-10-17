import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import claudeCode from "../src/harness/adapters/claude-code/index.mjs";
import { wantedEntries } from "../src/harness/adapters/claude-code/levels.mjs";
import { describeRequest, runPermission } from "../src/harness/core/approve.mjs";

const SESSION = "9f2c1c34-5c0e-4d63-8a3a-7f1d3bd2c001";
const INPUT = { session_id: SESSION, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "npm run deploy -- --prod" }, cwd: "/work/relo" };

function box({ answers = [], askCode = 0, askOut = '{"ok":true,"interaction":{"id":"int_1"}}', phases = [] } = {}) {
  const calls = [];
  const printed = [];
  const out = { calls, printed, terminated: undefined, exited: undefined };
  let clock = 1_000_000;
  const queue = [...answers];
  const phaseQueue = [...phases];
  out.dependencies = {
    env: {}, now: () => clock, observedStateDirectory: "/none", emit: (line) => printed.push(line),
    onTerminate: (handler) => { out.terminated = handler; return () => {}; }, exit: (code) => { out.exited = code; },
    runRelo: async (args, options) => {
      calls.push({ args, env: options.env, cwd: options.cwd });
      if (args[0] === "ask") return { code: askCode, stdout: askOut };
      if (args[1] === "wait") { clock += 20_000; return { code: queue.shift() ?? 4, stdout: "" }; }
      return { code: 0, stdout: "" };
    },
    approvalWaitSeconds: 60,
  };
  out.phases = phaseQueue;
  return out;
}

test("the question says what will run, in one line, with the full request as detail", () => {
  const { prompt, detail } = describeRequest({ tool: "Bash", input: { command: "npm run deploy\n  -- --prod" } });
  assert.equal(prompt, "Allow: Run npm run deploy -- --prod?");
  assert.ok(detail.startsWith("Bash\nnpm run deploy"));
  assert.equal(describeRequest({ tool: "Edit", input: { file_path: "/a/b/now.css" } }).prompt, "Allow: Edit now.css?");
  assert.equal(describeRequest({ tool: "mcp__relo__relo_ask", input: {} }).prompt, "Allow: Use relo relo_ask?");
  assert.ok(describeRequest({ tool: "Bash", input: { command: "x".repeat(500) } }).prompt.length <= 120);
});

test("approved on the phone allows; the question runs as the session and is not withdrawn", async () => {
  const b = box({ answers: [4, 0] });
  const result = await runPermission({ adapter: claudeCode, input: INPUT, dependencies: b.dependencies });
  assert.equal(result.decision, "allow");
  assert.deepEqual(b.printed, [{ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } }]);
  assert.equal(b.calls[0].args[0], "ask");
  assert.ok(b.calls[0].args.includes("--approval") && b.calls[0].args.includes("--no-wait"));
  assert.equal(b.calls[0].env.CLAUDE_CODE_SESSION_ID, SESSION);
  assert.equal(b.calls[0].env.CLAUDECODE, "1");
  assert.equal(b.calls.some((c) => c.args[1] === "cancel"), false);
});

test("denied on the phone denies and says so", async () => {
  const b = box({ answers: [5] });
  const result = await runPermission({ adapter: claudeCode, input: INPUT, dependencies: b.dependencies });
  assert.equal(result.decision, "deny");
  assert.equal(b.printed[0].hookSpecificOutput.decision.behavior, "deny");
  assert.equal(b.printed[0].hookSpecificOutput.decision.interrupt, false);
});

test("no answer leaves the terminal prompt alone and withdraws the question", async () => {
  const b = box({ answers: [4, 4, 4, 4] });
  const result = await runPermission({ adapter: claudeCode, input: INPUT, dependencies: b.dependencies });
  assert.equal(result.decision, "none");
  assert.deepEqual(b.printed, []);
  assert.deepEqual(b.calls.at(-1).args, ["interaction", "cancel", "int_1"]);
});

test("a question that could not be asked (a filter, no server) decides nothing and asks nothing more", async () => {
  const b = box({ askCode: 2, askOut: "" });
  const result = await runPermission({ adapter: claudeCode, input: INPUT, dependencies: b.dependencies });
  assert.deepEqual([result.decision, result.reason], ["none", "not_asked"]);
  assert.deepEqual(b.printed, []);
  assert.equal(b.calls.length, 1);
});

test("a closed question (expired or canceled) decides nothing", async () => {
  const b = box({ answers: [8] });
  assert.equal((await runPermission({ adapter: claudeCode, input: INPUT, dependencies: b.dependencies })).decision, "none");
  assert.deepEqual(b.printed, []);
});

test("when Claude Code ends the hook (the owner answered its dialog) the question is withdrawn", async () => {
  const b = box({ answers: [4] });
  const running = runPermission({ adapter: claudeCode, input: INPUT, dependencies: b.dependencies });
  await new Promise((resolve) => setImmediate(resolve));
  await b.terminated();
  await running;
  assert.equal(b.exited, 0);
  assert.equal(b.calls.filter((c) => c.args[1] === "cancel").length, 1);
});

test("only the approvals level installs the permission hook", () => {
  assert.equal(wantedEntries("presence").PermissionRequest, undefined, "presence");
  const entry = wantedEntries("approvals").PermissionRequest;
  assert.deepEqual(entry[0].hooks.map((hook) => hook.command), ["relo hook permission"]);
  assert.equal(entry[0].hooks[0].async, undefined);
  assert.ok(wantedEntries("approvals").Notification, "approvals keeps presence");
});
