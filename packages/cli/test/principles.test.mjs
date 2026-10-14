import "./hermetic-env.mjs";
// Principle tests (ADR 0008, STATE-SPEC 4.1/11.1, DOGFOOD #11 #15 #16): one producer type never uses another's
// surface, owner-only commands stay out of sessions, plans extend without restarts, the filter has no false positives.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { run } from "../src/cli.mjs";
import { detectCaller, surfaceFor } from "../src/caller.mjs";
import { checkText } from "../src/work/content-filter.mjs";
import { renderEcho } from "../src/work/echo.mjs";
import { applyChange, splitLabels, startPlan } from "../src/work/plan.mjs";

function shell(env) {
  const state = mkdtempSync(join(tmpdir(), "relo-principles-"));
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ method: init.method, path: new URL(url).pathname });
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({ open: null, parked: [] }) };
  };
  const overrides = {
    env: { XDG_STATE_HOME: state, HOME: state, ...env },
    loadConfig: async () => ({ apiUrl: "http://relo.test", token: "t".repeat(44) }),
    configPath: () => join(state, "config.json"),
    fetchImpl,
    stdinIsTTY: true,
  };
  const relo = async (...argv) => {
    const out = [];
    const code = await run([...argv, "--json"], { stdout: (l) => out.push(l), stderr: (l) => out.push(l), stdoutIsTTY: false }, overrides);
    let json;
    try { json = JSON.parse(out[0]); } catch { json = undefined; }
    return { code, json, text: out.join("\n") };
  };
  return { relo, calls, done: () => rmSync(state, { recursive: true, force: true }) };
}

const CALLERS = {
  agent_session: { CLAUDE_CODE_SESSION_ID: "principles-session" },
  mcp: { RELO_MCP_SESSION: "principles-mcp" },
  nested: { CLAUDE_CODE_SESSION_ID: "outer", CODEX_THREAD_ID: "inner" },
  unidentified: { GEMINI_CLI: "1" },
  script: {},
};

test("caller types: each environment resolves to exactly one producer type and surface", () => {
  assert.deepEqual([detectCaller(CALLERS.agent_session).type, detectCaller(CALLERS.mcp).type], ["agent_session", "agent_session"]);
  assert.equal(detectCaller(CALLERS.mcp).harness, "mcp");
  assert.equal(detectCaller(CALLERS.nested).reason, "nested_harnesses");
  assert.equal(detectCaller(CALLERS.unidentified).type, "unidentified");
  assert.equal(detectCaller(CALLERS.script).type, "script");
  // RELO_SESSION is honoured only without a harness: it can never name another agent session.
  assert.equal(detectCaller({ ...CALLERS.unidentified, RELO_SESSION: "someone-else" }).type, "unidentified");
  assert.equal(detectCaller({ RELO_SESSION: "deploy" }).session, "deploy");
  // A different session id is a different key.
  assert.notEqual(detectCaller({ CLAUDE_CODE_SESSION_ID: "a" }).sessionKey, detectCaller({ CLAUDE_CODE_SESSION_ID: "b" }).sessionKey);
  assert.deepEqual(Object.values(CALLERS).map((env) => surfaceFor(detectCaller(env))), ["agent", "agent", "agent", "agent", "script"]);
});

for (const [type, env] of Object.entries(CALLERS).filter(([type]) => type !== "script")) {
  test(`owner-only commands are refused for ${type} callers, before any request`, async (t) => {
    const s = shell(env);
    t.after(s.done);
    for (const argv of [["sessions"], ["listen"], ["activity", "list"], ["activity", "diagnose", "act_1"]]) {
      const r = await s.relo(...argv);
      assert.equal(r.json?.error?.code, "OWNER_ONLY", `${argv.join(" ")}: ${r.text}`);
      assert.equal(r.code, 2);
    }
    assert.equal(s.calls.length, 0);
  });
}

test("owner-only commands are not refused for the owner's shell (script)", async (t) => {
  const s = shell(CALLERS.script);
  t.after(s.done);
  const r = await s.relo("sessions");
  assert.notEqual(r.json?.error?.code, "OWNER_ONLY", r.text);
});

test("scripts cannot use the agent surface; agents cannot use relo activity", async (t) => {
  const script = shell(CALLERS.script);
  t.after(script.done);
  // A script never reaches the agent module: without its own --producer key it is refused before any request.
  const refused = await script.relo("work", "start", "--goal", "Nightly backup");
  assert.notEqual(refused.code, 0, refused.text);
  assert.ok(["NOT_AVAILABLE", "PRODUCER_REQUIRED"].includes(refused.json.error.code), refused.text);
  const agent = shell(CALLERS.agent_session);
  t.after(agent.done);
  const gone = await agent.relo("activity", "start", "--title", "Nightly backup", "--status", "Copying files");
  assert.equal(gone.json.error.code, "UNKNOWN_COMMAND");
  assert.equal(agent.calls.length + script.calls.length, 0);
});

test("unidentified callers need their handle for every later command", async (t) => {
  const s = shell(CALLERS.unidentified);
  t.after(s.done);
  const r = await s.relo("work", "update", "--status", "Chapter four");
  assert.equal(r.json.error.code, "REFUSED_NO_SESSION");
  const wrong = await s.relo("work", "update", "--work", "wrk_deadbeef.not-a-token", "--status", "Chapter four");
  assert.equal(wrong.json.error.code, "REFUSED_HANDLE");
  assert.equal(s.calls.length, 0);
});

