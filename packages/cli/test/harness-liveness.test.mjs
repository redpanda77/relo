import "./hermetic-env.mjs";
// The liveness check (observed state only): the harness's own process is recorded once per session run, and a
// sweep ends a session whose harness process is gone (a killed or archived harness runs no SessionEnd hook).
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { adapterFor } from "../src/harness/adapters/index.mjs";
import claudeCode from "../src/harness/adapters/claude-code/index.mjs";
import opencode from "../src/harness/adapters/opencode/index.mjs";
import { findHarnessProcess, processAlive } from "../src/harness/core/liveness-probe.mjs";
import { ENDED_KEEP_MS, sweepGoneSessions } from "../src/harness/core/sweep.mjs";
import { hookBox } from "./hook-fixture.mjs";

// What the flusher's dependencies carry for the sweep: the state folders plus the box's injections.
const sweepDeps = (box, extra = {}) => ({ env: {}, accountProbes: {}, ...box.deps(), observedStateDirectory: join(box.state, "observed"),
  outboxDirectory: box.outbox, ...extra });

const observedFile = async (box) => {
  const directory = join(box.state, "observed");
  const name = (await readdir(directory)).find((file) => file.endsWith(".json") && !file.startsWith("."));
  return JSON.parse(await readFile(join(directory, name), "utf8"));
};

function withProcess(box, { finds = 0, alive = true } = {}) {
  const calls = { find: 0, alive: [] };
  const probe = {
    findHarnessProcess: async ({ match, startPid }) => { calls.find += 1; calls.startPid = startPid; calls.matched = match("/x/claude --resume"); return { pid: 4242, start: "Sat Oct 17 10:00:00 2026" }; },
    processAlive: async (args) => { calls.alive.push(args); return typeof alive === "function" ? alive(args) : alive; },
  };
  const deps = box.deps;
  box.deps = () => ({ ...deps(), harnessProcess: probe, parentPid: 777 });
  return calls;
}

// The sweep's first pass resolves the process the hook noted; later passes check it.
const sweep = (box, extra = {}) => sweepGoneSessions({ adapterFor, dependencies: sweepDeps(box, extra), intervalMs: 0 });

test("a hook only notes the process that ran it, once per session run; the sweep resolves it to the harness's own", async () => {
  const box = await hookBox();
  const calls = withProcess(box);
  await box.event("SessionStart", "start", { source: "startup" });
  await box.event("UserPromptSubmit", "prompt");
  await box.event("Stop", "stop");
  assert.equal(calls.find, 0, "no process lookup on the hook path");
  assert.equal((await observedFile(box)).harnessCandidate, 777);
  assert.equal((await observedFile(box)).harnessPid, undefined);
  await sweep(box);
  assert.equal(calls.find, 1);
  assert.equal(calls.startPid, 777);
  assert.equal(calls.matched, true);
  const state = await observedFile(box);
  assert.equal(state.harnessPid, 4242);
  assert.equal(state.harnessStart, "Sat Oct 17 10:00:00 2026");
  assert.equal(JSON.stringify(box.sent).includes("4242"), false, "the pid never leaves the computer");
  await box.event("SessionStart", "start", { source: "resume" });
  assert.equal((await observedFile(box)).harnessPid, undefined, "a resumed session is a new process, resolved again");
  await sweep(box);
  assert.equal(calls.find, 2);
});

test("the sweep ends a session whose harness process is gone, through the outbox, and leaves declared work alone", async () => {
  const box = await hookBox();
  withProcess(box, { alive: false });
  await box.event("SessionStart", "start", { source: "startup" });
  await box.event("Notification", "wait", { notification_type: "permission_prompt" });
  assert.equal(box.sent.at(-1).phase, "waiting");
  await sweep(box);
  box.clock += 120_000;
  const ended = await sweep(box);
  await box.collect();
  assert.equal(ended.length, 1);
  assert.equal(box.sent.at(-1).phase, "ended");
  assert.equal((await observedFile(box)).phase, "ended");
  assert.equal(box.sent.length, 3);
  assert.deepEqual(await sweep(box), [], "an ended session is not swept twice");
  assert.deepEqual(await readdir(join(box.state)).then((names) => names.filter((name) => name === "sessions")), [], "no declared work file was created");
});

