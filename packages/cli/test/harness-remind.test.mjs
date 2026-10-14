import "./hermetic-env.mjs";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import claudeCode from "../src/harness/adapters/claude-code/index.mjs";
import { remind, reminderText, REMINDER_TURN_SECONDS } from "../src/harness/core/remind.mjs";
import { runHarnessRole as runRole } from "../src/harness/core/roles.mjs";

const runHarnessRole = (options) => runRole({ adapter: claudeCode, ...options });
import { sessionKey } from "../src/caller.mjs";

const NOW = Date.parse("2026-10-14T10:00:00Z");
const iso = (ms) => new Date(ms).toISOString();
const steps = (...states) => states.map((state, i) => ({ id: `s${i + 1}`, label: `Step ${i + 1}`, state }));
const file = (open, extra = {}) => ({ v: 1, writtenAt: iso(NOW - 60_000), open: { id: "wrk_1", goal: "Ship it", lifecycle: "open", version: 3, ...open }, parked: [], ...extra });

test("no output when stop_hook_active is true", () => {
  assert.equal(remind({ event: { stopActive: true }, now: NOW, state: file({ plan: { steps: steps("done") } }) }), undefined);
});

test("no output for a subagent, a missing or expired session file, no open work, or a pending question", () => {
  const done = { plan: { steps: steps("done", "done") } };
  assert.equal(remind({ event: { subagent: true }, now: NOW, state: file(done) }), undefined);
  assert.equal(remind({ event: {}, now: NOW, state: undefined }), undefined);
  assert.equal(remind({ event: {}, now: NOW, state: { ...file(done), writtenAt: iso(NOW - 9 * 3600_000) } }), undefined);
  assert.equal(remind({ event: {}, now: NOW, state: { ...file(done), open: null } }), undefined);
  assert.equal(remind({ event: {}, now: NOW, state: file({ ...done, lifecycle: "paused" }) }), undefined);
  assert.equal(remind({ event: {}, now: NOW, state: file(done, { question: { id: "q1" } }) }), undefined);
});

test("plan complete → R1 text exactly; once per state change; again after a new write changes the fingerprint", () => {
  const state = file({ plan: { steps: steps("done", "skipped") } });
  const first = remind({ event: {}, now: NOW, state });
  assert.equal(first.context,
    `Relo: every step of "Ship it" is done, but the work is still open on the owner's Lock Screen. If it is finished: relo work finish --outcome "<what was achieved>". If more is needed: relo work update --add "<next step>". If neither, end your turn; this note will not repeat until the work changes.`);
  assert.equal(remind({ event: {}, now: NOW, state, bookkeeping: { reminded: first.reminded } }), undefined);
  const rewritten = { ...state, writtenAt: iso(NOW - 1000) };
  assert.ok(remind({ event: {}, now: NOW, state: rewritten, bookkeeping: { reminded: first.reminded } }));
});

test("step count complete → R2", () => {
  const out = remind({ event: {}, now: NOW, state: file({ plan: { steps: [{ id: "s1", label: "Resize", state: "current", progress: { done: 10, total: 10 } }, { id: "s2", label: "Upload", state: "pending" }] } }) });
  assert.match(out.context, /^Relo: the current step "Resize" shows 10 of 10 done, but it is still the current step\./u);
  const counted = remind({ event: {}, now: NOW, state: file({ progress: { done: 10, total: 10 } }) });
  assert.match(counted.context, /^Relo: "Ship it" shows 10 of 10 done but is still open\./u);
});

