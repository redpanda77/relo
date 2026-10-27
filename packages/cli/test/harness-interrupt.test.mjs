import "./hermetic-env.mjs";
// A user interrupt runs no Stop hook (Claude Code), so the stop is found another way: the flagged tool failure, the API-error
// stop, the idle prompt, and, locally, the interrupt marker Claude Code writes into the transcript (read by the liveness
// sweep for a quiet working session). Observed state only: nothing here touches a card, and no transcript text is kept.
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { adapterFor } from "../src/harness/adapters/index.mjs";
import claudeCode from "../src/harness/adapters/claude-code/index.mjs";
import { claudeInterruptedSince, interruptedInTail } from "../src/harness/adapters/claude-code/session-name.mjs";
import { normalize } from "../src/harness/core/events.mjs";
import { INTERRUPT_QUIET_MS, sweepGoneSessions } from "../src/harness/core/sweep.mjs";
import { reduce } from "../src/harness/core/state-machine.mjs";
import { hookBox } from "./hook-fixture.mjs";

const T0 = 1_800_000_000_000;
const ev = (event, extra = {}) => ({ event, session: "s1", harness: "test", subagent: false, stopActive: false, ...extra });
const play = (steps) => steps.reduce((state, [event, at]) => reduce(state, event, T0 + at), undefined);

test("state machine: idle stops a working session only; stop is idempotent; waiting, stopped and ended are kept", () => {
  assert.equal(play([[ev("prompt"), 0], [ev("idle"), 60_000]]).phase, "stopped");
  assert.equal(play([[ev("prompt"), 0], [ev("tool_start", { toolKey: "t1" }), 1_000], [ev("idle"), 60_000]]).openToolSince, null, "an open tool is cleared");
  assert.equal(play([[ev("prompt"), 0], [ev("wait"), 1_000], [ev("idle"), 60_000]]).phase, "waiting", "never overrides a prompt that waits on the owner");
  assert.equal(play([[ev("prompt"), 0], [ev("stop"), 1_000], [ev("idle"), 60_000]]).phase, "stopped");
  assert.equal(play([[ev("end"), 0], [ev("idle"), 60_000]]).phase, "ended", "an idle never revives an ended session");
  assert.equal(play([[ev("prompt"), 0], [ev("subagent_start", { subagent: true, agentKey: "a1" }), 1_000], [ev("idle"), 60_000]]).phase, "working", "running subagents hold the turn");
  const twice = play([[ev("prompt"), 0], [ev("tool_start", { toolKey: "t1" }), 1_000], [ev("stop"), 2_000], [ev("stop"), 2_100]]);
  assert.equal(twice.phase, "stopped");
  assert.equal(twice.openToolSince, null);
});

test("Claude Code mapping: StopFailure and an interrupted tool are a stop, a failed tool is a tool end, idle_prompt is idle", () => {
  const base = { session_id: "9f2c1c34-5c0e-4d63-8a3a-7f1d3bd2c001", cwd: "/work" };
  const named = (input) => normalize({ adapter: claudeCode, input: { ...base, ...input } }).event;
  assert.equal(named({ hook_event_name: "StopFailure", error: "rate_limit" }), "stop");
  assert.equal(named({ hook_event_name: "PostToolUseFailure", tool_use_id: "t1", is_interrupt: true }), "stop");
  assert.equal(named({ hook_event_name: "PostToolUseFailure", tool_use_id: "t1", is_interrupt: false }), "tool_end");
  assert.equal(named({ hook_event_name: "PostToolUseFailure", tool_use_id: "t1" }), "tool_end");
  assert.equal(named({ hook_event_name: "PostToolUseFailure", tool_use_id: "t1", is_interrupt: true, agent_id: "a1" }), "tool_end", "a subagent's tool never stops the session");
  assert.equal(named({ hook_event_name: "Notification", notification_type: "idle_prompt" }), "idle");
  assert.equal(named({ hook_event_name: "Notification", notification_type: "permission_prompt" }), "wait");
  assert.equal(normalize({ adapter: claudeCode, input: { ...base, hook_event_name: "Notification", notification_type: "auth_success" } }).drop, "not_accepted");
});

test("hooks end to end: an interrupted tool and an idle prompt stop a working session; an idle prompt at a permission prompt does not", async () => {
  const box = await hookBox();
  const phase = () => box.sent.at(-1).phase;
  await box.event("UserPromptSubmit", "prompt");
  await box.event("PreToolUse", "tool-start", { tool_use_id: "t1" });
  assert.equal(phase(), "working");
  await box.event("PostToolUseFailure", "tool-end", { tool_use_id: "t1", is_interrupt: true, error: "interrupted" });
  assert.equal(phase(), "stopped");
  assert.equal(box.sent.at(-1).openToolSince, null);
  await box.event("UserPromptSubmit", "prompt");
  await box.event("StopFailure", "stop", { error: "overloaded" });
  assert.equal(phase(), "stopped");
  await box.event("UserPromptSubmit", "prompt");
  await box.event("Notification", "idle", { notification_type: "idle_prompt" });
  assert.equal(phase(), "stopped");
  await box.event("UserPromptSubmit", "prompt");
  await box.event("Notification", "wait", { notification_type: "permission_prompt" });
  await box.event("Notification", "idle", { notification_type: "idle_prompt" });
  assert.equal(phase(), "waiting");
});

