import "./hermetic-env.mjs";
// EDGE.1: canonical event sequences → the session's observed phase, with and without subagents,
// /clear vs compaction, and out-of-order async hooks.
import assert from "node:assert/strict";
import test from "node:test";
import { HEARTBEAT_MS, REORDER_GRACE_MS, SUBAGENT_RETIRE_MS, markSent, reduce, snapshotDue } from "../src/harness/core/state-machine.mjs";

const T0 = 1_800_000_000_000;
const ev = (event, extra = {}) => ({ event, session: "s1", harness: "test", subagent: false, stopActive: false, ...extra });
const sub = (event, extra = {}) => ev(event, { subagent: true, agentKey: "a1", ...extra });

/** Runs [event, msAfterPrevious?] steps and returns the final state. */
function play(steps, start = undefined) {
  let state = start;
  let now = T0;
  for (const step of steps) {
    const [event, gap = 1_000] = Array.isArray(step) ? step : [step];
    now += gap;
    state = reduce(state, event, now);
  }
  return state;
}

const TABLE = [
  ["a fresh start is open", [ev("start", { source: "startup" })], "open"],
  ["a prompt makes it working", [ev("start"), ev("prompt")], "working"],
  ["a tool before any prompt (hooks added mid-session) is working", [ev("tool_start", { toolKey: "t1" })], "working"],
  ["a permission prompt is waiting", [ev("start"), ev("prompt"), ev("tool_start", { toolKey: "t1" }), ev("wait")], "waiting"],
  ["the approved tool finishing is working again", [ev("prompt"), ev("wait"), ev("tool_end", { toolKey: "t1" })], "working"],
  ["a Stop is the owner's turn", [ev("prompt"), ev("tool_start", { toolKey: "t1" }), ev("tool_end", { toolKey: "t1" }), ev("stop")], "stopped"],
  ["the next prompt is working", [ev("prompt"), ev("stop"), ev("prompt")], "working"],
  ["SessionEnd ends it", [ev("prompt"), ev("stop"), ev("end")], "ended"],
  ["nothing but a start revives an ended session", [ev("end"), ev("prompt"), ev("tool_start", { toolKey: "t9" }), ev("wait"), ev("stop")], "ended"],
  ["resume after the end is open", [ev("end"), ev("start", { source: "resume" })], "open"],
  // Subagents roll up.
  ["subagents keep a working session working", [ev("prompt"), sub("subagent_start"), sub("tool_start", { toolKey: "x" }), sub("tool_end", { toolKey: "x" }), sub("subagent_stop")], "working"],
  ["a subagent event after the parent's Stop never revives working", [ev("prompt"), ev("stop"), sub("tool_start", { toolKey: "x" }), sub("tool_end", { toolKey: "x" }), sub("prompt")], "stopped"],
  ["a subagent event after SessionEnd never revives the session", [ev("prompt"), ev("end"), sub("tool_end", { toolKey: "x" }), sub("subagent_start"), sub("start")], "ended"],
  ["a subagent's start or stop is never the session's", [ev("prompt"), sub("start"), sub("stop"), sub("end")], "working"],
  ["a subagent's permission prompt blocks the session", [ev("prompt"), sub("wait")], "waiting"],
  ["its approved tool resumes it", [ev("prompt"), sub("wait"), sub("tool_end", { toolKey: "x" })], "working"],
  // /clear vs compaction.
  ["compaction keeps the phase", [ev("prompt"), ev("compact"), ev("start", { source: "compact" })], "working"],
  ["/clear starts fresh", [ev("prompt"), ev("tool_start", { toolKey: "t1" }), ev("start", { source: "clear" })], "open"],
];

for (const [name, steps, phase] of TABLE) {
  test(`phase: ${name}`, () => {
    assert.equal(play(steps).phase, phase);
  });
}

test("subagents are counted, never given a phase; the count clears at the end and on /clear", () => {
  const running = play([ev("prompt"), sub("subagent_start", { agentKey: "a1" }), sub("subagent_start", { agentKey: "a2" }), sub("subagent_stop", { agentKey: "a1" })]);
  assert.deepEqual(Object.keys(running.subagents), ["a2"]);
  assert.equal(running.phase, "working");
  assert.deepEqual(play([ev("start", { source: "clear" })], running).subagents, {});
  assert.deepEqual(play([ev("end")], running).subagents, {});
  assert.deepEqual(Object.keys(play([ev("start", { source: "compact" })], running).subagents), ["a2"], "compaction keeps them");
});

