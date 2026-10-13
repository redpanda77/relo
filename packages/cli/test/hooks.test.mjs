import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ReloApiClient } from "../src/api-client.mjs";
import { EXIT, run } from "../src/cli.mjs";
import { setupWarnings } from "../src/doctor.mjs";
import { cardKey } from "../src/identity.mjs";
import { cardDependencies, fakeHome } from "./fake-cards.mjs";

const SESSION_ID = "9f2c1c34-5c0e-4d63-8a3a-7f1d3bd2c001";
const SECRET_PROMPT = "deploy to prod with password hunter2";

async function cli(argv, dependencies) {
  const stdout = [];
  const stderr = [];
  const exitCode = await run(argv, { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line), stdoutIsTTY: false }, dependencies);
  return { exitCode, stdout, stderr, line: stdout[0] ? JSON.parse(stdout[0]) : undefined };
}

/** A hook run against a fake server, a throwaway state folder and a clock that tests move. */
async function hookBox({ input, env = {}, fail, config = {} } = {}) {
  const state = await mkdtemp(join(tmpdir(), "relo-hook-state-"));
  const repo = await mkdtemp(join(tmpdir(), "relo-hook-repo-"));
  await mkdir(join(repo, ".git"));
  const box = { state, repo, sent: [], clock: 1_800_000_000_000, stored: [], stdin: undefined };
  box.stdin = input ?? { session_id: SESSION_ID, hook_event_name: "SessionStart", cwd: repo, transcript_path: "/Users/x/.claude/t.jsonl",
    prompt: SECRET_PROMPT, tool_name: "Bash", tool_input: { command: "cat ~/.ssh/id_rsa" }, tool_response: { stdout: "secret" } };
  const client = { sendAgentSessionEvent: async (body) => { if (fail) throw fail; box.sent.push(body); return { ok: true, state: "active" }; } };
  box.deps = () => ({
    ...cardDependencies(client, { env }),
    loadConfig: async () => ({ apiUrl: "https://relo.example", token: "x".repeat(44), ...config }),
    loadStoredConfig: async () => ({ apiUrl: "https://relo.example", token: "x".repeat(44), revision: "r1" }),
    writeConfig: async (_path, value) => { box.stored.push(value); },
    configPath: () => join(state, "config.json"),
    loadComputerName: () => undefined,
    hookStateDirectory: join(state, "hooks"),
    readStdinJson: async () => box.stdin,
    stdinIsTTY: false,
    computerName: () => "Studio Mac",
    home: state, cwd: repo,
    now: () => box.clock,
  });
  box.run = (argv) => cli(argv, box.deps());
  return box;
}

