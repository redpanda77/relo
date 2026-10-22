import "./hermetic-env.mjs";
// OpenCode (no command hooks): relo setup writes relo-hooks.json and Relo's plugin, which turns OpenCode's events
// into those `relo hook … --agent opencode` commands with ids only; a subagent's child session rolls up into its
// root session; the agent's shell is identified by OPENCODE_SESSION_ID, the same id the plugin sees.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { detectCaller } from "../src/caller.mjs";
import { sessionKey } from "../src/shared/session-key.mjs";
import { run } from "../src/cli.mjs";
import { cardDependencies, fakeHome } from "./fake-cards.mjs";
import { SECRET_PROMPT, hookBox } from "./hook-fixture.mjs";

const PLUGIN = fileURLToPath(new URL("../src/harness/adapters/opencode/plugin.js", import.meta.url));
const ROOT = "ses_root1";
const CHILD = "ses_child1";

async function cli(argv, dependencies) {
  const stdout = [];
  const exitCode = await run(argv, { stdout: (line) => stdout.push(line), stderr: () => {}, stdoutIsTTY: false }, dependencies);
  return { exitCode, line: stdout[0] ? JSON.parse(stdout[0]) : undefined };
}

const hooksRow = (line) => [...line.changed, ...(line.skipped ?? []), ...(line.errors ?? [])].find((row) => row.kind === "hooks" && row.harness === "opencode") ?? { action: "unchanged" };

test("setup --level guide writes relo-hooks.json and the plugin; again is unchanged; track removes both; no project hooks", async () => {
  const home = await fakeHome({ agents: [] });
  const cwd = await mkdtemp(join(tmpdir(), "relo-opencode-cwd-"));
  await mkdir(join(cwd, ".git"));
  const deps = { ...cardDependencies({}), home, cwd, env: {}, nodePath: "/opt/node/bin/node", entrypoint: "/opt/relo/bin/relo.mjs" };
  const settings = join(home, ".config", "opencode", "relo-hooks.json");
  // The plugin runs this CLI by absolute path: OpenCode's background service has its own PATH.
  const stamped = async () => (await readFile(PLUGIN, "utf8"))
    .replace("const LAUNCH = null;", 'const LAUNCH = {"node":"/opt/node/bin/node","script":"/opt/relo/bin/relo.mjs"};');
  const plugin = join(home, ".config", "opencode", "plugins", "relo.js");
  const out = await cli(["setup", "--agent", "opencode", "--level", "guide"], deps);
  assert.deepEqual(hooksRow(out.line), { kind: "hooks", harness: "opencode", file: "~/.config/opencode/relo-hooks.json", action: "created", level: "presence" });
  const written = JSON.parse(await readFile(settings, "utf8"));
  // The turn's stop, then the continuity role that notes a stale card for the next turn.
  assert.deepEqual(written.hooks["session.idle"], [{ hooks: [{ type: "command", command: "relo hook stop --agent opencode", timeout: 5 },
    { type: "command", command: "relo hook remind --agent opencode", timeout: 5 }] }]);
  assert.equal(written.hooks["permission.request"], undefined, "approvals only with --approvals on");
  assert.equal(await readFile(plugin, "utf8"), await stamped());
  assert.equal(hooksRow((await cli(["setup", "--agent", "opencode", "--level", "guide"], deps)).line).action, "unchanged");
  await writeFile(plugin, "// an older plugin\n");
  assert.equal(hooksRow((await cli(["setup", "--refresh"], deps)).line).action, "updated", "refresh rewrites an older plugin");
  assert.equal(await readFile(plugin, "utf8"), await stamped());
  assert.match(hooksRow((await cli(["setup", "--project", "--agent", "opencode", "--level", "guide"], deps)).line).reason, /no personal project settings file/u);
  await cli(["setup", "--agent", "opencode", "--level", "track"], deps);
  assert.equal(existsSync(settings), false);
  assert.equal(existsSync(plugin), false);
});

