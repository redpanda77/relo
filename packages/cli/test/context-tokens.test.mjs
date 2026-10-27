// Context size from the hooks (the desktop app never runs a status line): the transcript tail reader, the send gate
// and the status line's "sent" bookkeeping.
import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runStatusline } from "../src/harness/entry.mjs";
import { claudeContextTokens, contextTokensOfTail } from "../src/harness/adapters/claude-code/session-name.mjs";
import { readContext } from "../src/harness/core/bookkeeping.mjs";
import { snapshotDue } from "../src/harness/core/state-machine.mjs";
import { sessionKey } from "../src/shared/session-key.mjs";
import { SESSION_ID, hookBox } from "./hook-fixture.mjs";

const KEY = sessionKey({ harness: "claude-code", id: SESSION_ID });
const assistant = (input, extra = {}, usage = {}) => JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-opus", usage: {
  input_tokens: input, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5, ...usage }, ...extra.message }, ...extra.record });

test("the last main-chain assistant usage is the context: input + cache creation + cache read", () => {
  const text = [assistant(100), assistant(10, {}, { cache_creation_input_tokens: 200, cache_read_input_tokens: 3_000 }),
    JSON.stringify({ type: "user", message: { role: "user", content: "hi" } })].join("\n");
  assert.equal(contextTokensOfTail({ text }), 3_210);
});

test("sidechain lines, a partial first line and garbage are ignored", () => {
  const text = [assistant(999_999), assistant(500), assistant(70_000, { record: { isSidechain: true } }), "{not json", ""].join("\n");
  assert.equal(contextTokensOfTail({ text, partial: false }), 500, "sidechain skipped");
  // the cut first line is dropped even though it would parse
  assert.equal(contextTokensOfTail({ text: assistant(42), partial: true }), undefined);
  assert.equal(contextTokensOfTail({ text: [assistant(42), assistant(7)].join("\n"), partial: true }), 7);
  assert.equal(contextTokensOfTail({ text: "" }), undefined);
});

test("claudeContextTokens reads only the tail of the file and rejects odd paths", async () => {
  const box = await hookBox();
  const path = join(box.state, "t.jsonl");
  const filler = JSON.stringify({ type: "user", message: { content: "x".repeat(1000) } });
  writeFileSync(path, [assistant(1_000_000), ...Array(400).fill(filler), assistant(123_456)].join("\n"));
  assert.equal(claudeContextTokens(path), 123_456);
  assert.equal(claudeContextTokens("relative.jsonl"), undefined);
  assert.equal(claudeContextTokens(join(box.state, "missing.jsonl")), undefined);
  assert.equal(claudeContextTokens(join(box.state, "t.txt")), undefined);
});

test("snapshotDue: first reading always; then a move of 10K tokens or 5%", () => {
  const sent = { lastSentAt: "2026-01-01T00:00:00Z", lastSentPhase: "stopped", phase: "stopped", openToolSince: null, lastSentOpenToolSince: null };
  const now = Date.parse("2026-01-01T00:01:00Z");
  assert.equal(snapshotDue({ ...sent, contextTokens: 5 }, now), true, "no reading sent yet");
  assert.equal(snapshotDue({ ...sent, contextTokens: 209_000, lastSentContextTokens: 200_000 }, now), false, "9K, 4.5%");
  assert.equal(snapshotDue({ ...sent, contextTokens: 210_000, lastSentContextTokens: 200_000 }, now), true, "10K");
  assert.equal(snapshotDue({ ...sent, contextTokens: 3_200, lastSentContextTokens: 3_000 }, now), true, "5% of a small one");
  assert.equal(snapshotDue({ ...sent, contextTokens: 3_100, lastSentContextTokens: 3_000 }, now), false);
});