test("relo hook sends only the session facts: hashed id, event, project, computer, account and card key", async () => {
  const box = await hookBox();
  const out = await box.run(["hook", "start"]);
  assert.equal(out.exitCode, 0);
  assert.deepEqual(out.stdout, [], "a hook prints nothing: Claude Code injects stdout into the model's context");
  assert.deepEqual(out.stderr, []);
  assert.equal(box.sent.length, 1);
  const [body] = box.sent;
  assert.equal(body.session, createHash("sha256").update(`claude-code:${SESSION_ID}`).digest("base64url"));
  assert.match(body.session, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(body.harness, "claude-code");
  assert.equal(body.event, "start");
  assert.equal(body.at, new Date(box.clock).toISOString());
  assert.equal(body.project, box.repo.split("/").at(-1));
  assert.equal(body.computer, "Studio Mac");
  assert.equal(body.cardKey, cardKey({ env: { CLAUDE_CODE_SESSION_ID: SESSION_ID } }));
  assert.deepEqual(Object.keys(body).sort(), ["at", "cardKey", "computer", "event", "harness", "project", "session"]);
  const text = JSON.stringify(body);
  for (const forbidden of [SECRET_PROMPT, "hunter2", "id_rsa", "transcript", SESSION_ID, "Bash"]) {
    assert.equal(text.includes(forbidden), false, `${forbidden} must never be sent`);
  }
});

test("each Claude Code event name maps to Relo's, with or without the event argument", async () => {
  const names = { SessionStart: "start", UserPromptSubmit: "prompt", PostToolUse: "tool", Stop: "stop", SessionEnd: "end" };
  for (const [claude, event] of Object.entries(names)) {
    const byName = await hookBox({ input: { session_id: SESSION_ID, hook_event_name: claude, cwd: tmpdir() } });
    await byName.run(["hook"]);
    assert.equal(byName.sent[0]?.event, event, `${claude} from hook_event_name`);
    const byArgument = await hookBox({ input: { session_id: SESSION_ID, cwd: tmpdir() } });
    await byArgument.run(["hook", event]);
    assert.equal(byArgument.sent[0]?.event, event, `${event} from the argument`);
  }
});

test("tool events are coalesced to one a minute per session; other sessions and events are not", async () => {
  const box = await hookBox({ input: { session_id: SESSION_ID, hook_event_name: "PostToolUse", cwd: tmpdir() } });
  await box.run(["hook", "tool"]);
  box.clock += 30_000;
  await box.run(["hook", "tool"]);
  assert.equal(box.sent.length, 1, "a second tool event inside a minute is dropped");
  await box.run(["hook", "prompt"]);
  assert.equal(box.sent.length, 2, "only tool events are coalesced");
  box.stdin = { ...box.stdin, session_id: "another-session-id-0000" };
  await box.run(["hook", "tool"]);
  assert.equal(box.sent.length, 3, "another session has its own clock");
  box.stdin = { ...box.stdin, session_id: SESSION_ID };
  box.clock += 31_000;
  await box.run(["hook", "tool"]);
  assert.equal(box.sent.length, 4, "a minute later the next tool event goes through");
  await box.run(["hook", "end"]);
  assert.equal(box.sent.at(-1).event, "end");
});

test("a hook never fails and never prints, whatever goes wrong", async () => {
  const cases = {
    "server down": await hookBox({ fail: new Error("connect ECONNREFUSED") }),
    "no stdin session": await hookBox({ input: {} }),
    "unknown harness": await hookBox(),
    "not signed in": await hookBox(),
    "garbage event": await hookBox(),
  };
  cases["not signed in"].deps = ((make) => () => ({ ...make(), loadConfig: async () => { throw new Error("no config"); } }))(cases["not signed in"].deps);
  const argv = { "unknown harness": ["hook", "start", "--agent", "nope"], "garbage event": ["hook", "explode"] };
  for (const [name, box] of Object.entries(cases)) {
    const out = await box.run(argv[name] ?? ["hook", "start"]);
    assert.equal(out.exitCode, 0, name);
    assert.deepEqual(out.stdout, [], name);
    assert.deepEqual(out.stderr, [], name);
  }
  const broken = await hookBox();
  broken.deps = ((make) => () => ({ ...make(), readStdinJson: async () => { throw new Error("stdin is not JSON"); } }))(broken.deps);
  assert.equal((await broken.run(["hook", "start"])).exitCode, 0);
  const options = await hookBox();
  assert.equal((await options.run(["hook", "start", "--stdin", "--bogus"])).exitCode, 0, "even a bad flag exits 0");
});

test("RELO_DEBUG=1 logs the failure to a file in the state folder, never to stdout", async () => {
  const quiet = await hookBox({ fail: new Error("boom") });
  await quiet.run(["hook", "start"]);
  assert.equal(existsSync(join(quiet.state, "hooks", "hook-debug.log")), false);
  const loud = await hookBox({ fail: Object.assign(new Error("boom"), { code: "NETWORK_ERROR" }), env: { RELO_DEBUG: "1" } });
  const out = await loud.run(["hook", "start"]);
  assert.deepEqual(out.stdout, []);
  const log = await readFile(join(loud.state, "hooks", "hook-debug.log"), "utf8");
  assert.match(log, /NETWORK_ERROR: boom/u);
  assert.equal(log.includes(SECRET_PROMPT), false);
});

test("the computer name is cached in the config after the first hook, and RELO_COMPUTER wins", async () => {
  const first = await hookBox();
  await first.run(["hook", "start"]);
  assert.equal(first.stored.length, 1);
  assert.equal(first.stored[0].computerName, "Studio Mac");
  const cached = await hookBox({ config: { computerName: "Cached Name" } });
  cached.deps = ((make) => () => ({ ...make(), computerName: () => { throw new Error("scutil must not run"); } }))(cached.deps);
  await cached.run(["hook", "start"]);
  assert.equal(cached.sent[0].computer, "Cached Name");
  assert.equal(cached.stored.length, 0);
  const env = await hookBox({ env: { RELO_COMPUTER: "From Env" }, config: { computerName: "Cached Name" } });
  await env.run(["hook", "start"]);
  assert.equal(env.sent[0].computer, "From Env");
});

test("Claude hooks resolve the account like the card does (custom config folder name)", async () => {
  const box = await hookBox({ env: { CLAUDE_CONFIG_DIR: "/Users/x/.claude-work" } });
  box.deps = ((make) => () => ({ ...make(), home: "/Users/x" }))(box.deps);
  await box.run(["hook", "start"]);
  assert.equal(box.sent[0].account, "work");
});

test("Gemini CLI hooks map its event names and link a card only through RELO_SESSION", async () => {
  const names = { SessionStart: "start", BeforeAgent: "prompt", AfterTool: "tool", AfterAgent: "stop", SessionEnd: "end" };
  for (const [gemini, event] of Object.entries(names)) {
    const box = await hookBox({ input: { session_id: "gem-session-0123456789", hook_event_name: gemini, cwd: tmpdir() } });
    await box.run(["hook", "--agent", "gemini"]);
    assert.equal(box.sent[0]?.event, event, gemini);
    assert.equal(box.sent[0].harness, "gemini");
    assert.equal(box.sent[0].cardKey, undefined);
    assert.equal(box.sent[0].session, createHash("sha256").update("gemini:gem-session-0123456789").digest("base64url"));
  }
  const linked = await hookBox({ env: { RELO_SESSION: "shared-id" }, input: { session_id: "gem-session-0123456789", hook_event_name: "SessionStart", cwd: tmpdir() } });
  await linked.run(["hook", "start", "--agent", "gemini"]);
  assert.equal(linked.sent[0].cardKey, cardKey({ env: { RELO_SESSION: "shared-id" } }));
});

test("the client posts hooks to the sessions route with a 2 second ceiling and never retries a 429", async () => {
  const seen = [];
  const client = new ReloApiClient({ apiUrl: "https://relo.example", token: "x".repeat(44), sleep: async () => { throw new Error("must not sleep"); },
    fetchImpl: async (url, init) => { seen.push({ url: String(url), init }); return Response.json({ error: "rate_limited", retryAfterSeconds: 1 }, { status: 429, headers: { "retry-after": "1" } }); } });
  await assert.rejects(client.sendAgentSessionEvent({ session: "s".repeat(43), harness: "claude-code", event: "start" }), (error) => error.status === 429);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://relo.example/api/agent-sessions/events");
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].init.headers["idempotency-key"], undefined);
  assert.ok(seen[0].init.signal instanceof AbortSignal);
});