test("the agent's shell is an OpenCode session with the plugin's id", () => {
  const caller = detectCaller({ OPENCODE: "1", OPENCODE_SESSION_ID: ROOT });
  assert.deepEqual(caller, { type: "agent_session", harness: "opencode", sessionId: ROOT, sessionKey: sessionKey({ harness: "opencode", id: ROOT }) });
});

test("OpenCode events reduce to phases; a child session's events are its root's activity", async () => {
  const box = await hookBox();
  const event = (name, command, extra = {}) => {
    box.stdin = { hook_event_name: name, session_id: ROOT, cwd: box.repo, ...extra };
    box.clock += 1_000;
    return box.run(["hook", command, "--agent", "opencode"]);
  };
  await event("session.created", "start", { source: "startup" });
  await event("chat.message", "prompt");
  await event("tool.execute.before", "tool-start", { tool_id: "call_task" });
  await event("subagent.created", "subagent-start", { agent_id: CHILD });
  await event("permission.asked", "wait", { agent_id: CHILD });
  await event("tool.execute.after", "tool-end", { agent_id: CHILD, tool_id: "call_child" });
  await event("subagent.idle", "subagent-stop", { agent_id: CHILD });
  await event("tool.execute.after", "tool-end", { tool_id: "call_task" });
  await event("session.idle", "stop");
  const phases = box.sent.map((body) => body.phase).filter((phase, index, all) => phase !== all[index - 1]);
  assert.deepEqual(phases, ["open", "working", "waiting", "working", "stopped"]);
  assert.ok(box.sent.every((body) => body.harness === "opencode" && body.session === sessionKey({ harness: "opencode", id: ROOT })));
});

/** The plugin as OpenCode loads it, from a config folder holding relo-hooks.json, with a fake relo on PATH. */
async function loadPlugin({ parents = {}, level = "presence", script = "" } = {}) {
  const config = await mkdtemp(join(tmpdir(), "relo-opencode-config-"));
  const bin = join(config, "bin");
  const log = join(config, "calls.jsonl");
  await mkdir(join(config, "plugins"), { recursive: true });
  await mkdir(bin);
  await copyFile(PLUGIN, join(config, "plugins", "relo.js"));
  const { default: adapter } = await import("../src/harness/adapters/opencode/index.mjs");
  await writeFile(join(config, "relo-hooks.json"), JSON.stringify({ hooks: adapter.install.entries(level) }));
  // The fake relo logs its arguments and stdin; `script` adds what it prints (a role's output).
  // One write per call: the approvals command runs beside the queued events, and their lines must not interleave.
  await writeFile(join(bin, "relo"), `#!/bin/sh\nline="$* $(cat)"\nprintf '%s\\n' "$line" >> "${log}"\n${script}`);
  await chmod(join(bin, "relo"), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const lookups = [];
  const client = { session: { get: async ({ path }) => { lookups.push(path.id); return { data: { id: path.id, parentID: parents[path.id] } }; } } };
  const { default: plugin } = await import(join(config, "plugins", "relo.js"));
  // OpenCode 1 calls `server`; OpenCode 2 calls `setup` with a context whose event stream `emit` feeds here.
  const hooks = await plugin.server({ client, directory: "/work/app", worktree: "/work/app" });
  const stream = [];
  let wake = () => {};
  const emit = (event) => { stream.push(event); wake(); };
  const registered = {};
  const replies = [];
  const context = {
    location: { directory: "/work/app" },
    permission: { reply: async (reply) => { replies.push(reply); } },
    session: {
      get: async ({ sessionID }) => { lookups.push(sessionID); return { id: sessionID, parentID: parents[sessionID] }; },
      hook: async (name, callback) => { registered[name] = callback; return {}; },
    },
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {
      for (;;) {
        while (stream.length > 0) yield stream.shift();
        await new Promise((resolve) => { wake = resolve; });
      }
    } }) },
  };
  const v2 = async () => { await plugin.setup(context); return emit; };
  /** The fake relo's calls, once `count` arrived (the plugin runs them one at a time, in the background). */
  const calls = async (count) => {
    let text = "";
    for (let tries = 0; tries < 400; tries += 1) {
      text = existsSync(log) ? await readFile(log, "utf8") : "";
      if (text.endsWith("\n") && text.split("\n").filter(Boolean).length >= count) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return text.trim().split("\n").filter(Boolean).map((line) => {
      const at = line.indexOf("{");
      return { argv: line.slice(0, at).trim(), input: JSON.parse(line.slice(at)) };
    });
  };
  return { plugin, hooks, calls, lookups, v2, registered, replies };
}