test("background subagents: the parent's Stop is not the owner's turn until the last subagent stops", () => {
  const launched = play([ev("prompt"), sub("subagent_start", { agentKey: "a1" }), sub("subagent_start", { agentKey: "a2" }), ev("stop")]);
  assert.equal(launched.phase, "working", "a Stop with subagents running stays working");
  const busy = play([sub("tool_start", { agentKey: "a1", toolKey: "x" }), sub("subagent_stop", { agentKey: "a1" })], launched);
  assert.equal(busy.phase, "working", "one still runs");
  const done = play([sub("subagent_stop", { agentKey: "a2" })], busy);
  assert.equal(done.phase, "stopped", "the last one stopping is the owner's turn");
  assert.equal(done.openToolSince, null);
  // The harness wakes the parent with a result: its own tools and Stop decide again.
  const woken = play([[ev("tool_start", { toolKey: "m" }), REORDER_GRACE_MS + 1], ev("tool_end", { toolKey: "m" }), ev("stop")], done);
  assert.equal(woken.phase, "stopped");
});

test("background subagents: the parent woken while others still run keeps working through its next Stop", () => {
  const s = play([ev("prompt"), sub("subagent_start", { agentKey: "a1" }), sub("subagent_start", { agentKey: "a2" }), ev("stop"),
    sub("subagent_stop", { agentKey: "a1" }), [ev("tool_start", { toolKey: "m" }), REORDER_GRACE_MS + 1], ev("tool_end", { toolKey: "m" }), ev("stop")]);
  assert.equal(s.phase, "working");
  assert.equal(play([sub("subagent_stop", { agentKey: "a2" })], s).phase, "stopped");
});

test("background subagents count as an open tool, so a quiet one keeps the session live on the server", () => {
  const s = play([ev("prompt"), sub("subagent_start", { agentKey: "a1" }), ev("stop")]);
  assert.equal(s.openToolSince, new Date(T0 + 2_000).toISOString());
});

test("background subagents: a late SubagentStart after the Stop keeps it working; a stop before its start cancels it", () => {
  const late = play([ev("prompt"), ev("stop"), sub("subagent_start", { agentKey: "a1" })]);
  assert.equal(late.phase, "working");
  assert.equal(play([sub("subagent_stop", { agentKey: "a1" })], late).phase, "stopped");
  const swapped = play([ev("prompt"), sub("subagent_stop", { agentKey: "a1" }), sub("subagent_start", { agentKey: "a1" }), ev("stop")]);
  assert.equal(swapped.phase, "stopped");
  assert.deepEqual(swapped.subagents, {});
});

test("background subagents: one silent past SUBAGENT_RETIRE_MS (a lost SubagentStop) no longer holds the session", () => {
  const s = play([ev("prompt"), sub("subagent_start", { agentKey: "a1" }), ev("stop")]);
  const kept = reduce(s, sub("tool_end", { agentKey: "a1", toolKey: "q" }), T0 + SUBAGENT_RETIRE_MS);
  assert.equal(kept.phase, "working", "activity refreshes it");
  const lost = reduce(kept, ev("compact"), T0 + 2 * SUBAGENT_RETIRE_MS + 1);
  assert.equal(lost.phase, "stopped");
  assert.deepEqual(lost.subagents, {});
});

test("background jobs: a backgrounded tool holds the turn's Stop as working; the next turn's Stop ends it", () => {
  const bg = ev("tool_end", { toolKey: "b1", background: true });
  const held = play([ev("prompt"), ev("tool_start", { toolKey: "b1" }), bg, ev("stop")]);
  assert.equal(held.phase, "working", "the deploy still runs: not the owner's turn");
  assert.equal(held.openToolSince, held.backgroundJobs.b1.since, "it counts as an open tool");
  // It finishes and wakes the agent: that turn's Stop is the owner's turn.
  assert.equal(play([[ev("tool_start", { toolKey: "t2" }), 60_000], ev("tool_end", { toolKey: "t2" }), ev("stop")], held).phase, "stopped");
  assert.equal(play([[ev("stop"), 60_000]], held).phase, "stopped", "a woken turn without tools too");
  assert.equal(play([ev("prompt"), ev("tool_end", { toolKey: "t1" }), ev("stop")]).phase, "stopped", "a plain tool is not a job");
});

