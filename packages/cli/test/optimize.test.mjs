// Optimize's extras (plan 12 §4.6, §4.7, Phase 8): the status line wrapper, the named subagent definitions, the
// subagent model default, the two nudges, and the context/cost facts. Everything runs in throwaway folders.
import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { tildeText } from "./posix-path.mjs";
import { run } from "../src/cli.mjs";
import { runStatusline } from "../src/harness/entry.mjs";
import claudeCode from "../src/harness/adapters/claude-code/index.mjs";
import { wantedEntries } from "../src/harness/adapters/claude-code/levels.mjs";
import { readContext } from "../src/harness/core/bookkeeping.mjs";
import { defaultLine, readingOf } from "../src/harness/core/statusline.mjs";
import { runHarnessRole } from "../src/harness/core/roles.mjs";
import { snapshotDue } from "../src/harness/core/state-machine.mjs";
import { handoffThreshold } from "../src/harness/core/turn.mjs";
import { EXIT } from "../src/shared/errors.mjs";
import { sessionKey } from "../src/shared/session-key.mjs";
import { cardDependencies, fakeHome } from "./fake-cards.mjs";
import { SESSION_ID, hookBox } from "./hook-fixture.mjs";

const KEY = sessionKey({ harness: "claude-code", id: SESSION_ID });

async function cli(argv, dependencies, io = {}) {
  const stdout = [];
  const exitCode = await run(argv, { stdout: (line) => stdout.push(tildeText(line)), stderr: () => {}, stdoutIsTTY: false, ...io }, dependencies);
  const json = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
  return { exitCode, stdout, line: stdout[0] ? json(stdout[0]) : undefined };
}

async function sandbox({ settings } = {}) {
  const home = await fakeHome();
  const cwd = await mkdtemp(join(tmpdir(), "relo-opt-cwd-"));
  await mkdir(join(cwd, ".git"));
  const hooks = join(home, ".relo-state", "hooks");
  const deps = { ...cardDependencies({}), home, cwd, env: {}, hookStateDirectory: hooks };
  const paths = { settings: join(home, ".claude", "settings.json"), agents: join(home, ".claude", "agents"), state: join(hooks, "optimize.json") };
  if (settings !== undefined) await writeFile(paths.settings, settings);
  return { home, cwd, deps, hooks, ...paths, run: (argv, more = {}, io = {}) => cli(argv, { ...deps, ...more }, io) };
}

const settingsOf = (box) => JSON.parse(readFileSync(box.settings, "utf8"));
const OWNER = { model: "opus", statusLine: { type: "command", command: "~/bin/my-line.sh", padding: 1 }, env: { FOO: "1" } };
const ownerText = `${JSON.stringify(OWNER, null, 2)}\n`;

// ----- install, show, dry run, uninstall -------------------------------------------------------------------------