test("the plugin runs the listed commands in order with ids only, and rolls a child session up into its root", async () => {
  const { hooks, calls, lookups } = await loadPlugin({ parents: {} });
  await hooks.event({ event: { type: "session.created", properties: { info: { id: ROOT, title: "Fix the login bug" } } } });
  await hooks["chat.message"]({ sessionID: ROOT, agent: "build" }, { message: { text: SECRET_PROMPT }, parts: [{ text: SECRET_PROMPT }] });
  await hooks["tool.execute.before"]({ tool: "bash", sessionID: ROOT, callID: "call_1" }, { args: { command: "cat ~/.ssh/id_rsa" } });
  await hooks.event({ event: { type: "session.created", properties: { info: { id: CHILD, parentID: ROOT } } } });
  await hooks.event({ event: { type: "permission.asked", properties: { sessionID: CHILD, permission: "bash", patterns: ["rm -rf"] } } });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: CHILD } } });
  await hooks["tool.execute.after"]({ tool: "bash", sessionID: ROOT, callID: "call_1", args: {} }, { title: "t", output: "PRIVATE KEY", metadata: {} });
  await hooks.event({ event: { type: "message.updated", properties: { info: { text: SECRET_PROMPT } } } });
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: ROOT } } });
  const all = await calls(11);
  // The continuity roles run after the event they follow (restore at start, turn at a prompt, remind at stop).
  assert.deepEqual(all.filter((call) => /hook (restore|turn|remind) /u.test(call.argv)).map((call) => call.argv.split(" ")[1]), ["restore", "turn", "remind"]);
  const seen = all.filter((call) => !/hook (restore|turn|remind) /u.test(call.argv));
  assert.deepEqual(seen.map((call) => call.argv), [
    "hook start --agent opencode", "hook prompt --agent opencode", "hook tool-start --agent opencode", "hook subagent-start --agent opencode",
    "hook wait --agent opencode", "hook subagent-stop --agent opencode", "hook tool-end --agent opencode", "hook stop --agent opencode",
  ]);
  assert.deepEqual(seen[0].input, { hook_event_name: "session.created", session_id: ROOT, cwd: "/work/app", title: "Fix the login bug", source: "startup" });
  const named = { title: "Fix the login bug" };
  assert.deepEqual(seen[2].input, { hook_event_name: "tool.execute.before", session_id: ROOT, cwd: "/work/app", ...named, tool_id: "call_1" });
  assert.deepEqual(seen[4].input, { hook_event_name: "permission.asked", session_id: ROOT, agent_id: CHILD, cwd: "/work/app", ...named });
  assert.deepEqual(seen[5].input, { hook_event_name: "subagent.idle", session_id: ROOT, agent_id: CHILD, cwd: "/work/app", ...named });
  const traffic = JSON.stringify(seen);
  for (const secret of [SECRET_PROMPT, "id_rsa", "PRIVATE KEY", "bash", "rm -rf"]) assert.equal(traffic.includes(secret), false, secret);
  assert.deepEqual(lookups, [], "sessions it saw created need no lookup");
});

test("a session the plugin never saw created is looked up once to find its root", async () => {
  const { hooks, calls, lookups } = await loadPlugin({ parents: { [CHILD]: ROOT } });
  await hooks["tool.execute.before"]({ tool: "read", sessionID: CHILD, callID: "call_2" }, { args: {} });
  await hooks["tool.execute.after"]({ tool: "read", sessionID: CHILD, callID: "call_2", args: {} }, { title: "", output: "", metadata: {} });
  const seen = await calls(2);
  assert.deepEqual(seen.map((call) => call.input.agent_id), [CHILD, CHILD]);
  assert.deepEqual(seen.map((call) => call.input.session_id), [ROOT, ROOT]);
  assert.deepEqual(lookups, [CHILD, ROOT]);
});