test("Stop and PostToolUse hooks send contextTokens from the transcript, gated, without erasing the status line's percent", async () => {
  const box = await hookBox();
  const transcript = join(box.state, "session.jsonl");
  writeFileSync(transcript, `${assistant(50_000)}\n`);
  await box.event("SessionStart", "start", { source: "startup", transcript_path: transcript });
  assert.equal(box.sent.at(-1).contextTokens, undefined, "a session start reads nothing");
  await runStatusline({ ...box.deps(), readStdinRaw: async () => Buffer.from(JSON.stringify({ session_id: SESSION_ID, context_window: { used_percentage: 30 }, cost: { total_cost_usd: 2 } })), write: () => {} });
  await box.collect();
  await box.event("PostToolUse", "tool-end", { transcript_path: transcript, tool_use_id: "t1", tool_name: "Read" });
  const first = box.sent.at(-1);
  assert.equal(first.contextTokens, 50_000, "the first reading is always sent");
  assert.equal(first.contextPct, 30, "the status line's percent is kept");
  const count = box.sent.length;
  writeFileSync(transcript, `${assistant(50_000)}\n${assistant(52_000)}\n`);
  box.clock += 25_000; // past the transcript read throttle
  await box.event("PostToolUse", "tool-end", { transcript_path: transcript, tool_use_id: "t2", tool_name: "Read" });
  assert.equal(box.sent.length, count, "2K tokens (4%) is under both steps: nothing sent");
  writeFileSync(transcript, `${assistant(52_000)}\n${assistant(56_000)}\n`);
  box.clock += 25_000;
  await box.event("PostToolUse", "tool-end", { transcript_path: transcript, tool_use_id: "t3", tool_name: "Read" });
  assert.equal(box.sent.length, count + 1, "6K tokens (12%) is over 5%");
  assert.equal(box.sent.at(-1).contextTokens, 56_000);
  writeFileSync(transcript, `${assistant(56_500)}\n`);
  await box.event("Stop", "stop", { transcript_path: transcript });
  assert.equal(box.sent.at(-1).phase, "stopped", "a phase change carries the latest reading");
  assert.deepEqual([box.sent.at(-1).contextTokens, box.sent.at(-1).contextPct, box.sent.at(-1).costUsd], [56_500, 30, 2]);
});

test("the transcript tail is read at most once per throttle window per session", async () => {
  const box = await hookBox();
  const transcript = join(box.state, "session.jsonl");
  writeFileSync(transcript, `${assistant(50_000)}\n`);
  await box.event("SessionStart", "start", { source: "startup", transcript_path: transcript });
  await box.event("PostToolUse", "tool-end", { transcript_path: transcript, tool_use_id: "t1", tool_name: "Read" });
  assert.equal(box.sent.at(-1).contextTokens, 50_000);
  // 4 s later the transcript holds 90K, but the tail was read 4 s ago: the next event does not read it again
  writeFileSync(transcript, `${assistant(90_000)}\n`);
  box.clock += 3_000;
  await box.event("PostToolUse", "tool-end", { transcript_path: transcript, tool_use_id: "t2", tool_name: "Read" });
  const folder = join(box.state, "observed");
  const state = JSON.parse(readFileSync(join(folder, readdirSync(folder).find((name) => name.endsWith(".json") && !name.startsWith("."))), "utf8"));
  assert.equal(state.contextTokens, 50_000, "the throttled event kept the earlier reading");
  assert.equal(Number.isFinite(state.contextReadAt), true);
  box.clock += 25_000;
  await box.event("PostToolUse", "tool-end", { transcript_path: transcript, tool_use_id: "t3", tool_name: "Read" });
  assert.equal(box.sent.at(-1).contextTokens, 90_000, "past the window it reads again");
});

test("the status line marks a reading sent only when it was queued (not when no session or not signed in)", async () => {
  const stdin = Buffer.from(JSON.stringify({ session_id: SESSION_ID, context_window: { used_percentage: 42 }, cost: { total_cost_usd: 1 } }));
  // no hook ever saw the session: not queued, so not sent
  const unseen = await hookBox();
  await runStatusline({ ...unseen.deps(), readStdinRaw: async () => stdin, write: () => {} });
  const first = await readContext(join(unseen.state, "hooks"), KEY);
  assert.equal(first.pct, 42);
  assert.equal(first.sentPct, undefined);
  assert.equal(first.sentCost, undefined);
  // the session starts; the same reading is still due and now goes out
  await unseen.event("UserPromptSubmit", "prompt");
  await runStatusline({ ...unseen.deps(), readStdinRaw: async () => stdin, write: () => {} });
  await unseen.collect();
  assert.equal(unseen.sent.at(-1).contextPct, 42);
  assert.equal((await readContext(join(unseen.state, "hooks"), KEY)).sentPct, 42);
  // not signed in: nothing to queue for
  const offline = await hookBox();
  await offline.event("UserPromptSubmit", "prompt");
  const signedOut = { ...offline.deps(), loadConfig: async () => undefined, env: { ...offline.deps().env, RELO_HARNESS_CREDENTIAL_PATH: join(offline.state, "none") } };
  await runStatusline({ ...signedOut, readStdinRaw: async () => stdin, write: () => {} });
  assert.equal((await readContext(join(offline.state, "hooks"), KEY)).sentPct, undefined);
});