const line = (record) => `${JSON.stringify(record)}\n`;
const marker = (at, text = "[Request interrupted by user]") => line({ type: "user", isSidechain: false, timestamp: new Date(at).toISOString(), message: { role: "user", content: [{ type: "text", text }] } });
const prompt = (at, text = "go on") => line({ type: "user", isSidechain: false, timestamp: new Date(at).toISOString(), message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (at) => line({ type: "assistant", timestamp: new Date(at).toISOString(), message: { role: "assistant", model: "x", content: [{ type: "text", text: "working" }] } });
const toolResult = (at) => line({ type: "user", timestamp: new Date(at).toISOString(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "stopped" }] } });
const tail = (text, partial = false) => ({ text, partial });

test("transcript detection: the newest user entry must be the interrupt marker, written after the session's last activity", () => {
  const since = T0;
  assert.equal(interruptedInTail(tail(assistant(T0 - 5_000) + marker(T0 + 5_000)), since), true);
  assert.equal(interruptedInTail(tail(assistant(T0 - 5_000) + toolResult(T0 + 4_000) + marker(T0 + 5_000, "[Request interrupted by user for tool use]")), since), true, "a tool-use interrupt");
  assert.equal(interruptedInTail(tail(marker(T0 + 5_000) + assistant(T0 + 6_000)), since), true, "assistant text after it (the synthetic reply) is not a prompt");
  assert.equal(interruptedInTail(tail(assistant(T0 - 5_000) + prompt(T0 - 4_000)), since), false, "no marker at all");
  assert.equal(interruptedInTail(tail(marker(T0 - 60_000) + assistant(T0 - 59_000)), since), false, "a marker older than the last activity");
  assert.equal(interruptedInTail(tail(marker(T0 + 1_000) + prompt(T0 + 2_000)), since), false, "a prompt after the marker is a later turn");
  assert.equal(interruptedInTail(tail(line({ type: "user", timestamp: new Date(T0 + 1_000).toISOString(), message: { role: "user", content: [
    { type: "text", text: "[Request interrupted by user]\n" }, { type: "text", text: "Take a step back" }] } })), since), false, "the next prompt riding in the marker's entry");
  assert.equal(interruptedInTail(tail(`${marker(T0 + 1_000).slice(5)}${assistant(T0)}`, true), since), false, "a first line cut by the tail is skipped");
  assert.equal(interruptedInTail(tail(`not json\n${marker(T0 + 1_000)}{"broken`), since), true, "unparseable lines are skipped");
  assert.equal(interruptedInTail(tail(line({ type: "user", isSidechain: true, timestamp: new Date(T0 + 1_000).toISOString(), message: { role: "user", content: "[Request interrupted by user]" } })), since), false, "a subagent's own transcript lines");
});

test("the sweep stops a quiet working session whose transcript ends in the owner's interrupt, and only then", async () => {
  const dir = await mkdtemp(join(tmpdir(), "relo-interrupt-"));
  const transcript = join(dir, "t.jsonl");
  const box = await hookBox();
  const deps = () => ({ env: {}, accountProbes: {}, ...box.deps(), observedStateDirectory: join(box.state, "observed"), outboxDirectory: box.outbox });
  const sweep = () => sweepGoneSessions({ adapterFor, dependencies: deps(), intervalMs: 0 });
  const observed = async () => {
    const directory = join(box.state, "observed");
    const name = (await readdir(directory)).find((file) => file.endsWith(".json") && !file.startsWith("."));
    return JSON.parse(await readFile(join(directory, name), "utf8"));
  };
  await writeFile(transcript, assistant(box.clock));
  await box.event("UserPromptSubmit", "prompt", { transcript_path: transcript });
  await box.event("PreToolUse", "tool-start", { transcript_path: transcript, tool_use_id: "t1" });
  assert.equal((await observed()).transcriptPath, transcript, "kept locally for the sweep");
  assert.equal(JSON.stringify(box.sent).includes("t.jsonl"), false, "never sent");
  const seen = Date.parse((await observed()).lastSeenAt);
  // Quiet for less than the threshold: not even read.
  await writeFile(transcript, assistant(seen) + marker(seen + 1_000));
  box.clock += INTERRUPT_QUIET_MS - 5_000;
  await sweep();
  await box.collect();
  assert.equal((await observed()).phase, "working");
  // Quiet long enough but no marker: still working.
  await writeFile(transcript, assistant(seen) + prompt(seen + 1_000));
  box.clock += 10_000;
  await sweep();
  assert.equal((await observed()).phase, "working");
  // The marker after the last activity: stopped, the open tool cleared, through the outbox.
  await writeFile(transcript, assistant(seen) + marker(seen + 1_000));
  await sweep();
  await box.collect();
  const state = await observed();
  assert.equal(state.phase, "stopped");
  assert.equal(state.openToolSince, null);
  assert.equal(box.sent.at(-1).phase, "stopped");
  assert.equal(box.sent.at(-1).openToolSince, null);
  assert.equal(box.other.length, 0, "no card, work or question was touched");
  // The owner prompts again: a marker older than the new activity never stops the new turn.
  await box.event("UserPromptSubmit", "prompt", { transcript_path: transcript });
  box.clock += INTERRUPT_QUIET_MS + 1_000;
  await sweep();
  assert.equal((await observed()).phase, "working");
});

test("claudeInterruptedSince reads only an absolute .jsonl path and fails closed", () => {
  assert.equal(claudeInterruptedSince("relative.jsonl", T0), false);
  assert.equal(claudeInterruptedSince("/nonexistent/t.jsonl", T0), false);
  assert.equal(claudeInterruptedSince("/etc/hosts", T0), false);
  assert.equal(claudeInterruptedSince(undefined, T0), false);
});
