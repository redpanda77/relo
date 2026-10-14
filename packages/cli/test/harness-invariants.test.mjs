import "./hermetic-env.mjs";
// Harness invariants (HA.2, ADR 0008 principles 12 and 13): adapters map and render, the core owns state
// and transport and never branches on which adapter is calling; hook traffic carries no prompt, tool or
// transcript detail; a hook returns at once even with the network down.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ADAPTERS } from "../src/harness/adapters/index.mjs";
import { CANONICAL_EVENTS } from "../src/harness/core/events.mjs";
import { SECRET_PROMPT, SESSION_ID, hookBox } from "./hook-fixture.mjs";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");

async function filesUnder(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await filesUnder(path));
    else if (entry.name.endsWith(".mjs")) out.push(path);
  }
  return out;
}

const importsOf = (text) => [...text.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/gmu), ...text.matchAll(/import\(\s*"([^"]+)"\s*\)/gu)]
  .map((match) => match[1]);

/** Every local module a file reaches through static imports, itself included. */
async function reachable(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  for (const specifier of importsOf(await readFile(file, "utf8"))) {
    if (specifier.startsWith(".")) await reachable(resolve(dirname(file), specifier), seen);
  }
  return seen;
}

test("adapters never reach the API client, the outbox or the network, even indirectly", async () => {
  const forbidden = [join(SRC, "api-client.mjs"), join(SRC, "outbox", "index.mjs")];
  for (const file of await filesUnder(join(SRC, "harness", "adapters"))) {
    const modules = await reachable(file);
    for (const module of forbidden) assert.equal(modules.has(module), false, `${file} reaches ${module}`);
    for (const module of modules) {
      const text = await readFile(module, "utf8");
      assert.doesNotMatch(text, /from\s+"node:(?:https?|net|tls|dgram)"|\bfetch\(/u, `${module} (reached from ${file}) uses the network`);
    }
  }
});

test("the core never branches on which adapter is calling", async () => {
  const ids = Object.values(ADAPTERS).flatMap((adapter) => [adapter.id, ...(adapter.aliases ?? [])]);
  for (const file of await filesUnder(join(SRC, "harness", "core"))) {
    const text = (await readFile(file, "utf8")).replace(/^\s*\/\/.*$/gmu, "");
    assert.doesNotMatch(text, /adapter\.(?:id|label)\s*[!=]==|[!=]==\s*adapter\.(?:id|label)|switch\s*\(\s*adapter\./u, file);
    for (const id of ids) assert.equal(text.includes(`"${id}"`), false, `${file} names the ${id} adapter`);
    for (const specifier of importsOf(text)) assert.doesNotMatch(specifier, /adapters\//u, `${file} imports an adapter`);
  }
});

test("every adapter has the same shape and maps only onto canonical events", () => {
  for (const adapter of Object.values(ADAPTERS)) {
    assert.equal(typeof adapter.id, "string");
    assert.equal(typeof adapter.identity, "function");
    assert.equal(typeof adapter.render, "function");
    for (const event of Object.values(adapter.events)) assert.ok(CANONICAL_EVENTS.includes(event), `${adapter.id}: ${event}`);
    const { install } = adapter;
    assert.equal(install.format, "json-hooks-map");
    assert.ok(install.levels.includes("off") && install.levels.includes(install.recommended));
    for (const level of install.levels) {
      for (const groups of Object.values(install.entries(level))) {
        for (const group of groups) for (const hook of group.hooks) assert.match(hook.command, /^relo hook [a-z-]+( --agent [a-z-]+)?$/u);
      }
    }
  }
});

// Everything a harness might put on stdin that must never leave normalize().
const NOISE = {
  prompt: SECRET_PROMPT, transcript_path: "/Users/x/.claude/projects/p/transcript-9.jsonl", agent_transcript_path: "/Users/x/agent-transcript.jsonl",
  tool_name: "Bash", tool_input: { command: "cat ~/.ssh/id_rsa" }, tool_response: { stdout: "BEGIN PRIVATE KEY" },
  message: "Claude needs your permission to use Bash", last_assistant_message: "the password is hunter2", custom_instructions: "hunter2",
  agent_type: "Explore", trigger: "manual",
};
const SECRETS = [SECRET_PROMPT, "hunter2", "id_rsa", "PRIVATE KEY", "transcript", "Bash", "permission to use", "Explore", SESSION_ID];

test("no prompt, tool name or IO, message or transcript path ever reaches the outbox, the server or the hook's files", async () => {
  const box = await hookBox();
  const events = [
    ["SessionStart", "start", { source: "startup" }],
    ["UserPromptSubmit", "prompt", {}],
    ["PreToolUse", "tool-start", { tool_use_id: "toolu_1" }],
    ["SubagentStart", "subagent-start", { agent_id: "agent-1" }],
    ["PreToolUse", "tool-start", { tool_use_id: "toolu_2", agent_id: "agent-1" }],
    ["Notification", "wait", { notification_type: "permission_prompt" }],
    ["PostToolUse", "tool-end", { tool_use_id: "toolu_2", agent_id: "agent-1" }],
    ["SubagentStop", "subagent-stop", { agent_id: "agent-1" }],
    ["PostToolUse", "tool-end", { tool_use_id: "toolu_1" }],
    ["PreCompact", "compact", {}],
    ["Stop", "stop", {}],
    ["SessionEnd", "end", { reason: "other" }],
  ];
  for (const [name, command, extra] of events) {
    const out = await box.event(name, command, { ...NOISE, ...extra });
    assert.deepEqual(out.stdout, [], name);
    await box.flush();
  }
  assert.ok(box.requests.length >= 5, "the session's phases went out");
  const stateFiles = await Promise.all((await allFiles(box.state)).map((file) => readFile(file, "utf8")));
  assert.ok(stateFiles.length >= 1, "the hook kept its observed state file");
  const traffic = JSON.stringify({ requests: box.requests, entries: box.entries, minted: box.minted, other: box.other });
  for (const secret of SECRETS) {
    assert.equal(traffic.includes(secret), false, `${secret} reached the wire`);
    for (const text of stateFiles) assert.equal(text.includes(secret), false, `${secret} reached a hook file`);
  }
  for (const request of box.requests) {
    assert.equal(request.route, "/api/agent-sessions/observed");
    for (const key of Object.keys(request.body)) {
      assert.ok(["session", "harness", "phase", "phaseSince", "lastSeenAt", "openToolSince", "seq", "project", "computer", "account", "sealedNames"].includes(key), key);
    }
  }
});

async function allFiles(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await allFiles(path));
    else if (entry.name !== "harness-credential") out.push(path);
  }
  return out;
}

test("a hook returns at once with the network down: p95 under 50 ms", async () => {
  const down = () => { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); };
  const box = await hookBox({ respond: down });
  const cycle = [["UserPromptSubmit", "prompt", {}], ["PreToolUse", "tool-start", { tool_use_id: "t" }],
    ["PostToolUse", "tool-end", { tool_use_id: "t" }], ["Stop", "stop", {}]];
  await box.event("SessionStart", "start", { source: "startup" });
  let i = 0;
  const batch = async (count) => {
    const times = [];
    for (let n = 0; n < count; n += 1, i += 1) {
      const [name, command, extra] = cycle[i % cycle.length];
      const started = performance.now();
      const out = await box.event(name, command, { ...extra, ...(extra.tool_use_id ? { tool_use_id: `t${Math.floor(i / 4)}` } : {}) });
      times.push(performance.now() - started);
      assert.equal(out.exitCode, 0);
    }
    return times.sort((a, b) => a - b)[Math.floor(count * 0.95)];
  };
  await batch(8); // warm up the module cache and the JIT
  // The whole suite runs in parallel processes: a load spike can stall one batch, so the best of three
  // counts. On an idle machine a hook takes about a millisecond.
  const p95s = [];
  for (let attempt = 0; attempt < 3 && !(p95s.at(-1) < 50); attempt += 1) p95s.push(await batch(40));
  assert.ok(Math.min(...p95s) < 50, `hook p95 ${p95s.map((value) => value.toFixed(1)).join(", ")} ms`);
  assert.deepEqual(box.requests, [], "the hook itself never touched the network");
  const flushed = await box.flush();
  assert.equal(flushed.exitCode, 0);
  assert.equal(flushed.line.data.sent, 0);
  assert.equal(flushed.line.data.pending, 1, "the snapshot waits for the network");
});