test("DOGFOOD #11: relo work state is relo state", async (t) => {
  const s = shell(CALLERS.agent_session);
  t.after(s.done);
  const a = await s.relo("work", "state");
  const b = await s.relo("state");
  assert.equal(a.code, 0, a.text);
  assert.deepEqual(a.json, b.json);
});

test("DOGFOOD #15: a comma inside brackets stays in the label; newline lists; unclosed brackets refused", () => {
  assert.deepEqual(splitLabels("Build,Install iPhone 0.10.0 (owner, later),Verify"), ["Build", "Install iPhone 0.10.0 (owner, later)", "Verify"]);
  assert.deepEqual(splitLabels('Write "Hello, world" sample,Ship'), ['Write "Hello, world" sample', "Ship"]);
  assert.deepEqual(splitLabels("Check logs, metrics\nShip the fix"), ["Check logs, metrics", "Ship the fix"]);
  assert.deepEqual(splitLabels("Reproduce the bug, Find the cause"), ["Reproduce the bug", "Find the cause"]);
  assert.throws(() => splitLabels("Install (owner, later"), { code: "REFUSED_PLAN_LIST" });
  assert.throws(() => splitLabels("Install owner), later"), { code: "REFUSED_PLAN_LIST" });
});

test("DOGFOOD #16 + plans extend without restarts: investigation → add → revise → step count → complete", () => {
  let { plan } = startPlan(["Reproduce the crash", "Find the cause"]);
  ({ plan } = applyChange(plan, { nextStep: true }));
  ({ plan } = applyChange(plan, { add: ["Write the fix", "Run the tests"] }));
  ({ plan } = applyChange(plan, { plan: ["Run the tests", "Write the fix", "Release"] }));
  assert.deepEqual(plan.steps.map((s) => [s.id, s.state]), [["s1", "done"], ["s2", "skipped"], ["s4", "current"], ["s3", "open"], ["s5", "open"]]);
  ({ plan } = applyChange(plan, { progress: { done: 3, total: 9 } }));
  assert.deepEqual(plan.steps.find((s) => s.state === "current").progress, { done: 3, total: 9 });
  const echo = renderEcho({ work: { id: "wrk_00000001", goal: "Fix the login crash", lifecycle: "open", plan } });
  const stepLines = echo.split("\n").filter((l) => /^ {2}\[/u.test(l));
  assert.deepEqual(stepLines, [
    "  [x] s1 Reproduce the crash",
    "  [>] s4 Run the tests   (3/9)",
    "  [ ] s3 Write the fix",
    "  [ ] s5 Release",
    "  [-] 1 skipped: s2 Find the cause",
  ]);
  ({ plan } = applyChange(plan, { nextStep: true }));
  ({ plan } = applyChange(plan, { nextStep: true }));
  ({ plan } = applyChange(plan, { nextStep: true }));
  assert.match(renderEcho({ work: { id: "wrk_00000001", goal: "Fix the login crash", lifecycle: "open", plan } }), /Next: relo work finish/u);
  assert.equal(new Set(plan.steps.map((s) => s.id)).size, plan.steps.length, "ids never reused");
});

test("content filter: no false positives on SHAs, UUIDs, versions, dates; secrets and paths refused", () => {
  for (const text of [
    "Review commit 9a4a72de0f1c2b3a4d5e6f708192a3b4c5d6e7f8",
    "Deploy 0.17.0-rc.2 to staging",
    "Retry job 3f2b1c9e-8d7a-4b6c-9e1f-2a3b4c5d6e7f",
    "Backfill 2026-10-14T08:29:09Z rows",
    "Bump node to v22.22.2",
    "Check https://relo.example.com/api/now",
    "Merge PR #1234 into main",
  ]) assert.equal(checkText("status", text), text);
  for (const text of ["Using sk-abcdefghijklmnopqrstuvwxyz123456", "Token ghp_abcDEF123", "Edit /Users/someone/project/file.ts", "Saw AKIAABCDEFGHIJKLMNOP in logs"]) {
    assert.throws(() => checkText("status", text), { code: "CONTENT_REFUSED" }, text);
  }
});

test("hooks never write works or cards (sources never cross)", async (t) => {
  const s = shell(CALLERS.agent_session);
  t.after(s.done);
  for (const event of ["SessionStart", "PostToolUse", "Stop", "UserPromptSubmit"]) {
    const out = [];
    const code = await run(["hook", "claude-code", event], { stdout: (l) => out.push(l), stderr: (l) => out.push(l) },
      { env: { CLAUDE_CODE_SESSION_ID: "principles-session" }, loadConfig: async () => ({ apiUrl: "http://relo.test", token: "t".repeat(44) }),
        stdinIsTTY: false, readStdinJson: async () => ({ session_id: "principles-session", hook_event_name: event, cwd: "/tmp" }),
        fetchImpl: async (url, init) => { s.calls.push({ method: init?.method, path: new URL(url).pathname }); return { ok: true, status: 200, headers: new Headers(), json: async () => ({}) }; } });
    assert.equal(code, 0);
    assert.deepEqual(out, [], "a hook never prints");
  }
  assert.ok(s.calls.every((c) => !/\/api\/session\/works|\/api\/activities|\/api\/notifications|\/api\/interactions/u.test(c.path)), JSON.stringify(s.calls));
});