// ---- relo sessions --------------------------------------------------------------------------------

test("relo sessions prints a compact list", async () => {
  const sessions = [{ id: "ags_11111111-1111-4111-8111-111111111111", harness: "claude-code", computer: "Studio", account: null, project: "relo",
    state: "active", startedAt: "2026-10-13T10:00:00Z", lastEventAt: "2026-10-13T10:05:00Z", presence: "quiet",
    card: { id: "act_11111111-1111-4111-8111-111111111111", state: "active", quietForSeconds: 840 } },
  { id: "ags_22222222-2222-4222-8222-222222222222", harness: "gemini", computer: null, account: "work", project: null,
    state: "active", startedAt: "2026-10-13T10:00:00Z", lastEventAt: "2026-10-13T10:06:00Z", presence: "no_card", card: null }];
  const deps = cardDependencies({ listAgentSessions: async () => ({ sessions }) });
  const out = await cli(["sessions"], deps);
  assert.equal(out.exitCode, EXIT.OK);
  assert.deepEqual(out.line, { ok: true, sessions: [
    { harness: "claude-code", computer: "Studio", project: "relo", presence: "quiet", lastEventAt: "2026-10-13T10:05:00Z", card: { state: "active", quietForSeconds: 840 } },
    { harness: "gemini", account: "work", presence: "no_card", lastEventAt: "2026-10-13T10:06:00Z" },
  ] });
  assert.equal((await cli(["sessions", "extra"], deps)).exitCode, EXIT.USAGE);
});