test("background jobs: a late PostToolUse after the Stop keeps it working; one past SUBAGENT_RETIRE_MS is dropped; /clear clears", () => {
  const late = play([ev("prompt"), ev("stop"), [ev("tool_end", { toolKey: "b1", background: true }), 500]]);
  assert.equal(late.phase, "working");
  assert.equal(play([[ev("stop"), 60_000]], late).phase, "stopped", "the woken turn's Stop ends it");
  const held = play([ev("prompt"), ev("tool_end", { toolKey: "b1", background: true }), ev("stop")]);
  const retired = play([[ev("tool_end", { toolKey: "x" }), SUBAGENT_RETIRE_MS + 10_000]], held);
  assert.deepEqual(retired.backgroundJobs, {});
  assert.equal(retired.phase, "stopped");
  assert.deepEqual(play([ev("start", { source: "clear" })], held).backgroundJobs, {});
});

test("a subagent event after the parent's Stop only extends lastSeenAt", () => {
  const stopped = play([ev("prompt"), ev("stop")]);
  const later = reduce(stopped, sub("tool_end", { toolKey: "x" }), T0 + 60_000);
  assert.equal(later.phase, "stopped");
  assert.equal(later.phaseSince, stopped.phaseSince);
  assert.equal(later.lastSeenAt, new Date(T0 + 60_000).toISOString());
  assert.equal(snapshotDue(markSent(stopped, T0 + 3_000), T0 + 60_000), false, "nothing to send");
});

test("openToolSince: tool_start opens, tool_end closes, the earliest open tool wins; Stop and End clear", () => {
  let s = play([ev("prompt"), [ev("tool_start", { toolKey: "a" }), 1_000], [ev("tool_start", { toolKey: "b" }), 1_000]]);
  const first = new Date(T0 + 2_000).toISOString();
  assert.equal(s.openToolSince, first);
  s = reduce(s, ev("tool_end", { toolKey: "a" }), T0 + 4_000);
  assert.equal(s.openToolSince, new Date(T0 + 3_000).toISOString());
  s = reduce(s, ev("tool_end", { toolKey: "b" }), T0 + 5_000);
  assert.equal(s.openToolSince, null);
  s = reduce(s, ev("tool_start", { toolKey: "c" }), T0 + 6_000);
  assert.equal(reduce(s, ev("stop"), T0 + 7_000).openToolSince, null);
  assert.equal(reduce(s, ev("end"), T0 + 7_000).openToolSince, null);
});

test("out of order: a tool_end processed before its tool_start cancels it", () => {
  const s = play([ev("prompt"), ev("tool_end", { toolKey: "a" }), ev("tool_start", { toolKey: "a" })]);
  assert.equal(s.openToolSince, null);
});

test("out of order: a main tool_start landing just after the Stop stays stopped; a later one is a new turn", () => {
  const stopped = play([ev("prompt"), ev("stop")]);
  const late = reduce(stopped, ev("tool_start", { toolKey: "z" }), Date.parse(stopped.phaseSince) + REORDER_GRACE_MS - 1);
  assert.equal(late.phase, "stopped");
  assert.equal(late.openToolSince, null);
  const next = reduce(stopped, ev("tool_start", { toolKey: "y" }), Date.parse(stopped.phaseSince) + REORDER_GRACE_MS + 1);
  assert.equal(next.phase, "working");
  assert.equal(reduce(stopped, ev("tool_end", { toolKey: "z" }), Date.parse(stopped.phaseSince) + REORDER_GRACE_MS - 1).phase, "stopped", "a tool_end just after the Stop is its tail");
  assert.equal(reduce(stopped, ev("tool_end", { toolKey: "z" }), Date.parse(stopped.phaseSince) + 60_000).phase, "working",
    "a tool_end well after the Stop is a woken turn (Read or Edit send no tool_start)");
});

