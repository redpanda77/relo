import "./hermetic-env.mjs";
// `relo hook` (EDGE.1, EDGE.2, EDGE.6): native events → local phase → a snapshot queued only on a
// transition → sent in the background with the harness credential. Never prints, never fails.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SECRET_PROMPT, SESSION_ID, cli, hookBox } from "./hook-fixture.mjs";

const KEY = createHash("sha256").update(`claude-code:${SESSION_ID}`).digest("base64url");

test("relo hook queues only the session facts: hashed id, phase and its times, project, computer and account", async () => {
  const box = await hookBox();
  const out = await box.run(["hook", "start"]);
  assert.equal(out.exitCode, 0);
  assert.deepEqual(out.stdout, [], "a hook prints nothing: Claude Code injects stdout into the model's context");
  assert.deepEqual(out.stderr, []);
  assert.equal(box.sent.length, 1);
  const [body] = box.sent;
  const at = new Date(box.clock).toISOString();
  assert.deepEqual(body, { session: KEY, harness: "claude-code", phase: "open", phaseSince: at, lastSeenAt: at, openToolSince: null, seq: 1,
    project: box.repo.split("/").at(-1), computer: "Studio Mac" });
  assert.equal(box.entries[0].route, "/api/agent-sessions/observed");
  assert.equal(box.entries[0].credential, "harness");
  assert.equal(box.spawned, 1, "a background flusher was started");
  assert.deepEqual(box.requests, [], "the hook itself never touches the network");
  const text = JSON.stringify(box.entries);
  for (const forbidden of [SECRET_PROMPT, "hunter2", "id_rsa", "transcript", SESSION_ID, "Bash", "secret"]) {
    assert.equal(text.includes(forbidden), false, `${forbidden} must never be queued`);
  }
});