// ---- relo setup --hooks ---------------------------------------------------------------------------

const EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"];
const stringify = (value) => `${JSON.stringify(value, null, 2)}\n`;

async function setupBox(options) {
  const home = await fakeHome({ agents: [], ...options });
  const cwd = await mkdtemp(join(tmpdir(), "relo-hooks-cwd-"));
  await mkdir(join(cwd, ".git"));
  const deps = { ...cardDependencies({}), home, cwd, env: {} };
  return { home, cwd, deps, run: (argv, extra = {}) => cli(argv, { ...deps, ...extra }),
    global: join(home, ".claude", "settings.json"), project: join(cwd, ".claude", "settings.json") };
}

test("--global --agent claude-code --hooks writes one marked entry per event", async () => {
  const box = await setupBox();
  const out = await box.run(["setup", "--global", "--agent", "claude-code", "--hooks"]);
  assert.equal(out.exitCode, EXIT.OK);
  assert.deepEqual(out.line, { ok: true, file: "~/.claude/settings.json", action: "created", hooks: EVENTS });
  const written = JSON.parse(await readFile(box.global, "utf8"));
  assert.deepEqual(Object.keys(written.hooks), EVENTS);
  assert.deepEqual(written.hooks.PostToolUse, [{ hooks: [{ type: "command", command: "relo hook tool", timeout: 5 }] }]);
  for (const [name, event] of [["SessionStart", "start"], ["UserPromptSubmit", "prompt"], ["Stop", "stop"], ["SessionEnd", "end"]]) {
    assert.equal(written.hooks[name][0].hooks[0].command, `relo hook ${event}`);
    assert.equal(written.hooks[name][0].hooks[0].timeout, 5);
  }
  const again = await box.run(["setup", "--global", "--agent", "claude-code", "--hooks"]);
  assert.equal(again.line.action, "unchanged");
  assert.equal(await readFile(box.global, "utf8"), stringify(written));
});

test("--project --hooks writes <repo>/.claude/settings.json; CLAUDE_CONFIG_DIR moves the global file", async () => {
  const box = await setupBox();
  const project = await box.run(["setup", "--project", "--hooks"]);
  assert.equal(project.line.action, "created");
  assert.equal(existsSync(box.project), true);
  assert.equal(existsSync(box.global), false);
  const other = await setupBox();
  const custom = join(other.home, "cc");
  const out = await other.run(["setup", "--global", "--agent", "claude-code", "--hooks"], { env: { CLAUDE_CONFIG_DIR: custom } });
  assert.equal(out.line.file, "~/cc/settings.json");
  assert.equal(existsSync(join(custom, "settings.json")), true);
});

test("setup --hooks keeps everything else, and --remove restores the file exactly", async () => {
  const box = await setupBox();
  const original = stringify({
    model: "opus",
    permissions: { allow: ["Bash(npm test)"] },
    hooks: {
      PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "prettier --write", timeout: 10 }] }],
      Notification: [{ hooks: [{ type: "command", command: "say done" }] }],
    },
    env: { A: "1" },
  });
  await mkdir(join(box.home, ".claude"), { recursive: true });
  await writeFile(box.global, original);
  const added = await box.run(["setup", "--global", "--agent", "claude-code", "--hooks"]);
  assert.equal(added.line.action, "updated");
  const settings = JSON.parse(await readFile(box.global, "utf8"));
  assert.deepEqual(Object.keys(settings), ["model", "permissions", "hooks", "env"], "key order kept");
  assert.equal(settings.hooks.PostToolUse.length, 2, "the other PostToolUse hook is still there");
  assert.equal(settings.hooks.PostToolUse[0].hooks[0].command, "prettier --write");
  assert.deepEqual(settings.hooks.Notification, [{ hooks: [{ type: "command", command: "say done" }] }]);
  const removed = await box.run(["setup", "--hooks", "--remove"]);
  assert.deepEqual(removed.line, { ok: true, file: "~/.claude/settings.json", action: "removed", hooks: EVENTS });
  assert.equal(await readFile(box.global, "utf8"), original, "byte for byte");
  assert.equal((await box.run(["setup", "--hooks", "--remove"])).line.action, "unchanged");
});