test("the sweep leaves a live harness alone, and runs at most once per interval", async () => {
  const box = await hookBox();
  const calls = withProcess(box, { alive: true });
  await box.event("SessionStart", "start", { source: "startup" });
  await sweep(box);
  box.clock += 120_000;
  assert.deepEqual(await sweepGoneSessions({ adapterFor, dependencies: sweepDeps(box) }), []);
  assert.equal(calls.alive.length, 1);
  assert.equal(calls.alive[0].pid, 4242);
  assert.deepEqual(await sweepGoneSessions({ adapterFor, dependencies: sweepDeps(box) }), [], "throttled");
  assert.equal(calls.alive.length, 1);
  assert.equal((await observedFile(box)).phase, "open");
});

test("a session whose noted process is not the harness (or is gone) is never swept", async () => {
  const box = await hookBox();
  const deps = box.deps;
  box.deps = () => ({ ...deps(), parentPid: 777, harnessProcess: { findHarnessProcess: async () => undefined, processAlive: async () => assert.fail("must not check") } });
  await box.event("SessionStart", "start", { source: "startup" });
  await sweep(box);
  assert.equal((await observedFile(box)).harnessPid, null);
  box.clock += 120_000;
  assert.deepEqual(await sweep(box), []);
  assert.equal((await observedFile(box)).phase, "open");
});

test("a sweep end for an older process does not end a session resumed in a new one", async () => {
  const box = await hookBox();
  withProcess(box, { alive: true });
  await box.event("SessionStart", "start", { source: "startup" });
  await sweep(box);
  const { processEvent } = await import("../src/harness/core/process.mjs");
  await processEvent({ adapter: claudeCode, input: {}, dependencies: sweepDeps(box),
    event: { event: "end", harness: "claude-code", session: (await observedFile(box)).session, subagent: false, reason: "gone", expectPid: 1111 } });
  assert.equal((await observedFile(box)).phase, "open");
});

test("relo outbox flush runs the sweep first", async () => {
  const box = await hookBox();
  withProcess(box, { alive: false });
  await box.event("SessionStart", "start", { source: "startup" });
  await sweep(box);
  box.clock += 120_000;
  await box.flush({ now: () => box.clock, ...{ harnessProcess: { processAlive: async () => false } } });
  assert.equal((await observedFile(box)).phase, "ended");
});

test("findHarnessProcess walks up to the nearest harness ancestor; processAlive guards pid reuse", async () => {
  const table = { 30: { ppid: 20, start: "a", command: "sh -c relo hook" }, 20: { ppid: 10, start: "b", command: "/Apps/claude --x" }, 10: { ppid: 1, start: "c", command: "claude outer" } };
  const row = async (pid) => table[pid];
  assert.deepEqual(await findHarnessProcess({ match: claudeCode.harnessProcess, startPid: 30, row }), { pid: 20, start: "b" });
  assert.equal(await findHarnessProcess({ match: () => false, startPid: 30, row }), undefined);
  assert.equal(claudeCode.harnessProcess("/Applications/Claude.app/Contents/MacOS/Claude"), false);
  const gone = () => { throw Object.assign(new Error("x"), { code: "ESRCH" }); };
  assert.equal(await processAlive({ pid: 5, kill: gone }), false);
  assert.equal(await processAlive({ pid: 5, start: "b", kill: () => {}, row: async () => ({ start: "b" }) }), true);
  assert.equal(await processAlive({ pid: 5, start: "b", kill: () => {}, row: async () => ({ start: "z" }) }), false, "the pid was reused");
  assert.equal(await processAlive({ pid: 5, start: "b", kill: () => { throw Object.assign(new Error("x"), { code: "EPERM" }); }, row: async () => undefined }), true);
});

test("OpenCode's own process is recognized (its plugin runs hooks from it); its config files are not", () => {
  for (const command of ["opencode", "opencode serve --port 4096", "/usr/local/lib/node_modules/opencode-ai/bin/opencode.exe -c"]) {
    assert.equal(opencode.harnessProcess(command), true, command);
  }
  for (const command of ["vim opencode.json", "/bin/sh -c relo hook start", "claude"]) assert.equal(opencode.harnessProcess(command), false, command);
});

const DAY = 24 * 60 * 60 * 1000;
const sweepDefault = (box, extra = {}) => sweepGoneSessions({ adapterFor, dependencies: sweepDeps(box, extra) });
const observedNames = async (box) => (await readdir(join(box.state, "observed"))).filter((name) => !name.startsWith(".")).sort();

