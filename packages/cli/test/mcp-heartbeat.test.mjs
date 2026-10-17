import "./hermetic-env.mjs";
// The Relo MCP server's heartbeat for sessions at a permission prompt: once a minute it queues one small observed
// snapshot (heartbeat: true) for each session of its own harness whose phase is `waiting`, and for no other session.
// A hook sends nothing while a session waits, so this is how the server tells a prompt that waits from a session gone.
import assert from "node:assert/strict";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { adapterFor } from "../src/harness/adapters/index.mjs";
import { run } from "../src/cli.mjs";
import { heartbeatSessions } from "../src/harness/entry.mjs";
import { sweepGoneSessions } from "../src/harness/core/sweep.mjs";
import { hookBox } from "./hook-fixture.mjs";

const HARNESS = 4242;
const ELSEWHERE = 5151;
const [WAITING, WORKING, STOPPED, OPEN, OTHER] = [1, 2, 3, 4, 5].map((n) => `00000000-0000-4000-8000-00000000000${n}`);

async function sessions() {
  const box = await hookBox();
  const probe = { findHarnessProcess: async ({ startPid }) => ({ pid: startPid, start: "Sat Oct 17 10:00:00 2026" }), processAlive: async () => true };
  const base = box.deps;
  let parentPid = HARNESS;
  box.deps = () => ({ ...base(), harnessProcess: probe, get parentPid() { return parentPid; } });
  const start = async (id, pid, events) => {
    parentPid = pid;
    await box.event("SessionStart", "start", { session_id: id, source: "startup" });
    for (const [name, command, extra] of events) await box.event(name, command, { session_id: id, ...extra });
  };
  const wait = ["Notification", "wait", { notification_type: "permission_prompt" }];
  const prompt = ["UserPromptSubmit", "prompt", {}];
  await start(WAITING, HARNESS, [prompt, wait]);
  await start(WORKING, HARNESS, [prompt]);
  await start(STOPPED, HARNESS, [prompt, ["Stop", "stop", {}]]);
  await start(OPEN, HARNESS, []);
  await start(OTHER, ELSEWHERE, [prompt, wait]);
  parentPid = HARNESS;
  // The liveness sweep resolves each noted process to its harness's own pid.
  await sweepGoneSessions({ adapterFor, intervalMs: 0, dependencies: { env: {}, accountProbes: {}, ...box.deps(),
    observedStateDirectory: join(box.state, "observed"), outboxDirectory: box.outbox } });
  await box.collect();
  box.sent.length = 0;
  return box;
}

const heartbeats = (box) => box.sent.filter((body) => body.heartbeat === true);

test("a waiting session of this harness gets one heartbeat per tick; working, stopped, open and other-harness sessions get none", async () => {
  const box = await sessions();
  const before = box.spawned;
  box.clock += 60_000;
  assert.deepEqual((await heartbeatSessions({ pid: HARNESS }, box.deps())).map((item) => item.session.length > 0), [true]);
  await box.collect();
  assert.equal(box.sent.length, 1, "exactly one request");
  const [first] = heartbeats(box);
  assert.equal(first.phase, "waiting");
  assert.equal(first.lastSeenAt, new Date(box.clock).toISOString());
  assert.ok(box.spawned > before, "no flusher runs in the MCP server, so the heartbeat starts one");
  assert.deepEqual(Object.keys(first).filter((key) => !["session", "harness", "phase", "phaseSince", "lastSeenAt", "openToolSince", "seq", "project", "computer", "account", "heartbeat"].includes(key)), []);

  box.clock += 60_000;
  await heartbeatSessions({ pid: HARNESS }, box.deps());
  await box.collect();
  const [, second] = heartbeats(box);
  assert.equal(box.sent.length, 2);
  assert.equal(second.session, first.session);
  assert.equal(second.seq, first.seq + 1, "the sequence moves through the same state machine");
  assert.equal(second.phaseSince, first.phaseSince, "a heartbeat is not a phase change");
});

test("the heartbeat flag marks one snapshot only: the next phase change does not carry it", async () => {
  const box = await sessions();
  box.clock += 60_000;
  await heartbeatSessions({ pid: HARNESS }, box.deps());
  await box.event("PostToolUse", "tool-end", { session_id: WAITING, tool_use_id: "t1" });
  const last = box.sent.at(-1);
  assert.equal(last.phase, "working");
  assert.equal("heartbeat" in last, false);
});

test("another pid, an unresolved pid and no pid send nothing", async () => {
  const box = await sessions();
  assert.deepEqual(await heartbeatSessions({ pid: 9999 }, box.deps()), []);
  assert.deepEqual(await heartbeatSessions({ pid: undefined }, box.deps()), []);
  assert.deepEqual(await heartbeatSessions({ pid: 1 }, box.deps()), []);
  await box.collect();
  assert.deepEqual(box.sent, []);
});

test("the MCP server's minute tick sends the heartbeat", async () => {
  const box = await sessions();
  box.clock += 60_000;
  const stdin = new PassThrough();
  const base = box.deps();
  const server = run(["mcp"], { stdin, mcpOutput: { write() {} }, mcpLeaveGraceMs: 5, mcpTickMs: 20 },
    { ...base, parentPid: HARNESS, harnessProcess: { ...base.harnessProcess, processAlive: async () => true } });
  for (let waited = 0; waited < 2_000 && heartbeats(box).length === 0; waited += 20) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await box.collect();
  }
  stdin.end();
  await server;
  await box.collect();
  assert.ok(heartbeats(box).length >= 1);
  assert.deepEqual([...new Set(heartbeats(box).map((body) => body.phase))], ["waiting"]);
});