test("OpenCode 2: the plugin is a default { id, setup } and maps its event stream, a subagent's child session included", async () => {
  const { plugin, v2, calls, lookups } = await loadPlugin();
  assert.equal(plugin.id, "relo");
  assert.equal(typeof plugin.setup, "function");
  const emit = await v2();
  const at = { location: { directory: "/work/app" } };
  emit({ type: "session.inbox.enqueued", ...at, data: { sessionID: ROOT, item: { type: "user", payload: { text: SECRET_PROMPT } } } });
  emit({ type: "session.execution.started", data: { sessionID: ROOT } });
  emit({ type: "session.renamed", data: { sessionID: ROOT, title: "Fix the login bug" } });
  emit({ type: "session.text.delta", data: { sessionID: ROOT, text: SECRET_PROMPT } });
  emit({ type: "session.tool.called", data: { sessionID: ROOT, id: "call_task", input: { prompt: SECRET_PROMPT } } });
  emit({ type: "session.created", data: { sessionID: CHILD, parentID: ROOT, title: SECRET_PROMPT } });
  emit({ type: "session.tool.called", data: { sessionID: CHILD, id: "call_shell", input: { command: "cat ~/.ssh/id_rsa" } } });
  emit({ type: "session.tool.success", data: { sessionID: CHILD, id: "call_shell", content: [{ text: "PRIVATE KEY" }] } });
  emit({ type: "session.execution.succeeded", data: { sessionID: CHILD } });
  emit({ type: "session.tool.success", data: { sessionID: ROOT, id: "call_task" } });
  emit({ type: "session.execution.succeeded", data: { sessionID: ROOT } });
  const seen = (await calls(12)).filter((call) => !/hook (restore|turn|remind) /u.test(call.argv));
  assert.deepEqual(seen.map((call) => call.argv.replace(" --agent opencode", "").replace("hook ", "")), [
    "prompt", "prompt", "tool-start", "subagent-start", "tool-start", "tool-end", "subagent-stop", "tool-end", "stop",
  ]);
  // The session's title travels with its events (relo seals it for the phones); a subagent's own title does not.
  assert.deepEqual(seen[2].input, { hook_event_name: "tool.execute.before", session_id: ROOT, cwd: "/work/app", title: "Fix the login bug", tool_id: "call_task" });
  assert.deepEqual(seen[4].input, { hook_event_name: "tool.execute.before", session_id: ROOT, agent_id: CHILD, cwd: "/work/app", title: "Fix the login bug" });
  const traffic = JSON.stringify(seen);
  for (const secret of [SECRET_PROMPT, "id_rsa", "PRIVATE KEY"]) assert.equal(traffic.includes(secret), false, secret);
  assert.deepEqual(lookups, [ROOT], "only the root, which the plugin did not see created, is looked up");
});