test("resolving the noted process runs on every call, even inside the 60-second interval; only the alive check is throttled", async () => {
  const box = await hookBox();
  const calls = withProcess(box, { alive: true });
  await sweepDefault(box);
  await box.event("SessionStart", "start", { source: "startup" });
  await sweepDefault(box);
  assert.equal(calls.find, 1, "resolved at once, not after the interval");
  assert.equal((await observedFile(box)).harnessPid, 4242);
  assert.equal(calls.alive.length, 0, "the alive check waits for the interval");
  box.clock += 5_000;
  await sweepDefault(box);
  assert.equal(calls.find, 1, "a resolved record is not resolved again");
  assert.equal(calls.alive.length, 0);
});

test("a harness that died after its first resolve but before the next check still ends", async () => {
  const box = await hookBox();
  const calls = withProcess(box, { alive: false });
  await sweepDefault(box);
  await box.event("SessionStart", "start", { source: "startup" });
  box.clock += 5_000;
  await sweepDefault(box);
  assert.equal((await observedFile(box)).harnessPid, 4242);
  box.clock += 120_000;
  const ended = await sweepDefault(box);
  assert.equal(ended.length, 1);
  assert.equal((await observedFile(box)).phase, "ended");
  assert.equal(calls.alive.length, 1);
});

test("a sweep that ends a session outside the flusher starts one; inside the flusher it does not", async () => {
  const box = await hookBox();
  withProcess(box, { alive: false });
  await box.event("SessionStart", "start", { source: "startup" });
  await sweep(box);
  box.clock += 120_000;
  const spawned = box.spawned;
  await sweep(box);
  assert.equal(box.spawned, spawned, "the flusher is already running");
  const again = await hookBox();
  withProcess(again, { alive: false });
  await again.event("SessionStart", "start", { source: "startup" });
  await sweep(again);
  again.clock += 120_000;
  const before = again.spawned;
  assert.equal((await sweepGoneSessions({ adapterFor, intervalMs: 0, startFlusher: true, dependencies: sweepDeps(again) })).length, 1);
  assert.ok(again.spawned > before);
});

test("garbage collection removes the local files of sessions ended more than 7 days ago and keeps recent ones", async () => {
  const box = await hookBox();
  await box.event("SessionStart", "start", { source: "startup" });
  await box.event("SessionEnd", "end", { reason: "other" });
  const old = (await observedNames(box)).filter((name) => name.endsWith(".json"));
  assert.equal(old.length, 1);
  await writeFile(join(box.state, "observed", `${old[0]}.journal`), "");
  box.clock += ENDED_KEEP_MS + DAY;
  await box.event("SessionStart", "start", { source: "startup", session_id: "22222222-3333-4444-8555-666666666666" });
  await box.event("SessionEnd", "end", { session_id: "22222222-3333-4444-8555-666666666666", reason: "other" });
  assert.equal((await observedNames(box)).filter((name) => name.endsWith(".json")).length, 2);
  // Per-session marker files: an old one goes, a recent one stays.
  const hooks = join(box.state, "hooks");
  await mkdir(hooks, { recursive: true });
  const stale = join(hooks, "harness-stale.json");
  const fresh = join(hooks, "context-fresh.json");
  const other = join(hooks, "optimize.json");
  for (const path of [stale, fresh, other]) await writeFile(path, "{}");
  await utimes(stale, (box.clock - ENDED_KEEP_MS - DAY) / 1000, (box.clock - ENDED_KEEP_MS - DAY) / 1000);
  await utimes(fresh, box.clock / 1000, box.clock / 1000);
  await utimes(other, (box.clock - ENDED_KEEP_MS - DAY) / 1000, (box.clock - ENDED_KEEP_MS - DAY) / 1000);
  await sweepDefault(box);
  const left = await observedNames(box);
  assert.equal(left.filter((name) => name.endsWith(".json")).length, 1, "only the recently ended session is kept");
  assert.ok(!left.includes(old[0]) && !left.includes(`${old[0]}.journal`));
  assert.deepEqual((await readdir(hooks)).filter((name) => name.endsWith(".json")).sort(), ["context-fresh.json", "optimize.json"], "only stale per-session markers go");
});
