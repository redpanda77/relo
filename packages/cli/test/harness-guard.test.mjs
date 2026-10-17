import "./hermetic-env.mjs";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import claudeCode from "../src/harness/adapters/claude-code/index.mjs";
import { wantedEntries } from "../src/harness/adapters/claude-code/levels.mjs";
import { editGuard, HIDDEN_REPLY, LAG_MS } from "../src/harness/core/guard.mjs";
import { runHarnessRole } from "../src/harness/core/roles.mjs";
import { sessionKey } from "../src/shared/session-key.mjs";

const NOW = Date.parse("2026-10-17T10:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const TURN = NOW - 60_000;
const file = (open, extra = {}) => ({ v: 1, writtenAt: iso(NOW - 60_000), open: { id: "wrk_1", goal: "Ship it", lifecycle: "open", version: 3, ...open }, parked: [], ...extra });
const plan = (rounds, ...steps) => ({ plan: { rounds, steps } });

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "relo-guard-"));
  const env = { XDG_STATE_HOME: join(root, "state") };
  const printed = [];
  const dependencies = { env, home: root, now: () => NOW, hookStateDirectory: join(root, "hooks"), emit: (line) => printed.push(line) };
  const sessions = join(env.XDG_STATE_HOME, "relo", "sessions");
  mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const path = join(sessions, `${sessionKey({ harness: "claude-code", id: "sess-1" })}.json`);
  const guard = (tool_name, tool_input = {}) => runHarnessRole({ adapter: claudeCode, role: "guard", dependencies,
    input: { session_id: "sess-1", hook_event_name: "PreToolUse", tool_use_id: "t1", tool_name, tool_input } });
  return { printed, path, guard, dependencies };
}

test("a relo reply the agent would not read: sent to /dev/null, filtered through a pipe; quoted text, --json and plain chains are fine", () => {
  const hidden = (command) => claudeCode.guardCall({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }).hiddenReply;
  for (const command of ['relo work update --next-step >/dev/null; cat notes', "relo state 2>&1 | tail -5", 'RELO_X=1 relo work start --goal "g" &>/dev/null',
    'relo work finish --outcome "x" 2>/dev/null', 'cd app && relo work update --status "Testing" | grep Owner']) assert.equal(hidden(command), true, command);
  for (const command of ['cd app && relo work update --next-step --status "Testing"; git status', 'relo work update --status "a | b; c >/dev/null"',
    'if relo ask "Deploy?" --approval; then ./deploy.sh; fi', "relo state --json | jq .open", "git log | head; relo state", "npm test >/dev/null", "relo setup --refresh 2>&1 | head -c 120", "relo --version >/dev/null"]) assert.equal(hidden(command), false, command);
});

test("the guard refuses a hidden relo reply with one reason, and never reads or keeps the command", async () => {
  const box = sandbox();
  const outcome = await box.guard("Bash", { command: "relo work update --next-step >/dev/null" });
  assert.equal(outcome.printed, true);
  assert.deepEqual(box.printed[0], { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: HIDDEN_REPLY } });
  box.printed.length = 0;
  assert.equal((await box.guard("Bash", { command: 'relo work update --next-step --status "Testing"' })).printed, false);
  assert.equal(box.printed.length, 0);
});

test("before an edit: no card yet, once per turn", () => {
  const first = editGuard({ now: NOW, state: undefined, bookkeeping: { turnStartedAt: TURN } });
  assert.match(first.context, /^Relo: this session has no card\. If this request takes more than a couple of minutes, before your first edit: relo work start --goal/u);
  assert.equal(editGuard({ now: NOW, state: undefined, bookkeeping: { turnStartedAt: TURN, guardKey: first.key } }), undefined, "once per turn");
  assert.ok(editGuard({ now: NOW, state: undefined, bookkeeping: { turnStartedAt: TURN + 1, guardKey: first.key } }), "again next turn");
  assert.match(editGuard({ now: NOW, state: file({ lifecycle: "finished" }), bookkeeping: {} }).context, /no card/u);
  assert.match(editGuard({ now: NOW, state: file({ lifecycle: "paused" }), bookkeeping: {} }).context, /is paused\. Same goal → relo work resume/u);
});