test("a stamped plugin runs this CLI by absolute path, with no relo on PATH (OpenCode's background service)", async () => {
  const config = await mkdtemp(join(tmpdir(), "relo-opencode-launch-"));
  const log = join(config, "calls.jsonl");
  const script = join(config, "relo.mjs");
  await writeFile(script, `import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + " " + readFileSync(0, "utf8") + "\\n");\n`);
  await mkdir(join(config, "plugins"));
  const { default: adapter } = await import("../src/harness/adapters/opencode/index.mjs");
  await writeFile(join(config, "relo-hooks.json"), JSON.stringify({ hooks: adapter.install.entries("presence") }));
  const runner = adapter.install.runner(join(config, "relo-hooks.json"));
  await writeFile(runner.path, runner.content({ nodePath: process.execPath, entrypoint: script }));
  const path = process.env.PATH;
  process.env.PATH = "/nonexistent";
  try {
    const { default: plugin } = await import(runner.path);
    const hooks = await plugin.server({ client: { session: { get: async () => ({ data: {} }) } }, directory: "/work/app" });
    await hooks["chat.message"]({ sessionID: ROOT });
    let text = "";
    for (let tries = 0; tries < 400 && text.split("\n").length < 3; tries += 1) {
      text = existsSync(log) ? await readFile(log, "utf8") : "";
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const line = (role) => `hook ${role} --agent opencode {"hook_event_name":"chat.message","session_id":"${ROOT}","cwd":"/work/app"}\n`;
    assert.equal(text, line("prompt") + line("turn"));
  } finally {
    process.env.PATH = path;
  }
});

test("continuity: a prompt's open work becomes the session's system text, never a subagent's", async () => {
  const { v2, registered, calls } = await loadPlugin({
    script: `case "$2" in turn) echo '{"context":"Relo: open work \\"Ship\\"; round 1 in progress."}';; esac\n`,
  });
  const emit = await v2();
  emit({ type: "session.inbox.enqueued", data: { sessionID: ROOT, item: { type: "user" } } });
  await calls(2);
  const request = { sessionID: ROOT, system: [{ type: "text", text: "OpenCode's own" }] };
  await registered.context(request);
  assert.deepEqual(request.system.at(-1), { type: "text", text: 'Relo: open work "Ship"; round 1 in progress.' });
  emit({ type: "session.created", data: { sessionID: CHILD, parentID: ROOT } });
  await calls(3);
  const child = { sessionID: CHILD, system: [] };
  await registered.context(child);
  assert.deepEqual(child.system, []);
});

test("approvals: OpenCode's permission prompt is asked on the phone; the phone's answer replies, the terminal's withdraws it", async () => {
  const { default: adapter } = await import("../src/harness/adapters/opencode/index.mjs");
  assert.deepEqual(adapter.install.entries("approvals")["permission.request"],
    [{ hooks: [{ type: "command", command: "relo hook permission --agent opencode", timeout: 330 }] }]);
  assert.deepEqual(adapter.permissionRequest({ session_id: ROOT, action: "shell", resources: ["rm -rf build"], cwd: "/work/app" }),
    { session: ROOT, tool: "Bash", input: { command: "rm -rf build" }, cwd: "/work/app" });
  assert.deepEqual(adapter.renderDecision({ behavior: "allow" }), { decision: "allow" });
  assert.equal(adapter.sessionEnv({}, ROOT).OPENCODE_SESSION_ID, ROOT);

  const allowed = await loadPlugin({ level: "approvals", script: `case "$2" in permission) echo '{"decision":"allow"}';; esac\n` });
  const emit = await allowed.v2();
  emit({ type: "permission.asked", data: { id: "per_1", sessionID: ROOT, action: "shell", resources: ["rm -rf build"] } });
  const seen = await allowed.calls(2);
  const asked = seen.find((call) => call.argv.startsWith("hook permission"));
  assert.deepEqual(asked.input, { hook_event_name: "permission.request", session_id: ROOT, cwd: "/work/app", request_id: "per_1",
    action: "shell", resources: ["rm -rf build"] });
  for (let tries = 0; tries < 400 && allowed.replies.length === 0; tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(allowed.replies, [{ sessionID: ROOT, requestID: "per_1", reply: "once" }]);

  // Answered in the terminal first: the waiting command is stopped and OpenCode gets no second answer.
  const slow = await loadPlugin({ level: "approvals", script: `case "$2" in permission) sleep 5; echo '{"decision":"deny"}';; esac\n` });
  const emitSlow = await slow.v2();
  emitSlow({ type: "permission.asked", data: { id: "per_2", sessionID: ROOT, action: "shell", resources: ["ls"] } });
  await slow.calls(2);
  emitSlow({ type: "permission.replied", data: { sessionID: ROOT, requestID: "per_2", reply: "once" } });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(slow.replies, []);
});