test("optimize installs the status line wrapper, both agents and the lean hook set; the owner's status line is saved in Relo's state, not in settings", async () => {
  const box = await sandbox({ settings: ownerText });
  const out = await box.run(["setup", "--level", "optimize"], {}, { stdoutIsTTY: true });
  assert.equal(out.exitCode, EXIT.OK, out.stdout.join("\n"));
  const text = out.stdout.join("\n");
  assert.doesNotMatch(text, /later release/u);
  assert.match(text, /Claude Code .*hooks: presence \+ subagent nudge · status line · agents: relo-explore, relo-worker/u);
  assert.match(text, /Codex .*agents: relo-explore, relo-worker/u);
  const codexAgents = join(box.home, ".codex", "agents");
  const explore = readFileSync(join(codexAgents, "relo-explore.toml"), "utf8");
  assert.match(explore, /^# relo:managed relo-explore v1/u);
  assert.match(explore, /\nname = "relo-explore"\n/u);
  assert.match(explore, /\nmodel_reasoning_effort = "low"\n/u);
  assert.doesNotMatch(explore, /\nmodel = /u, "no model name: the agent inherits the session's");
  assert.match(explore, /\ndeveloper_instructions = """\n/u);
  assert.match(readFileSync(join(codexAgents, "relo-worker.toml"), "utf8"), /\nmodel_reasoning_effort = "medium"\n/u);
  const settings = settingsOf(box);
  assert.deepEqual(settings.statusLine, { type: "command", command: "relo statusline", padding: 1 }, "padding stays, the command is Relo's");
  assert.equal(JSON.stringify(settings).includes("my-line.sh"), false, "the previous command is not in the settings file");
  assert.deepEqual(JSON.parse(readFileSync(box.state, "utf8")).statusLine.previous, OWNER.statusLine);
  assert.equal(settings.env.FOO, "1");
  assert.equal(settings.env.CLAUDE_CODE_SUBAGENT_MODEL, undefined, "the subagent default is never on by itself");
  for (const [name, model] of [["relo-explore", "haiku"], ["relo-worker", "sonnet"]]) {
    const file = readFileSync(join(box.agents, `${name}.md`), "utf8");
    assert.match(file, new RegExp(`^---\\nname: ${name}\\n`, "u"));
    assert.match(file, new RegExp(`\\nmodel: ${model}\\n`, "u"));
    assert.match(file, /<!-- relo:managed /u);
  }
  assert.match(readFileSync(join(box.agents, "relo-explore.md"), "utf8"), /\ntools: Read, Grep, Glob\n/u, "the explorer only reads");
  assert.doesNotMatch(readFileSync(join(box.agents, "relo-worker.md"), "utf8"), /\ntools:/u);
  const pre = settings.hooks.PreToolUse.map((group) => group.matcher);
  assert.ok(pre.includes("Agent|Task"), "the subagent nudge is in optimize's hook set");
  // Running it again changes nothing.
  const again = await box.run(["setup", "--level", "optimize"]);
  assert.deepEqual(again.line.changed, []);
});

test("--dry-run writes nothing; --show names the extras installed and the extras a depth would install", async () => {
  const box = await sandbox({ settings: ownerText });
  const dry = await box.run(["setup", "--level", "optimize", "--dry-run"]);
  assert.equal(dry.exitCode, EXIT.OK);
  assert.deepEqual(dry.line.changed.map((row) => row.kind).sort(), ["agent", "agent", "agent", "agent", "block", "block", "hooks", "hooks", "skill", "skill", "statusline"]);
  assert.equal(readFileSync(box.settings, "utf8"), ownerText);
  assert.equal(existsSync(box.agents), false);
  assert.equal(existsSync(box.state), false);
  const would = await box.run(["setup", "--show", "--level", "optimize", "--subagent-model", "sonnet"], {}, { stdoutIsTTY: true });
  assert.match(would.stdout.join("\n"), /Optimize extras: status line on, agents on, subagent model sonnet/u);
  assert.equal(readFileSync(box.settings, "utf8"), ownerText);
  await box.run(["setup", "--level", "optimize"]);
  const shown = await box.run(["setup", "--show"], {}, { stdoutIsTTY: true });
  assert.match(shown.stdout.join("\n"), /Optimize extras: status line on, agents relo-explore relo-worker/u);
});

test("uninstall puts the previous status line back exactly, removes Relo's agents and hooks, and keeps what is the owner's", async () => {
  const box = await sandbox({ settings: ownerText });
  await box.run(["setup", "--level", "optimize"]);
  const mine = join(box.agents, "my-own.md");
  await writeFile(mine, "mine\n");
  const out = await box.run(["uninstall", "--apply"]);
  assert.equal(out.exitCode, EXIT.OK);
  assert.equal(readFileSync(box.settings, "utf8"), ownerText, "byte for byte what the owner had");
  assert.equal(existsSync(join(box.agents, "relo-explore.md")), false);
  assert.equal(existsSync(join(box.agents, "relo-worker.md")), false);
  assert.equal(readFileSync(mine, "utf8"), "mine\n");
  assert.equal(existsSync(box.state), false, "Relo's record of what it changed goes with it");
});

test("with no status line before, uninstall removes the key and the settings file Relo created", async () => {
  const box = await sandbox();
  await box.run(["setup", "--level", "optimize"]);
  assert.equal(settingsOf(box).statusLine.command, "relo statusline");
  assert.equal(JSON.parse(readFileSync(box.state, "utf8")).statusLine.previous, null);
  await box.run(["uninstall", "--apply"]);
  assert.equal(existsSync(box.settings), false);
});

test("moving below optimize restores the status line and removes Relo's agents; track and guide keep none of it", async () => {
  for (const level of ["guide", "track"]) {
    const box = await sandbox({ settings: ownerText });
    await box.run(["setup", "--level", "optimize", "--subagent-model", "haiku"]);
    assert.equal(settingsOf(box).env.CLAUDE_CODE_SUBAGENT_MODEL, "haiku");
    const out = await box.run(["setup", "--level", level]);
    assert.equal(out.exitCode, EXIT.OK);
    const settings = existsSync(box.settings) ? settingsOf(box) : {};
    assert.deepEqual(settings.statusLine, OWNER.statusLine, level);
    assert.deepEqual(settings.env, OWNER.env, `${level}: Relo's subagent default is gone, the owner's env stays`);
    assert.equal(existsSync(join(box.agents, "relo-explore.md")), false, level);
    if (level === "guide") assert.equal(settings.hooks.PreToolUse.some((group) => group.matcher === "Agent|Task"), false, "guide's set has no subagent nudge");
  }
});

test("a bare setup at optimize keeps the extras as they are; --statusline off and --agents off take them out", async () => {
  const box = await sandbox({ settings: ownerText });
  await box.run(["setup", "--level", "optimize"]);
  const bare = await box.run(["setup"]);
  assert.deepEqual(bare.line.changed, []);
  const off = await box.run(["setup", "--level", "optimize", "--statusline", "off", "--agents", "off"]);
  assert.equal(off.exitCode, EXIT.OK);
  assert.deepEqual(settingsOf(box).statusLine, OWNER.statusLine);
  assert.equal(existsSync(join(box.agents, "relo-worker.md")), false);
  const only = await sandbox();
  await only.run(["setup", "--level", "optimize", "--statusline", "off"]);
  assert.equal(existsSync(join(only.agents, "relo-explore.md")), true);
  assert.equal(settingsOf(only).statusLine, undefined);
});

test("the extras need optimize and user scope; a bad value is refused", async () => {
  const box = await sandbox();
  for (const argv of [["--level", "guide", "--statusline", "on"], ["--level", "track", "--agents", "on"], ["--level", "guide", "--subagent-model", "sonnet"]]) {
    const out = await box.run(["setup", ...argv]);
    assert.equal(out.exitCode, EXIT.USAGE, argv.join(" "));
  }
  assert.equal((await box.run(["setup", "--level", "optimize", "--statusline", "maybe"])).exitCode, EXIT.USAGE);
  assert.equal((await box.run(["setup", "--level", "optimize", "--subagent-model", "bad model!"])).exitCode, EXIT.USAGE);
  assert.equal((await box.run(["setup", "--project", "--level", "optimize", "--agents", "on"])).exitCode, EXIT.USAGE);
  assert.equal(existsSync(box.settings), false, "nothing was written");
});

test("a person at the terminal is asked about each extra (Enter: yes); an agent or script is never asked", async () => {
  const box = await sandbox();
  const questions = [];
  const answers = { "Wrap Claude Code's": "n" };
  const ask = async (question, fallback) => {
    questions.push(question.split("\n")[0]);
    const key = Object.keys(answers).find((prefix) => question.startsWith(prefix));
    return key ? answers[key] : fallback;
  };
  const terminal = { stdinIsTTY: true, stdoutIsTTY: true, ask, computerName: () => "box", clientFactory: () => ({ putComputerSelf: async () => ({}) }) };
  const out = await box.run(["setup", "--level", "optimize", "--computer", "Box"], terminal, { stdoutIsTTY: true });
  assert.equal(out.exitCode, EXIT.OK, out.stdout.join("\n"));
  assert.deepEqual(questions.filter((q) => /status line|subagents/u.test(q)).length, 2);
  assert.equal(settingsOf(box).statusLine, undefined, "no to the status line");
  assert.equal(existsSync(join(box.agents, "relo-explore.md")), true, "Enter is yes");
  const quiet = await sandbox();
  let asked = 0;
  await quiet.run(["setup", "--level", "optimize"], { stdinIsTTY: false, ask: async () => { asked += 1; return "n"; } });
  assert.equal(asked, 0);
  assert.equal(settingsOf(quiet).statusLine.command, "relo statusline");
});

// ----- agent files -------------------------------------------------------------------------------------------------

test("a same-named agent file Relo did not write is never overwritten or removed; Relo's own is refreshed", async () => {
  const box = await sandbox();
  mkdirSync(box.agents, { recursive: true });
  await writeFile(join(box.agents, "relo-explore.md"), "---\nname: relo-explore\n---\nthe owner's own\n");
  const out = await box.run(["setup", "--level", "optimize"], {}, { stdoutIsTTY: true });
  assert.equal(out.exitCode, EXIT.OK);
  assert.equal(readFileSync(join(box.agents, "relo-explore.md"), "utf8"), "---\nname: relo-explore\n---\nthe owner's own\n");
  assert.equal(existsSync(join(box.agents, "relo-worker.md")), true);
  assert.match(out.stdout.join("\n"), /relo-explore\.md is yours/u);
  assert.match(out.stdout.join("\n"), /agents: relo-worker \(kept yours\)/u);
  await box.run(["setup", "--level", "optimize", "--agents", "off"]);
  assert.equal(readFileSync(join(box.agents, "relo-explore.md"), "utf8"), "---\nname: relo-explore\n---\nthe owner's own\n");
  assert.equal(existsSync(join(box.agents, "relo-worker.md")), false);
  // --refresh rewrites an outdated managed file
  await box.run(["setup", "--level", "optimize", "--agents", "on"]);
  const worker = join(box.agents, "relo-worker.md");
  await writeFile(worker, readFileSync(worker, "utf8").replace("v1", "v0").replace("mid-size", "OLD"));
  const refreshed = await box.run(["setup", "--refresh"]);
  assert.ok(refreshed.line.changed.some((row) => row.kind === "agent"));
  assert.doesNotMatch(readFileSync(worker, "utf8"), /OLD/u);
});

test("--subagent-model sets Claude Code's CLAUDE_CODE_SUBAGENT_MODEL only when asked, and only Relo's value is ever removed", async () => {
  const box = await sandbox({ settings: `${JSON.stringify({ env: { CLAUDE_CODE_SUBAGENT_MODEL: "opus", FOO: "1" } }, null, 2)}\n` });
  await box.run(["setup", "--level", "optimize"]);
  assert.equal(settingsOf(box).env.CLAUDE_CODE_SUBAGENT_MODEL, "opus", "not set by default");
  await box.run(["setup", "--level", "optimize", "--subagent-model", "sonnet"]);
  assert.equal(settingsOf(box).env.CLAUDE_CODE_SUBAGENT_MODEL, "sonnet");
  await box.run(["setup", "--level", "optimize", "--subagent-model", "off"]);
  assert.equal(settingsOf(box).env.CLAUDE_CODE_SUBAGENT_MODEL, "opus", "the owner's value comes back");
  // the owner changes it after Relo set it: Relo leaves it alone
  await box.run(["setup", "--level", "optimize", "--subagent-model", "haiku"]);
  const changed = settingsOf(box);
  changed.env.CLAUDE_CODE_SUBAGENT_MODEL = "theirs";
  writeFileSync(box.settings, JSON.stringify(changed, null, 2));
  await box.run(["uninstall", "--apply"]);
  assert.equal(settingsOf(box).env.CLAUDE_CODE_SUBAGENT_MODEL, "theirs");
});

// ----- the hook sets -------------------------------------------------------------------------------------------------

test("optimize's hook set is the guide set plus one Agent|Task guard; the guide set is unchanged", () => {
  for (const [lean, plain] of [["presence+lean", "presence"], ["approvals+lean", "approvals"]]) {
    const wanted = wantedEntries(lean);
    const base = wantedEntries(plain);
    assert.deepEqual(wanted.PreToolUse.slice(0, -1), base.PreToolUse);
    assert.deepEqual(wanted.PreToolUse.at(-1), { matcher: "Agent|Task", hooks: [{ type: "command", command: "relo hook guard", timeout: 5 }] });
    const { PreToolUse: _a, ...rest } = wanted;
    const { PreToolUse: _b, ...restBase } = base;
    assert.deepEqual(rest, restBase);
  }
  assert.equal(wantedEntries("presence").PreToolUse.some((group) => group.matcher === "Agent|Task"), false);
});

// ----- the status line wrapper ---------------------------------------------------------------------------------------

function statuslineBox({ previous, env = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "relo-statusline-"));
  const hookStateDirectory = join(root, "state", "hooks");
  mkdirSync(hookStateDirectory, { recursive: true });
  if (previous !== undefined) writeFileSync(join(hookStateDirectory, "optimize.json"), JSON.stringify({ v: 1, statusLine: { previous: { type: "command", command: previous } } }));
  const out = [];
  const box = {
    root, hookStateDirectory, out,
    overrides: (raw, more = {}) => ({ home: root, cwd: root, env: { PATH: process.env.PATH, RELO_NO_BACKGROUND_FLUSH: "1", ...env }, hookStateDirectory, now: () => 1_800_000_000_000,
      readStdinRaw: async () => raw, write: (bytes) => out.push(Buffer.from(bytes)), spawnFlusher: () => {}, ...more }),
    run: async (raw, more) => { out.length = 0; const code = await runStatusline(box.overrides(raw, more)); return { code, bytes: Buffer.concat(out) }; },
  };
  return box;
}

const reading = (extra = {}) => Buffer.from(JSON.stringify({ session_id: SESSION_ID, model: { id: "claude-opus", display_name: "Opus" },
  context_window: { used_percentage: 41.6, context_window_size: 200000 }, cost: { total_cost_usd: 1.2345 }, ...extra }));

test("the wrapper prints the previous command's output byte for byte, from the same stdin bytes", async () => {
  const box = statuslineBox({ previous: "cat" });
  // invalid UTF-8, ANSI colors, no trailing newline, a NUL: nothing is re-encoded or trimmed
  const raw = Buffer.concat([reading(), Buffer.from([0xff, 0xfe, 0x00, 0x1b, 0x5b, 0x33, 0x31, 0x6d])]);
  const out = await box.run(raw);
  assert.equal(out.code, 0);
  assert.deepEqual(out.bytes, raw);
  const colored = statuslineBox({ previous: "printf '\\033[32mok\\033[0m'" });
  assert.deepEqual((await colored.run(reading())).bytes, Buffer.from("\u001b[32mok\u001b[0m"));
  const reads = statuslineBox({ previous: "node -e \"let s='';process.stdin.on('data',c=>s+=c).on('end',()=>process.stdout.write(JSON.parse(s).model.display_name))\"" });
  assert.equal((await reads.run(reading())).bytes.toString(), "Opus");
});

test("a failing, slow-to-start or missing previous command never fails the status line", async () => {
  const fails = statuslineBox({ previous: "node -e \"process.stdout.write('partial');process.exit(3)\"" });
  const failed = await fails.run(reading());
  assert.equal(failed.code, 0);
  assert.equal(failed.bytes.toString(), "partial");
  const missing = statuslineBox({ previous: "relo-no-such-command-xyz" });
  assert.equal((await missing.run(reading())).code, 0);
  const garbage = statuslineBox({ previous: "cat" });
  assert.deepEqual((await garbage.run(Buffer.from("not json {"))).bytes, Buffer.from("not json {"), "garbage in, the same garbage through");
  const empty = statuslineBox({ previous: "cat" });
  assert.deepEqual((await empty.run(Buffer.alloc(0))).bytes, Buffer.alloc(0));
  // a state folder that cannot be written (a file where the folder should be) does not stop the pass-through
  const blocked = statuslineBox({ previous: "cat" });
  const raw = reading();
  const result = await blocked.run(raw, { hookStateDirectory: join(blocked.root, "state", "hooks", "optimize.json", "nope") });
  assert.equal(result.code, 0);
  const throwing = statuslineBox({ previous: "cat" });
  assert.equal(await runStatusline(throwing.overrides(raw, { readStdinRaw: async () => { throw new Error("stdin broke"); } })), 0);
});

test("with no previous status line it prints a short line of its own; the reading is defensive about missing fields", async () => {
  const box = statuslineBox();
  assert.equal((await box.run(reading())).bytes.toString(), "Opus · context 42% · $1.23\n");
  assert.equal((await box.run(Buffer.from("{}"))).bytes.toString(), "Relo\n");
  assert.equal((await box.run(Buffer.from("[1,2]"))).bytes.toString(), "Relo\n");
  assert.equal(defaultLine(readingOf({ exceeds_200k_tokens: true }, "claude-code")), "context over 200K");
  // from tokens when no percentage is given
  const tokens = readingOf({ session_id: "a", context_window: { context_window_size: 200000, current_usage: { input_tokens: 40000, cache_read_input_tokens: 20000, cache_creation_input_tokens: 0 } } }, "claude-code");
  assert.equal(tokens.pct, 30);
  assert.equal(readingOf({ session_id: "a", context_window: { used_percentage: "lots" }, cost: { total_cost_usd: "x" } }, "claude-code").pct, undefined);
  assert.equal(readingOf({ session_id: "a", context_window: { used_percentage: 250 } }, "claude-code").pct, 100);
  assert.equal(readingOf({ context_window: { used_percentage: 5 } }, "claude-code").session, undefined, "no session id, nothing stored");
});

test("the wrapper stores context percent and cost in the session's local state, and rewrites it only when something moved", async () => {
  const box = statuslineBox();
  await box.run(reading());
  const stored = await readContext(box.hookStateDirectory, KEY);
  assert.deepEqual([stored.pct, stored.cost, stored.over], [42, 1.23, false]);
  const file = join(box.hookStateDirectory, `context-${KEY}.json`);
  const first = readFileSync(file, "utf8");
  await box.run(reading(), { now: () => 1_800_000_010_000 });
  assert.equal(readFileSync(file, "utf8"), first, "nothing moved within a minute");
  await box.run(reading({ context_window: { used_percentage: 50 } }), { now: () => 1_800_000_020_000 });
  assert.equal((await readContext(box.hookStateDirectory, KEY)).pct, 50);
});

// ----- observed facts: context and cost reach the snapshot only after a real move ---------------------------------

test("contextPct and costUsd ride in the phase snapshot only after a move of 5 points or 50 cents", async () => {
  const hooks = await hookBox();
  await hooks.event("UserPromptSubmit", "prompt");
  assert.equal(hooks.sent.length, 1);
  assert.equal("contextPct" in hooks.sent[0], false, "no reading yet");
  const feed = async (percent, cost) => {
    await runStatusline({ ...hooks.deps(), readStdinRaw: async () => reading({ context_window: { used_percentage: percent }, cost: { total_cost_usd: cost } }), write: () => {} });
    await hooks.collect();
  };
  await feed(10, 0.1);
  assert.equal(hooks.sent.length, 2, "the first reading is a change");
  assert.deepEqual([hooks.sent[1].contextPct, hooks.sent[1].costUsd], [10, 0.1]);
  assert.equal(hooks.sent[1].phase, "working");
  await feed(12, 0.3);
  await feed(14, 0.55);
  assert.equal(hooks.sent.length, 2, "under 5 points and under 50 cents from the last one sent");
  await feed(15, 0.58);
  assert.equal(hooks.sent.length, 3);
  assert.deepEqual([hooks.sent[2].contextPct, hooks.sent[2].costUsd], [15, 0.58]);
  await feed(16, 1.2);
  assert.equal(hooks.sent.length, 4, "cost alone can move it");
  assert.equal(hooks.sent[3].costUsd, 1.2);
  assert.ok(hooks.sent.every((body) => Object.keys(body).every((key) => ["session", "harness", "phase", "phaseSince", "lastSeenAt", "openToolSince", "seq", "project", "computer", "account", "contextPct", "costUsd"].includes(key))));
  assert.deepEqual(hooks.sent.map((body) => body.seq), [1, 2, 3, 4]);
  // a later phase change carries the latest reading
  await hooks.event("Stop", "stop");
  assert.deepEqual([hooks.sent.at(-1).phase, hooks.sent.at(-1).contextPct], ["stopped", 16]);
});

test("a session the hooks never saw is not created by the status line; without hooks nothing is queued", async () => {
  const hooks = await hookBox();
  await runStatusline({ ...hooks.deps(), readStdinRaw: async () => reading(), write: () => {} });
  await hooks.collect();
  assert.equal(hooks.sent.length, 0);
  assert.equal(existsSync(join(hooks.state, "observed")), false);
  assert.equal((await readContext(join(hooks.state, "hooks"), KEY)).pct, 42, "the local reading is still kept");
});

test("snapshotDue: a context or cost move over its step is due; within it is not", () => {
  const sent = { lastSentAt: "2026-01-01T00:00:00Z", lastSentPhase: "stopped", phase: "stopped", openToolSince: null, lastSentOpenToolSince: null, lastSentContextPct: 40, lastSentCostUsd: 2 };
  const now = Date.parse("2026-01-01T00:01:00Z");
  assert.equal(snapshotDue({ ...sent, contextPct: 44, costUsd: 2.4 }, now), false);
  assert.equal(snapshotDue({ ...sent, contextPct: 45, costUsd: 2.4 }, now), true);
  assert.equal(snapshotDue({ ...sent, contextPct: 44, costUsd: 2.5 }, now), true);
  assert.equal(snapshotDue({ ...sent }, now), false, "no reading: as before");
});

// ----- nudges -------------------------------------------------------------------------------------------------------

function nudgeBox() {
  const root = mkdtempSync(join(tmpdir(), "relo-nudge-"));
  const env = { XDG_STATE_HOME: join(root, "state") };
  const hookStateDirectory = join(root, "hooks");
  const printed = [];
  const now = Date.parse("2026-10-14T10:00:00Z");
  const dependencies = { env, home: root, now: () => now, hookStateDirectory, emit: (line) => printed.push(line) };
  const sessions = join(env.XDG_STATE_HOME, "relo", "sessions");
  mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const key = sessionKey({ harness: "claude-code", id: "sess-1" });
  const work = (extra = {}) => writeFileSync(join(sessions, `${key}.json`), JSON.stringify({ v: 1, writtenAt: new Date(now - 60_000).toISOString(),
    open: { id: "wrk_1", goal: "Ship it", lifecycle: "open", version: 3, plan: { steps: [{ id: "s1", label: "Find it", state: "current" }] }, ...extra }, parked: [] }));
  const reading = (value) => {
    mkdirSync(hookStateDirectory, { recursive: true });
    writeFileSync(join(hookStateDirectory, `context-${key}.json`), JSON.stringify({ at: now, ...value }));
  };
  const prompt = (more = {}) => runHarnessRole({ adapter: claudeCode, role: "turn", input: { session_id: "sess-1", hook_event_name: "UserPromptSubmit" }, dependencies: { ...dependencies, ...more } });
  return { printed, work, reading, prompt, dependencies };
}
const contextOf = (box) => box.printed.at(-1)?.hookSpecificOutput.additionalContext ?? "";

test("handoff nudge: past the threshold, one line per round, added to the prompt-time context", async () => {
  const box = nudgeBox();
  box.work();
  box.reading({ pct: 59 });
  await box.prompt();
  assert.doesNotMatch(contextOf(box), /Context at/u, "below the default threshold of 60");
  box.reading({ pct: 63 });
  box.printed.length = 0;
  const first = await box.prompt();
  assert.equal(first.printed, true);
  assert.match(contextOf(box), /^Relo: open work "Ship it"/u);
  assert.match(contextOf(box), /\nRelo: Context at 63%: run `relo work handoff --next "…"` \(do not deliver first: a delivered round refuses it\) and continue in a fresh session\.$/u);
  box.printed.length = 0;
  await box.prompt();
  assert.doesNotMatch(contextOf(box), /Context at/u, "once per round: the second prompt of the round is quiet");
  // the round is delivered, a follow-up request arrives: the next round gets its line once
  box.work({ plan: { steps: [{ id: "s1", label: "Find it", state: "done", round: 1 }], rounds: [{ n: 1, state: "closed", outcome: "Done" }] } });
  box.printed.length = 0;
  await box.prompt();
  assert.match(contextOf(box), /Context at 63%/u);
  box.work({ plan: { steps: [{ id: "s2", label: "Next", state: "current", round: 2 }], rounds: [{ n: 1, state: "closed", outcome: "Done" }, { n: 2, state: "open" }] } });
  box.printed.length = 0;
  await box.prompt();
  assert.doesNotMatch(contextOf(box), /Context at/u, "round 2 was already nudged when its request arrived");
});

test("handoff nudge: the threshold is RELO_HANDOFF_THRESHOLD; no reading means no nudge; no open work still nudges", async () => {
  assert.equal(handoffThreshold({}), 60);
  assert.equal(handoffThreshold({ RELO_HANDOFF_THRESHOLD: "75" }), 75);
  assert.equal(handoffThreshold({ RELO_HANDOFF_THRESHOLD: "0" }), 60);
  assert.equal(handoffThreshold({ RELO_HANDOFF_THRESHOLD: "lots" }), 60);
  const box = nudgeBox();
  box.work();
  assert.equal((await box.prompt()).printed, true);
  assert.doesNotMatch(contextOf(box), /Context/u, "no status line reading: nothing to nudge about");
  box.reading({ pct: 70 });
  box.printed.length = 0;
  await box.prompt({ env: { ...box.dependencies.env, RELO_HANDOFF_THRESHOLD: "80" } });
  assert.doesNotMatch(contextOf(box), /Context at/u);
  box.printed.length = 0;
  await box.prompt({ env: { ...box.dependencies.env, RELO_HANDOFF_THRESHOLD: "70" } });
  assert.match(contextOf(box), /Context at 70%/u);
  const bare = nudgeBox();
  bare.reading({ over: true });
  assert.equal((await bare.prompt()).printed, true, "no open work and no percentage, but past 200K tokens");
  assert.match(contextOf(bare), /\nRelo: Context is past 200K tokens: run `relo work handoff/u);
  const sub = nudgeBox();
  sub.reading({ pct: 90 });
  assert.equal((await runHarnessRole({ adapter: claudeCode, role: "turn", input: { session_id: "sess-1", agent_id: "sub-1" }, dependencies: sub.dependencies })).printed, false);
});

test("subagent nudge: an Agent or Task call that names no model gets one line; a named model, Relo's agents and other tools get none", async () => {
  const printed = [];
  const dependencies = { env: {}, home: tmpdir(), now: () => 1, hookStateDirectory: mkdtempSync(join(tmpdir(), "relo-guard-")), emit: (line) => printed.push(line) };
  const guard = (tool_name, tool_input, more = {}) => runHarnessRole({ adapter: claudeCode, role: "guard", dependencies,
    input: { session_id: "sess-1", hook_event_name: "PreToolUse", tool_name, tool_input, ...more } });
  assert.equal((await guard("Agent", { description: "look", prompt: "find the bug" })).printed, true);
  assert.deepEqual(printed[0], { hookSpecificOutput: { hookEventName: "PreToolUse",
    additionalContext: "Relo: name a model for this subagent: haiku for search and reading, sonnet for implementing, opus for planning and review." } });
  assert.equal(JSON.stringify(printed[0]).includes("find the bug"), false, "the prompt is never read");
  assert.equal((await guard("Task", { prompt: "x", model: "" })).printed, true, "an empty model names none");
  printed.length = 0;
  for (const [tool, input, more] of [["Agent", { prompt: "x", model: "haiku" }], ["Task", { prompt: "x", model: "sonnet" }], ["Agent", { prompt: "x", subagent_type: "relo-explore" }],
    ["Agent", { prompt: "x", subagent_type: "Explore" }], ["Bash", { command: "relo state" }], ["mcp__relo__relo_work_state", {}], ["Agent", { prompt: "x" }, { agent_id: "inner" }]]) {
    assert.equal((await guard(tool, input, more)).printed, false, `${tool} ${JSON.stringify(input)}`);
  }
  assert.equal(printed.length, 0);
});

test("Codex agent files: an owner's same-named file is kept, Relo's go with a shallower depth, and refresh re-renders them", async () => {
  const box = await sandbox({ settings: ownerText });
  const folder = join(box.home, ".codex", "agents");
  await mkdir(folder, { recursive: true });
  const mine = 'name = "relo-worker"\ndescription = "mine"\ndeveloper_instructions = "mine"\n';
  await writeFile(join(folder, "relo-worker.toml"), mine);
  const out = await box.run(["setup", "--level", "optimize"]);
  assert.equal(out.exitCode, EXIT.OK, out.stdout.join("\n"));
  assert.equal(readFileSync(join(folder, "relo-worker.toml"), "utf8"), mine, "no marker, never touched");
  assert.ok(existsSync(join(folder, "relo-explore.toml")));
  // refresh re-renders a stale Relo file
  await writeFile(join(folder, "relo-explore.toml"), "# relo:managed relo-explore v0: old\nname = \"relo-explore\"\n");
  await box.run(["setup", "--refresh"]);
  assert.match(readFileSync(join(folder, "relo-explore.toml"), "utf8"), /model_reasoning_effort = "low"/u);
  // a shallower depth removes Relo's file and leaves the owner's
  await box.run(["setup", "--level", "guide"]);
  assert.equal(existsSync(join(folder, "relo-explore.toml")), false);
  assert.equal(readFileSync(join(folder, "relo-worker.toml"), "utf8"), mine);
});