test("before an edit: a delivered round means a new request needs its round first", () => {
  const state = file(plan([{ n: 1, state: "closed", outcome: "Fixed" }], { id: "s1", label: "Fix it", state: "done", round: 1 }));
  const found = editGuard({ now: NOW, state, bookkeeping: { turnStartedAt: TURN } });
  assert.equal(found.context, 'Relo: round 1 of "Ship it" was delivered and you are editing for a new request. First: relo work start --round "<the request in a few words>" --plan "…" (another goal: relo work start --new --goal "…").');
});

test("before an edit: a card left on one step for ten minutes asks whether it moved on; a fresh card, a wait or a question says nothing", () => {
  const steps = [{ id: "s1", label: "Find the cause", state: "done" }, { id: "s2", label: "Fix it", state: "current" }, { id: "s3", label: "Test it", state: "pending" }];
  const old = { ...file(plan([{ n: 1, state: "open" }], ...steps)), writtenAt: iso(NOW - LAG_MS - 60_000) };
  const found = editGuard({ now: NOW, state: old, bookkeeping: {} });
  assert.equal(found.context, 'Relo: the card still shows "Fix it" (step 2 of 3), updated 11 min ago. If that step is done: relo work update --next-step --status "<what you do now>"; further along: --step "<the step you are on>". Still on it: carry on.');
  assert.equal(editGuard({ now: NOW, state: old, bookkeeping: { guardKey: found.key } }), undefined, "once per card write");
  assert.equal(editGuard({ now: NOW, state: { ...old, writtenAt: iso(NOW - 60_000) }, bookkeeping: {} }), undefined);
  assert.equal(editGuard({ now: NOW, state: { ...old, open: { ...old.open, waiting: { reason: "the deploy" } } }, bookkeeping: {} }), undefined);
  assert.equal(editGuard({ now: NOW, state: { ...old, question: { id: "q1" } }, bookkeeping: {} }), undefined);
});

test("the guard role runs the edit check through the adapter and records its key; other tools and subagents get nothing", async () => {
  const box = sandbox();
  assert.equal((await box.guard("Edit")).printed, true);
  assert.match(box.printed[0].hookSpecificOutput.additionalContext, /^Relo: this session has no card/u);
  assert.equal(box.printed[0].hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal((await box.guard("Write")).printed, false, "once per turn");
  writeFileSync(box.path, JSON.stringify(file(plan([{ n: 1, state: "open" }], { id: "s1", label: "Fix it", state: "current" }))), { mode: 0o600 });
  assert.equal((await box.guard("MultiEdit")).printed, false, "a fresh card");
  assert.equal((await box.guard("Read")).printed, false);
  const sub = await runHarnessRole({ adapter: claudeCode, role: "guard", dependencies: box.dependencies,
    input: { session_id: "sess-1", agent_id: "sub-1", hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: {} } });
  assert.equal(sub.printed, false);
});

test("guide and optimize install the edit guard; off installs nothing", () => {
  for (const level of ["presence", "approvals", "approvals+lean"]) {
    assert.ok(wantedEntries(level).PreToolUse.some((group) => group.matcher === "Edit|Write|MultiEdit|NotebookEdit" && group.hooks[0].command === "relo hook guard"), level);
  }
  assert.deepEqual(wantedEntries("off"), {});
});

test("an agent's relo reply sent to /dev/null goes to stderr instead; a script's stays silent", () => {
  const bin = fileURLToPath(new URL("../bin/relo.mjs", import.meta.url));
  const home = mkdtempSync(join(tmpdir(), "relo-null-"));
  const base = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, "config"), XDG_STATE_HOME: join(home, "state") };
  const run = (env) => spawnSync(process.execPath, [bin, "help", "work"], { env: { ...base, ...env }, stdio: ["ignore", openSync("/dev/null", "w"), "pipe"], encoding: "utf8" });
  const agent = run({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "sess-null" }).stderr;
  assert.match(agent, /^Relo: this reply was sent to \/dev\/null, so it is shown here\. Run relo commands alone/u);
  assert.match(agent, /^relo work: \d+ commands/mu);
  assert.doesNotMatch(run({}).stderr, /relo work:/u);
});