test("--remove deletes a settings file that held only Relo's hooks, and a user hook in a shared group survives", async () => {
  const box = await setupBox();
  await box.run(["setup", "--global", "--agent", "claude-code", "--hooks"]);
  await box.run(["setup", "--hooks", "--remove"]);
  assert.equal(existsSync(box.global), false);
  await mkdir(join(box.home, ".claude"), { recursive: true });
  const shared = stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "relo hook stop", timeout: 5 }, { type: "command", command: "mine" }] }] } });
  await writeFile(box.global, shared);
  await box.run(["setup", "--hooks", "--remove"]);
  assert.deepEqual(JSON.parse(await readFile(box.global, "utf8")), { hooks: { Stop: [{ hooks: [{ type: "command", command: "mine" }] }] } });
});

test("a stale Relo hook is updated in place and 4-space or CRLF formatting is kept", async () => {
  const box = await setupBox();
  await mkdir(join(box.home, ".claude"), { recursive: true });
  const old = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "relo hook stop", timeout: 60 }] }] } }, null, 4).replaceAll("\n", "\r\n");
  await writeFile(box.global, old);
  const out = await box.run(["setup", "--global", "--agent", "claude-code", "--hooks"]);
  assert.equal(out.line.action, "updated");
  const text = await readFile(box.global, "utf8");
  assert.equal(text.includes("\r\n    \"hooks\""), true);
  assert.equal(JSON.parse(text).hooks.Stop[0].hooks[0].timeout, 5);
  assert.equal(JSON.parse(text).hooks.Stop.length, 1, "no duplicate group");
  assert.equal(text.endsWith("}"), true, "no trailing newline was invented");
});

test("hooks live in one place: the other location refuses, --move relocates, --dry-run writes nothing", async () => {
  const box = await setupBox();
  await box.run(["setup", "--global", "--agent", "claude-code", "--hooks"]);
  const refused = await box.run(["setup", "--project", "--hooks"]);
  assert.equal(refused.exitCode, EXIT.USAGE);
  assert.match(refused.line.error.message, /already set up in ~\/\.claude\/settings\.json/u);
  assert.match(refused.line.error.hint, /--move/u);
  assert.equal(existsSync(box.project), false);
  const dry = await box.run(["setup", "--project", "--hooks", "--move", "--dry-run"]);
  assert.equal(dry.line.dryRun, true);
  assert.equal(existsSync(box.project), false);
  assert.equal(existsSync(box.global), true);
  const moved = await box.run(["setup", "--project", "--hooks", "--move"]);
  assert.equal(moved.line.action, "moved");
  assert.equal(moved.line.from, "~/.claude/settings.json");
  assert.equal(existsSync(box.global), false);
  assert.equal(existsSync(box.project), true);
});

test("setup --hooks refuses unsupported harnesses, unreadable JSON and missing choices, leaving files alone", async () => {
  const box = await setupBox();
  const codex = await box.run(["setup", "--global", "--agent", "codex", "--hooks"]);
  assert.equal(codex.exitCode, EXIT.USAGE);
  assert.match(codex.line.error.message, /Hooks are available for claude-code and gemini/u);
  assert.match(codex.line.error.hint, /go stale on their own/u);
  assert.equal((await box.run(["setup", "--hooks"])).exitCode, EXIT.USAGE);
  assert.equal((await box.run(["setup", "--global", "--hooks"])).exitCode, EXIT.USAGE);
  assert.equal((await box.run(["setup", "--file", "x.json", "--hooks"])).exitCode, EXIT.USAGE);
  await mkdir(join(box.home, ".claude"), { recursive: true });
  await writeFile(box.global, "{ // comment\n}\n");
  const bad = await box.run(["setup", "--global", "--agent", "claude-code", "--hooks"]);
  assert.equal(bad.exitCode, EXIT.USAGE);
  assert.match(bad.line.error.message, /not plain JSON/u);
  assert.equal(await readFile(box.global, "utf8"), "{ // comment\n}\n");
  assert.equal(existsSync(join(box.home, ".codex")), false);
});