test("only transitions are queued: a turn is open → working → waiting → working → stopped → ended", async () => {
  const box = await hookBox();
  await box.event("SessionStart", "start", { source: "startup" });
  await box.event("UserPromptSubmit", "prompt", { prompt: SECRET_PROMPT });
  await box.event("PostToolUse", "tool-end", { tool_use_id: "toolu_1", tool_name: "Read" });
  await box.event("PostToolUse", "tool-end", { tool_use_id: "toolu_2", tool_name: "Grep" });
  await box.event("Notification", "wait", { notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" });
  await box.event("PostToolUse", "tool-end", { tool_use_id: "toolu_3" });
  await box.event("Stop", "stop");
  await box.event("Stop", "stop");
  await box.event("SessionEnd", "end", { reason: "exit" });
  assert.deepEqual(box.sent.map((body) => body.phase), ["open", "working", "waiting", "working", "stopped", "ended"]);
  assert.deepEqual(box.sent.map((body) => body.seq), [1, 2, 3, 4, 5, 6]);
  assert.equal(JSON.stringify(box.sent).includes("permission"), false, "the notification text is never sent");
});

test("a long tool sends its start time; a heartbeat goes at most every 5 minutes while working", async () => {
  const box = await hookBox();
  await box.event("UserPromptSubmit", "prompt");
  await box.event("PreToolUse", "tool-start", { tool_use_id: "toolu_long", tool_name: "Bash", tool_input: { command: "npm test" } });
  const started = new Date(box.clock).toISOString();
  assert.equal(box.sent.at(-1).openToolSince, started);
  box.clock += 60_000;
  await box.event("PostToolUse", "tool-end", { tool_use_id: "toolu_other" });
  assert.equal(box.sent.length, 2, "activity alone is not sent");
  box.clock += 5 * 60_000;
  await box.event("PostToolUse", "tool-end", { tool_use_id: "toolu_other2" });
  assert.equal(box.sent.length, 3, "heartbeat");
  assert.equal(box.sent.at(-1).phase, "working");
  await box.event("PostToolUse", "tool-end", { tool_use_id: "toolu_long" });
  assert.equal(box.sent.at(-1).openToolSince, null, "the tool finished");
  assert.equal(JSON.stringify(box.sent).includes("npm test"), false);
});

test("the observed lane keeps the latest snapshot per session while offline", async () => {
  const box = await hookBox();
  for (const [name, command] of [["SessionStart", "start"], ["UserPromptSubmit", "prompt"], ["Stop", "stop"]]) await box.event(name, command);
  const { pending } = await import("../src/outbox/index.mjs");
  assert.equal((await pending({ directory: box.outbox })).observed, 1);
});

test("Notification is a wait only for a prompt that blocks on the owner", async () => {
  const box = await hookBox();
  await box.event("UserPromptSubmit", "prompt");
  for (const type of ["idle_prompt", "auth_success", undefined]) await box.event("Notification", "wait", { notification_type: type });
  assert.deepEqual(box.sent.map((body) => body.phase), ["working"]);
  for (const type of ["permission_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"]) {
    await box.event("PostToolUse", "tool-end", { tool_use_id: `t-${type}` });
    await box.event("Notification", "wait", { notification_type: type });
    assert.equal(box.sent.at(-1).phase, "waiting", type);
  }
});

test("subagents roll up: their events never give them a session or a phase; after the parent's Stop they change nothing", async () => {
  const box = await hookBox();
  await box.event("UserPromptSubmit", "prompt");
  await box.event("SubagentStart", "subagent-start", { agent_id: "agent-1", agent_type: "Explore" });
  await box.event("PreToolUse", "tool-start", { agent_id: "agent-1", tool_use_id: "s1", tool_name: "Bash" });
  await box.event("SessionStart", "start", { agent_id: "agent-1" });
  await box.event("Stop", "stop", { agent_id: "agent-1" });
  await box.event("SubagentStop", "subagent-stop", { agent_id: "agent-1" });
  assert.deepEqual(box.sent.map((body) => body.phase), ["working"], "the session stayed working; nothing else was sent");
  assert.ok(box.sent.every((body) => body.session === KEY), "always the parent's session");
  await box.event("Stop", "stop");
  box.clock += 60_000;
  await box.event("PostToolUse", "tool-end", { agent_id: "agent-2", tool_use_id: "late" });
  await box.event("SubagentStart", "subagent-start", { agent_id: "agent-2" });
  assert.deepEqual(box.sent.map((body) => body.phase), ["working", "stopped"], "a background subagent never revives the session");
  await box.event("SessionEnd", "end");
  await box.event("PostToolUse", "tool-end", { agent_id: "agent-2", tool_use_id: "later" });
  assert.deepEqual(box.sent.map((body) => body.phase), ["working", "stopped", "ended"]);
  await box.event("SessionStart", "start", { source: "resume" });
  await box.event("UserPromptSubmit", "prompt");
  assert.deepEqual(box.sent.map((body) => body.phase), ["working", "stopped", "ended", "open", "working"], "a resume starts over");
  const state = JSON.parse(await readFile(join(box.state, "observed", `${KEY.slice(0, 32)}.json`), "utf8"));
  assert.equal(JSON.stringify(state).includes("agent-2"), false, "even locally subagent ids are kept only as opaque keys");
});

test("/clear starts fresh, compaction keeps the phase", async () => {
  const box = await hookBox();
  await box.event("UserPromptSubmit", "prompt");
  await box.event("PreCompact", "compact", { trigger: "auto", custom_instructions: SECRET_PROMPT });
  await box.event("SessionStart", "start", { source: "compact" });
  assert.deepEqual(box.sent.map((body) => body.phase), ["working"]);
  await box.event("SessionStart", "start", { source: "clear" });
  assert.deepEqual(box.sent.map((body) => body.phase), ["working", "open"]);
  assert.equal(JSON.stringify(box.sent).includes("hunter2"), false);
});

test("the observed state file is the hook's own: 0600, separate from the declared session file", async () => {
  const box = await hookBox();
  await box.event("UserPromptSubmit", "prompt");
  const path = join(box.state, "observed", `${KEY.slice(0, 32)}.json`);
  const info = await stat(path);
  assert.equal(info.mode & 0o777, 0o600);
  const state = JSON.parse(await readFile(path, "utf8"));
  for (const key of ["phase", "phaseSince", "lastSeenAt", "openToolSince", "subagents", "seq", "lastSentSeq", "lastSentAt"]) assert.ok(key in state, key);
  assert.equal(existsSync(join(box.state, ".local", "state", "relo", "sessions")), false, "the declared session file is never written by hooks");
});

test("the flusher mints the harness credential once, sends with it, and seals nothing it cannot", async () => {
  const box = await hookBox();
  await box.event("SessionStart", "start", { source: "startup" });
  await box.event("UserPromptSubmit", "prompt");
  const out = await box.flush();
  assert.equal(out.exitCode, 0);
  assert.deepEqual(out.line.data, { sent: 1, dead: 0, pending: 0 });
  assert.deepEqual(box.minted, [{ token: "x".repeat(44), body: { name: "Studio Mac" } }], "minted with the CLI credential");
  assert.equal(box.requests.length, 1, "only the latest snapshot goes out");
  const [request] = box.requests;
  assert.equal(request.method, "POST");
  assert.equal(request.route, "/api/agent-sessions/observed");
  assert.equal(request.token, "h".repeat(44), "the harness credential, never the CLI one");
  assert.equal(request.body.phase, "working");
  assert.match(request.idempotencyKey, /^obs-/u);
  const stored = JSON.parse(await readFile(join(box.state, "harness-credential"), "utf8"));
  assert.deepEqual(stored, { apiUrl: "https://relo.example", id: "hcr_1", token: "h".repeat(44) });
  assert.equal((await stat(join(box.state, "harness-credential"))).mode & 0o777, 0o600);
  await box.event("Stop", "stop");
  await box.flush();
  assert.equal(box.minted.length, 1, "minted once");
  assert.deepEqual(box.requests.map((r) => r.body.phase), ["working", "stopped"]);
  assert.deepEqual(box.other, []);
});

test("offline: snapshots wait in the outbox; a refused one is dropped with a reason; a revoked credential is replaced", async () => {
  let mode = "offline";
  const box = await hookBox({ respond: () => {
    if (mode === "offline") throw new TypeError("fetch failed");
    if (mode === "revoked") { mode = "ok"; throw Object.assign(new Error("unauthorized"), { status: 401 }); }
    if (mode === "refused") throw Object.assign(new Error("invalid"), { status: 422 });
    return { ok: true };
  } });
  await box.event("UserPromptSubmit", "prompt");
  assert.deepEqual((await box.flush()).line.data, { sent: 0, dead: 0, pending: 1 });
  mode = "revoked";
  assert.deepEqual((await box.flush()).line.data, { sent: 0, dead: 0, pending: 1 }, "kept after a 401");
  assert.equal(existsSync(join(box.state, "harness-credential")), false, "the revoked credential is forgotten");
  assert.deepEqual((await box.flush()).line.data, { sent: 1, dead: 0, pending: 0 });
  assert.equal(box.minted.length, 2, "and a fresh one minted");
  mode = "refused";
  await box.event("Stop", "stop");
  assert.deepEqual((await box.flush()).line.data, { sent: 0, dead: 1, pending: 0 });
  const status = await cli(["outbox", "status"], box.deps());
  assert.equal(status.line.data.dead[0].status, 422);
  assert.equal(status.line.data.harnessCredential, "present");
});

test("not signed in: the hook still keeps local state, and queues nothing (no server to queue it for)", async () => {
  const box = await hookBox();
  const noLogin = { loadConfig: async () => { throw new Error("no config"); } };
  const out = await box.run(["hook", "prompt"], noLogin);
  assert.equal(out.exitCode, 0);
  assert.deepEqual(out.stdout, []);
  assert.equal(box.sent.length, 0);
  assert.ok((await readdir(join(box.state, "observed"))).length > 0, "the session's observed state is kept locally");
  assert.deepEqual((await box.flush(noLogin)).line.data, { sent: 0, dead: 0, pending: 0 });
});

test("signed in with only the harness credential: snapshots are queued for its server", async () => {
  const box = await hookBox();
  await writeFile(join(box.state, "harness-credential"), JSON.stringify({ apiUrl: "https://relo.example/", id: "hcr_1", token: "h".repeat(44) }));
  await box.run(["hook", "prompt"], { loadConfig: async () => { throw new Error("no config"); } });
  assert.equal(box.entries.length, 1);
  assert.equal(box.entries[0].server, "https://relo.example");
});

test("snapshots name the server they were queued for; a flush logged in elsewhere never sends them", async () => {
  const box = await hookBox();
  await box.run(["hook", "prompt"]);
  assert.equal(box.entries[0].server, "https://relo.example");
  const elsewhere = { loadConfig: async () => ({ apiUrl: "https://relo-other.example", token: "x".repeat(44) }) };
  assert.deepEqual((await box.flush(elsewhere)).line.data, { sent: 0, dead: 1, pending: 0 });
  assert.equal(box.requests.length, 0, "nothing reached any server");
  assert.equal(box.minted.length, 0);
});

test("a hook never fails and never prints, whatever goes wrong", async () => {
  const cases = {
    "no stdin session": await hookBox({ input: {} }),
    "unknown harness": await hookBox(),
    "garbage event": await hookBox({ input: { session_id: SESSION_ID } }),
    "unwritable state": await hookBox(),
  };
  const argv = { "unknown harness": ["hook", "start", "--agent", "nope"], "garbage event": ["hook", "explode"] };
  const extra = { "unwritable state": { hookStateDirectory: "/nonexistent/relo/hooks", observedStateDirectory: "/nonexistent/relo/observed" } };
  for (const [name, box] of Object.entries(cases)) {
    const out = await box.run(argv[name] ?? ["hook", "start"], extra[name]);
    assert.equal(out.exitCode, 0, name);
    assert.deepEqual(out.stdout, [], name);
    assert.deepEqual(out.stderr, [], name);
    assert.equal(box.sent.length, 0, name);
  }
  const broken = await hookBox();
  assert.equal((await broken.run(["hook", "start"], { readStdinJson: async () => { throw new Error("stdin is not JSON"); } })).exitCode, 0);
  assert.equal((await broken.run(["hook", "start", "--stdin", "--bogus"])).exitCode, 0, "even a bad flag exits 0");
});

test("RELO_DEBUG=1 logs a failure to a file in the state folder, never to stdout", async () => {
  const quiet = await hookBox();
  await quiet.run(["hook", "start"], { outboxDirectory: "/nonexistent/relo/outbox" });
  assert.equal(existsSync(join(quiet.state, "hooks", "hook-debug.log")), false);
  const loud = await hookBox({ env: { RELO_DEBUG: "1" } });
  const out = await loud.run(["hook", "start"], { outboxDirectory: "/nonexistent/relo/outbox" });
  assert.deepEqual(out.stdout, []);
  const log = await readFile(join(loud.state, "hooks", "hook-debug.log"), "utf8");
  assert.match(log, /hook enqueue failed/u);
  assert.equal(log.includes(SECRET_PROMPT), false);
});

test("the computer name is cached in the config after the first hook, and RELO_COMPUTER wins", async () => {
  const first = await hookBox();
  await first.run(["hook", "start"]);
  assert.equal(first.stored.length, 1);
  assert.equal(first.stored[0].computerName, "Studio Mac");
  const cached = await hookBox({ config: { computerName: "Cached Name" } });
  await cached.run(["hook", "start"], { computerName: () => { throw new Error("scutil must not run"); } });
  assert.equal(cached.sent[0].computer, "Cached Name");
  assert.equal(cached.stored.length, 0);
  const env = await hookBox({ env: { RELO_COMPUTER: "From Env" }, config: { computerName: "Cached Name" } });
  await env.run(["hook", "start"]);
  assert.equal(env.sent[0].computer, "From Env");
});

test("Claude hooks resolve the account like the card does (custom config folder name)", async () => {
  const box = await hookBox({ env: { CLAUDE_CONFIG_DIR: "/Users/x/.claude-work" } });
  await box.run(["hook", "start"], { home: "/Users/x" });
  assert.equal(box.sent[0].account, "work");
});

test("Gemini CLI hooks map its event names to the same phases under their own session key", async () => {
  const box = await hookBox();
  const id = "gem-session-0123456789";
  const steps = [["SessionStart", "open"], ["BeforeAgent", "working"], ["Notification", "waiting", { notification_type: "ToolPermission" }],
    ["AfterTool", "working"], ["AfterAgent", "stopped"], ["SessionEnd", "ended"]];
  for (const [name, phase, extra = {}] of steps) {
    box.stdin = { session_id: id, hook_event_name: name, cwd: tmpdir(), ...extra };
    box.clock += 1_000;
    await box.run(["hook", "--agent", "gemini"]);
    assert.equal(box.sent.at(-1).phase, phase, name);
  }
  assert.ok(box.sent.every((body) => body.harness === "gemini"));
  assert.equal(box.sent[0].session, createHash("sha256").update(`gemini:${id}`).digest("base64url"));
});

test("a sending hook never awaits a flusher another process already runs", async () => {
  const box = await hookBox();
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(box.outbox, { recursive: true });
  await writeFile(join(box.outbox, "flush.lock"), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token: "t" }));
  await box.run(["hook", "prompt"]);
  assert.equal(box.sent.length, 1);
  assert.equal(box.spawned, 0, "the running flusher will pick it up");
});
