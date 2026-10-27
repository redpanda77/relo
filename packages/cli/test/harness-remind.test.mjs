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
import { sessionKey } from "../src/shared/session-key.mjs";

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
    `Relo: every step of "Ship it" is done, but this round is still open on the owner's screen. If it is done and nothing is left: relo work finish --outcome "<what was achieved>". If this request is done and more of the goal is to come: relo work deliver --outcome "<what was delivered>". If more is needed now: relo work update --add "<next step>". If none of these, end your turn; this note will not repeat until the work changes.`);
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

test("long turn without a write → R3 with minutes and step; short turn → nothing; long turn with a fresh card and steps left → R4", () => {
  const state = { ...file({ plan: { steps: steps("done", "current", "pending") } }), writtenAt: iso(NOW - 5 * 60_000) };
  const turnStartedAt = NOW - (REMINDER_TURN_SECONDS + 10) * 1000;
  const out = remind({ event: {}, now: NOW, state, bookkeeping: { turnStartedAt } });
  assert.equal(out.context,
    `Relo: "Ship it" is open and its card was last updated 5 min ago (now at step 2: "Step 2"). If the work moved on: relo work update --status "<what changed>" [--next-step]. If it is done and nothing is left: relo work finish --outcome "<what was achieved>"; if this request is done and more of the goal is to come: relo work deliver --outcome "<what was delivered>" (refused while steps are open; the owner must act mid-plan: relo ask or --waiting). If nothing changed, end your turn; this note will not repeat until the work changes.`);
  assert.equal(remind({ event: {}, now: NOW, state, bookkeeping: { turnStartedAt: NOW - 30_000 } }), undefined);
  const ending = remind({ event: {}, now: NOW, state: { ...state, writtenAt: iso(NOW - 10_000) }, bookkeeping: { turnStartedAt } });
  assert.equal(ending.reminded.kind, "R4");
  assert.equal(ending.context,
    `Relo: your turn is ending with "Ship it" open at "Step 2" (step 2 of 3). If this request is done: relo work deliver --outcome "<what it delivered>" (the goal itself done: relo work finish). A deploy, CI or a job still running: relo work update --waiting "<what>". If you asked the owner something, or the step is accurate, end your turn; this note will not repeat until the work changes.`);
  const waiting = { ...state, writtenAt: iso(NOW - 10_000), open: { ...state.open, waiting: { reason: "the deploy" } } };
  assert.equal(remind({ event: {}, now: NOW, state: waiting, bookkeeping: { turnStartedAt } }), undefined, "a declared wait needs no R4");
  assert.equal(remind({ event: {}, now: NOW, state: { ...state, writtenAt: iso(NOW - 10_000) }, bookkeeping: { turnStartedAt, reminded: ending.reminded } }), undefined, "once per state");
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

const round = (state, extra = {}) => ({ n: 1, state, ...extra });

test("R0: a pending refusal is chased first, ignores freshness, and repeats only for a new refusal", () => {
  const refusal = { verb: "deliver", code: "CONTENT_REFUSED", what: "--outcome is 230 characters; the limit is 200", at: iso(NOW - 90_000), next: 'relo work deliver --outcome "Rotated every key…"' };
  // the card was written a minute ago and the plan is not complete: nothing else would speak
  const state = file({ plan: { steps: steps("current", "open") } }, { pendingRefusal: refusal });
  const first = remind({ event: {}, now: NOW, state });
  assert.equal(first.reminded.kind, "R0");
  assert.equal(first.context,
    `Relo: your relo work deliver was refused (--outcome is 230 characters; the limit is 200) and "Ship it" is still open on the owner's screen. Fix it: relo work deliver --outcome "Rotated every key…". If you no longer need it, end your turn; this note will not repeat until the work changes.`);
  assert.equal(remind({ event: {}, now: NOW, state, bookkeeping: { reminded: first.reminded } }), undefined, "once per refusal");
  const again = remind({ event: {}, now: NOW, state: { ...state, pendingRefusal: { ...refusal, at: iso(NOW - 1000) } }, bookkeeping: { reminded: first.reminded } });
  assert.equal(again.reminded.kind, "R0", "a new refusal reminds again");
  // R0 beats R1 (a complete plan)
  assert.equal(remind({ event: {}, now: NOW, state: file({ plan: { steps: steps("done") } }, { pendingRefusal: refusal }) }).reminded.kind, "R0");
  // no open work: nothing, even with a refusal on file
  assert.equal(remind({ event: {}, now: NOW, state: { ...state, open: null } }), undefined);
});

test("a delivered work (last round closed) gets no R1, R2 or R3; a new round with open steps is not complete", () => {
  const delivered = file({ plan: { steps: steps("done", "done").map((s) => ({ ...s, round: 1 })), rounds: [round("closed", { outcome: "Done" })] } });
  assert.equal(remind({ event: {}, now: NOW, state: delivered }), undefined);
  assert.equal(remind({ event: {}, now: NOW, state: { ...delivered, writtenAt: iso(NOW - 30 * 60_000) } }), undefined, "not even when stale");
  assert.equal(remind({ event: {}, now: NOW, state: file({ plan: { steps: [{ id: "s1", label: "A", state: "done", round: 1 }, { id: "s2", label: "B", state: "current", round: 2, progress: { done: 3, total: 3 } }], rounds: [round("closed"), { n: 2, state: "open" }] } }) }).reminded.kind, "R2");
  const second = file({ plan: { steps: [{ id: "s1", label: "A", state: "done", round: 1 }, { id: "s2", label: "B", state: "current", round: 2 }], rounds: [round("closed"), { n: 2, state: "open" }] } });
  assert.equal(remind({ event: {}, now: NOW, state: second }), undefined, "an open step in round 2: nothing to say yet");
  const empty = file({ plan: { steps: [{ id: "s1", label: "A", state: "done", round: 1 }], rounds: [round("closed"), { n: 2, state: "open" }] } });
  assert.equal(remind({ event: {}, now: NOW, state: empty }), undefined, "round 2 has no steps yet: round 1's done steps are not its completion");
});

test("the turn hook adds the open work as context: delivered, in progress, paused or no card at all; local and cheap", async () => {
  const box = sandbox();
  const run = () => runHarnessRole({ role: "turn", input: { session_id: "sess-1", hook_event_name: "UserPromptSubmit", prompt: "secret prompt text" }, dependencies: box.dependencies });
  assert.equal((await run()).printed, true, "no session file: the no-card line");
  assert.match(box.printed[0].hookSpecificOutput.additionalContext, /^Relo: this session has no card\. If this request takes more than a couple of minutes, before your first edit: relo work start --goal "<the goal>" --plan "A,B,C" \(one sitting: 3 to 6 milestones; a large body of work: its phases/u);
  box.printed.length = 0;
  writeFileSync(box.path, JSON.stringify(file({ plan: { steps: [{ id: "s1", label: "Find the cause", state: "current" }] } })), { mode: 0o600 });
  let outcome = await run();
  assert.equal(outcome.printed, true);
  assert.deepEqual(box.printed[0], { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext:
    `Relo: open work "Ship it"; round 1 "Ship it" in progress: current step "Find the cause". Same goal → keep updating (relo work update); new goal → relo work start --new --goal "…"; goal done → relo work finish --outcome "…".` } });
  assert.ok(box.printed[0].hookSpecificOutput.additionalContext.length <= 400);
  assert.equal(JSON.stringify(box.printed[0]).includes("secret prompt"), false, "the prompt is never read");
  writeFileSync(box.path, JSON.stringify(file({ goal: "Fix the login crash", plan: { steps: [{ id: "s1", label: "Fix it", state: "done", round: 1 }, { id: "s2", label: "Test it", state: "done", round: 2 }], rounds: [round("closed", { outcome: "Fixed" }), { n: 2, state: "closed", title: "Add a regression test", outcome: "Tested" }] } })), { mode: 0o600 });
  box.printed.length = 0;
  await run();
  assert.equal(box.printed[0].hookSpecificOutput.additionalContext,
    `Relo: open work "Fix the login crash"; round 2 "Add a regression test" delivered. Same goal → before your first edit: relo work start --round "<the request in a few words>" --plan "…"; new goal → relo work start --new --goal "…"; goal done → relo work finish --outcome "…".`);
  // paused: resume or start; finished: no card; the session file is only read; turnStartedAt is still recorded
  for (const [open, line] of [[{ lifecycle: "paused" }, /^Relo: this session's work "Ship it" is paused\. Same goal → relo work resume/u], [{ lifecycle: "finished" }, /^Relo: this session has no card/u]]) {
    writeFileSync(box.path, JSON.stringify(file(open)), { mode: 0o600 });
    box.printed.length = 0;
    await run();
    assert.match(box.printed[0].hookSpecificOutput.additionalContext, line);
  }
  const name = readdirSync(box.hookStateDirectory).find((n) => n.startsWith("harness-"));
  assert.equal(JSON.parse(readFileSync(join(box.hookStateDirectory, name), "utf8")).turnStartedAt, NOW);
  // a subagent's prompt, and any failure: nothing, no throw
  writeFileSync(box.path, JSON.stringify(file({})), { mode: 0o600 });
  assert.equal((await runHarnessRole({ role: "turn", input: { session_id: "sess-1", agent_id: "sub-1" }, dependencies: box.dependencies })).printed, false);
  writeFileSync(box.path, "{not json", { mode: 0o600 });
  box.printed.length = 0;
  await run();
  assert.match(box.printed[0].hookSpecificOutput.additionalContext, /^Relo: this session has no card/u, "an unreadable file reads as no card");
});