test("Gemini CLI hooks go in its settings.json with millisecond timeouts and --agent gemini", async () => {
  const box = await setupBox();
  const out = await box.run(["setup", "--global", "--agent", "gemini", "--hooks"]);
  assert.deepEqual(out.line, { ok: true, file: "~/.gemini/settings.json", action: "created",
    hooks: ["SessionStart", "BeforeAgent", "AfterTool", "AfterAgent", "SessionEnd"] });
  const settings = JSON.parse(await readFile(join(box.home, ".gemini", "settings.json"), "utf8"));
  assert.deepEqual(settings.hooks.AfterAgent, [{ hooks: [{ type: "command", command: "relo hook stop --agent gemini", timeout: 5000 }] }]);
  const project = await box.run(["setup", "--project", "--agent", "gemini", "--hooks"]);
  assert.equal(project.exitCode, EXIT.USAGE, "gemini hooks are in one place too");
  assert.equal((await box.run(["setup", "--hooks", "--remove"])).line.action, "removed");
  assert.equal(existsSync(join(box.home, ".gemini", "settings.json")), false);
});

test("doctor --full reports hooks informationally: where and which events, never a suggestion", async () => {
  const box = await setupBox();
  const none = setupWarnings({ env: {}, home: box.home, cwd: box.cwd, version: "0.10.0" });
  assert.deepEqual(none.hooks, { ok: true, state: "none" });
  await box.run(["setup", "--project", "--hooks"]);
  const set = setupWarnings({ env: {}, home: box.home, cwd: box.cwd, version: "0.10.0" });
  assert.equal(set.hooks.ok, true);
  assert.equal(set.hooks.state, "set");
  assert.deepEqual(set.hooks.files[0].events, EVENTS);
  assert.equal(JSON.stringify(none).includes("--hooks"), false);
});

// ---- hooks are optional: nothing depends on them -----------------------------------------------------

test("a full start, update, ask, end flow with no hooks installed makes no session-event request", async () => {
  const { fakeCards } = await import("./fake-cards.mjs");
  const fake = fakeCards({ answer: "approved" });
  fake.client.sendNotification = async () => ({ eventId: "ntf_1", delivery: { eligibleDevices: 1, durableCommands: 1, apnsJobs: 1 } });
  const requested = [];
  const client = new Proxy(fake.client, { get: (target, name) => { requested.push(String(name)); return target[name]; } });
  const box = await setupBox();
  const deps = { ...cardDependencies(client), home: box.home, cwd: box.cwd, env: {} };
  const topic = ["--topic", "Release 0.7.57"];
  const step = async (argv) => { const out = await cli(argv, deps); assert.equal(out.exitCode, EXIT.OK, JSON.stringify(out.line)); };
  await step(["activity", "start", "--title", "Deploy", "--status", "Building", "--steps", "A,B", ...topic]);
  await step(["activity", "update", "--status", "Testing", ...topic]);
  await step(["ask", "Deploy?", "--approval", ...topic]);
  await step(["notify", "Done", ...topic]);
  await step(["activity", "end", "--status", "Live", "--name", fake.calls[0].body.key]);
  assert.ok(requested.length > 4, "the flow really ran");
  assert.deepEqual(requested.filter((name) => /session/iu.test(name)), [], "no session event or session list was requested");
  // setup without --hooks writes no hooks, and doctor never suggests them.
  await cli(["setup", "--project"], deps);
  await cli(["setup", "--global", "--agent", "claude-code"], deps);
  assert.equal(existsSync(box.project), false);
  assert.equal(existsSync(box.global), false);
  assert.equal(existsSync(join(box.home, ".gemini", "settings.json")), false);
});