test("background subagents: the last one ending wakes the parent, so the session stays working until that turn's Stop", () => {
  const launched = play([ev("prompt"), sub("subagent_start", { agentKey: "a1" }), ev("stop")]);
  const ended = play([[sub("subagent_stop", { agentKey: "a1" }), 120_000]], launched);
  assert.equal(ended.phase, "working", "never a flash of the owner's turn while the agent reads the result");
  assert.notEqual(ended.openToolSince, null, "held like a background job");
  const woken = play([[ev("tool_end", { toolKey: "r" }), 2_000], ev("stop")], ended);
  assert.equal(woken.phase, "stopped", "the woken turn's Stop is the owner's turn");
  assert.deepEqual(woken.backgroundJobs, {});
  const lost = reduce(ended, ev("compact"), Date.parse(ended.lastSeenAt) + SUBAGENT_RETIRE_MS + 1);
  assert.equal(lost.phase, "stopped", "a wake that never comes is dropped after SUBAGENT_RETIRE_MS");
});

test("background subagents: one ending just after the Stop (a late foreground hook) holds nothing", () => {
  const launched = play([ev("prompt"), sub("subagent_start", { agentKey: "a1" }), ev("stop")]);
  assert.equal(play([[sub("subagent_stop", { agentKey: "a1" }), 500]], launched).phase, "stopped");
});

test("tools without an id (some harnesses) still open and close", () => {
  let s = play([ev("prompt"), ev("tool_start"), ev("tool_end")]);
  assert.equal(s.openToolSince, null);
  s = reduce(s, ev("tool_start"), T0 + 10_000);
  assert.notEqual(s.openToolSince, null, "an anonymous tool can open again after closing");
});

test("snapshots: first, on a phase change, on an open-tool change and as a heartbeat only while working", () => {
  let s = reduce(undefined, ev("start"), T0);
  assert.equal(snapshotDue(s, T0), true, "the first");
  s = markSent(s, T0);
  assert.equal(s.seq, 1);
  assert.equal(snapshotDue(reduce(s, ev("compact"), T0 + 1), T0 + 1), false, "no change, nothing to send");
  s = reduce(s, ev("prompt"), T0 + 2);
  assert.equal(snapshotDue(s, T0 + 2), true, "phase change");
  s = markSent(s, T0 + 2);
  s = reduce(s, ev("tool_start", { toolKey: "a" }), T0 + 3);
  assert.equal(snapshotDue(s, T0 + 3), true, "open tool changed");
  s = markSent(s, T0 + 3);
  s = reduce(s, sub("tool_end", { toolKey: "q" }), T0 + 4);
  assert.equal(snapshotDue(s, T0 + 4), false, "activity alone is not a transition");
  assert.equal(snapshotDue(s, T0 + 3 + HEARTBEAT_MS), true, "heartbeat while working");
  s = markSent(reduce(s, ev("stop"), T0 + 10), T0 + 10);
  assert.equal(s.seq, 4);
  assert.equal(snapshotDue(s, T0 + 10 + 10 * HEARTBEAT_MS), false, "no heartbeat once stopped");
});

test("seq stays monotonic across /clear and resume", () => {
  let s = markSent(reduce(undefined, ev("prompt"), T0), T0);
  s = markSent(reduce(s, ev("start", { source: "clear" }), T0 + 1), T0 + 1);
  s = markSent(reduce(s, ev("end"), T0 + 2), T0 + 2);
  s = markSent(reduce(s, ev("start", { source: "resume" }), T0 + 3), T0 + 3);
  assert.equal(s.seq, 4);
});

test("reduce never mutates its input", () => {
  const before = play([ev("prompt"), ev("tool_start", { toolKey: "a" })]);
  const copy = structuredClone(before);
  reduce(before, ev("stop"), T0 + 99_000);
  assert.deepEqual(before, copy);
});

test("an end records how it ended: the sweep's synthetic end is gone, any other end is the hook", () => {
  assert.equal(play([ev("prompt"), ev("end", { reason: "gone" })]).endReason, "gone");
  assert.equal(play([ev("prompt"), ev("end", { reason: "exit" })]).endReason, "hook");
  assert.equal(play([ev("prompt"), ev("end")]).endReason, "hook");
});