test("long turn without a write → R3 with minutes and step; short turn and a fresh card → nothing", () => {
  const state = { ...file({ plan: { steps: steps("done", "current", "pending") } }), writtenAt: iso(NOW - 5 * 60_000) };
  const turnStartedAt = NOW - (REMINDER_TURN_SECONDS + 10) * 1000;
  const out = remind({ event: {}, now: NOW, state, bookkeeping: { turnStartedAt } });
  assert.equal(out.context,
    `Relo: "Ship it" is open and its card was last updated 5 min ago (now at step 2: "Step 2"). If the work moved on: relo work update --status "<what changed>" [--next-step]. If it is done: relo work finish --outcome "<what was achieved>". If nothing changed, end your turn; this note will not repeat until the work changes.`);
  assert.equal(remind({ event: {}, now: NOW, state, bookkeeping: { turnStartedAt: NOW - 30_000 } }), undefined);
  assert.equal(remind({ event: {}, now: NOW, state: { ...state, writtenAt: iso(NOW - 10_000) }, bookkeeping: { turnStartedAt } }), undefined);
  assert.doesNotMatch(reminderText("R3", { goal: "G", lastWriteAt: iso(NOW - 60_000) }, NOW), /now at step/u);
});

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "relo-harness-"));
  const env = { XDG_STATE_HOME: join(root, "state") };
  const hookStateDirectory = join(root, "hooks");
  const printed = [];
  const dependencies = { env, home: root, now: () => NOW, hookStateDirectory, emit: (line) => printed.push(line) };
  const key = sessionKey({ harness: "claude-code", id: "sess-1" });
  const sessions = join(env.XDG_STATE_HOME, "relo", "sessions");
  mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const path = join(sessions, `${key}.json`);
  return { root, dependencies, printed, path, hookStateDirectory };
}

test("dispatcher prints one JSON object with hookEventName Stop and never a decision field; bookkeeping is the hook's own file", async () => {
  const box = sandbox();
  writeFileSync(box.path, JSON.stringify(file({ plan: { steps: steps("done") } })), { mode: 0o600 });
  const before = readFileSync(box.path, "utf8");
  const mtime = statSync(box.path).mtimeMs;
  const outcome = await runHarnessRole({ role: "remind", input: { session_id: "sess-1" }, dependencies: box.dependencies });
  assert.equal(outcome.printed, true);
  assert.equal(box.printed.length, 1);
  assert.deepEqual(Object.keys(box.printed[0]), ["hookSpecificOutput"]);
  assert.equal(box.printed[0].hookSpecificOutput.hookEventName, "Stop");
  assert.equal(JSON.stringify(box.printed[0]).includes("decision"), false);
  assert.equal(JSON.stringify(box.printed[0]).includes("\n"), false);
  // second Stop with the same state: nothing (once per state change)
  await runHarnessRole({ role: "remind", input: { session_id: "sess-1" }, dependencies: box.dependencies });
  assert.equal(box.printed.length, 1);
  // stop_hook_active: nothing
  await runHarnessRole({ role: "remind", input: { session_id: "sess-1", stop_hook_active: true }, dependencies: box.dependencies });
  assert.equal(box.printed.length, 1);
  // reads never write: the CLI session file is untouched
  assert.equal(readFileSync(box.path, "utf8"), before);
  assert.equal(statSync(box.path).mtimeMs, mtime);
  assert.ok(readdirSync(box.hookStateDirectory).some((name) => name.startsWith("harness-")));
});

test("any failure → no output and no throw (fail open); turn stamps turnStartedAt", async () => {
  const box = sandbox();
  writeFileSync(box.path, "{not json", { mode: 0o600 });
  const outcome = await runHarnessRole({ role: "remind", input: { session_id: "sess-1" }, dependencies: { ...box.dependencies, now: () => { throw new Error("boom"); } } });
  assert.equal(outcome.printed, false);
  assert.equal(box.printed.length, 0);
  assert.equal((await runHarnessRole({ role: "remind", input: {}, dependencies: box.dependencies })).printed, false);
  await runHarnessRole({ role: "turn", input: { session_id: "sess-1" }, dependencies: box.dependencies });
  const name = readdirSync(box.hookStateDirectory).find((n) => n.startsWith("harness-"));
  assert.equal(JSON.parse(readFileSync(join(box.hookStateDirectory, name), "utf8")).turnStartedAt, NOW);
});

test("sessions are isolated: another session's open work never reminds this one", async () => {
  const box = sandbox();
  writeFileSync(box.path, JSON.stringify(file({ plan: { steps: steps("done") } })), { mode: 0o600 });
  const outcome = await runHarnessRole({ role: "remind", input: { session_id: "sess-2" }, dependencies: box.dependencies });
  assert.equal(outcome.printed, false);
  assert.equal(box.printed.length, 0);
});