test("doctor never suggests hooks: the compact line has no hooks, and --full only reports them", async () => {
  const healthy = { ready: async () => ({ ready: true }), doctor: async () => ({ version: 1, ok: true }), listDevices: async () => ({ hasMore: false, cursor: null,
    devices: [{ deviceId: "dev_abcdefghijkl", liveActivityAuthorization: "authorized" }] }),
  authStatus: async () => ({ authenticated: true, credential: { id: "c", clientName: "Studio", prefix: "p", expiresAt: "2027-01-01T00:00:00Z",
    scopes: ["activities:read", "activities:write", "devices:read", "interactions:create", "interactions:read", "notifications:send"] } }) };
  const box = await setupBox();
  const deps = { ...cardDependencies(healthy), home: box.home, cwd: box.cwd, env: {},
    loadConfig: async () => ({ apiUrl: "https://relo.example", token: "x".repeat(44), source: "environment" }) };
  const compact = await cli(["doctor"], deps);
  assert.equal(JSON.stringify(compact.line).toLowerCase().includes("hook"), false);
  const full = await cli(["doctor", "--full"], deps);
  assert.equal(full.line.data.warnings.hooks.state, "none");
  assert.equal(JSON.stringify(full.line.data.next ?? {}).toLowerCase().includes("hook"), false);
});

test("relo hook against an older server (404 or 400) or an offline one is silent, exits 0 and sends exactly once", async () => {
  for (const respond of [() => Response.json({ error: "not_found" }, { status: 404 }), () => Response.json({ error: "invalid_request" }, { status: 400 }),
    () => { throw new TypeError("fetch failed"); }, () => Response.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": "1" } })]) {
    const state = await mkdtemp(join(tmpdir(), "relo-hook-old-"));
    let requests = 0;
    const slept = [];
    const out = await cli(["hook", "start"], {
      loadConfig: async () => ({ apiUrl: "https://relo.example", token: "x".repeat(44) }),
      fetchImpl: async () => { requests += 1; return respond(); },
      readStdinJson: async () => ({ session_id: SESSION_ID, hook_event_name: "SessionStart", cwd: tmpdir() }),
      stdinIsTTY: false, env: {}, hookStateDirectory: join(state, "hooks"), computerName: () => "Studio", loadComputerName: () => undefined,
      loadStoredConfig: async () => { throw new Error("no file"); }, configPath: () => join(state, "c.json"),
      sleep: async (ms) => { slept.push(ms); },
    });
    assert.equal(out.exitCode, 0);
    assert.deepEqual(out.stdout, []);
    assert.deepEqual(out.stderr, []);
    assert.equal(requests, 1, "no retry");
    assert.deepEqual(slept, [], "never waits");
  }
});

test("a server without the sessions API: relo sessions says so, relo hook stays silent", async () => {
  const notFound = () => Response.json({ error: "not_found" }, { status: 404 });
  const deps = { loadConfig: async () => ({ apiUrl: "https://relo.example", token: "x".repeat(44) }), fetchImpl: async () => notFound(), env: {} };
  const out = await cli(["sessions"], deps);
  assert.equal(out.exitCode, EXIT.API);
  assert.deepEqual(out.line, { ok: false, error: { code: "SESSIONS_UNSUPPORTED", message: "This Relo server doesn't report agent sessions yet.",
    hint: "Update the server to 0.10.0 or later." } });
  const state = await mkdtemp(join(tmpdir(), "relo-hook-404-"));
  const hook = await cli(["hook", "start"], { ...deps, readStdinJson: async () => ({ session_id: SESSION_ID, cwd: tmpdir() }), stdinIsTTY: false,
    hookStateDirectory: join(state, "hooks"), computerName: () => "S", loadComputerName: () => undefined, loadStoredConfig: async () => { throw new Error("x"); },
    configPath: () => join(state, "c.json") });
  assert.equal(hook.exitCode, 0);
  assert.deepEqual(hook.stdout, []);
});
