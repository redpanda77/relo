import "./hermetic-env.mjs";
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
import { cardDependencies, fakeHome } from "./fake-cards.mjs";

const SESSION_ID = "9f2c1c34-5c0e-4d63-8a3a-7f1d3bd2c001";
const SECRET_PROMPT = "deploy to prod with password hunter2";

async function cli(argv, dependencies) {
  const stdout = [];
  const stderr = [];
  const exitCode = await run(argv, { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line), stdoutIsTTY: false }, dependencies);
  return { exitCode, stdout, stderr, line: stdout[0] ? JSON.parse(stdout[0]) : undefined };
}

// ---- relo sessions --------------------------------------------------------------------------------

test("relo sessions prints a compact list", async () => {
  const sessions = [{ id: "ags_11111111-1111-4111-8111-111111111111", harness: "claude-code", computer: "Studio", account: null, project: "relo",
    phase: "working", waitingFor: null, startedAt: "2026-10-13T10:00:00Z", lastSeenAt: "2026-10-13T10:05:00Z", presence: "quiet",
    card: { id: "act_11111111-1111-4111-8111-111111111111", state: "active", quietForSeconds: 840 } },
  { id: "ags_22222222-2222-4222-8222-222222222222", harness: "gemini", computer: null, account: "work", project: null,
    phase: "waiting", waitingFor: "turn", startedAt: "2026-10-13T10:00:00Z", lastSeenAt: "2026-10-13T10:06:00Z", presence: "no_card", card: null }];
  const deps = cardDependencies({ listAgentSessions: async () => ({ sessions }) });
  const out = await cli(["sessions"], deps);
  assert.equal(out.exitCode, EXIT.OK);
  assert.deepEqual(out.line, { ok: true, sessions: [
    { harness: "claude-code", computer: "Studio", project: "relo", phase: "working", presence: "quiet", lastSeenAt: "2026-10-13T10:05:00Z", card: { state: "active", quietForSeconds: 840 } },
    { harness: "gemini", account: "work", phase: "waiting", waitingFor: "turn", presence: "no_card", lastSeenAt: "2026-10-13T10:06:00Z" },
  ] });
  assert.equal((await cli(["sessions", "extra"], deps)).exitCode, EXIT.USAGE);
});

test("relo sessions shows phases and counts; --live asks the server for working and waiting only", async () => {
  const counts = { working: 1, waiting: 1, idle: 4, ended: 2 };
  const asked = [];
  const sessions = [
    { harness: "claude-code", project: "relo", phase: "working", presence: "no_card", lastSeenAt: "2026-10-13T10:05:00Z", card: null },
    { harness: "claude-code", project: "relo", phase: "waiting", waitingFor: "input", presence: "no_card", lastSeenAt: "2026-10-13T10:04:00Z", card: null },
  ];
  const deps = cardDependencies({ listAgentSessions: async (options) => { asked.push(options); return { sessions, counts }; } });
  const out = await cli(["sessions", "--live"], deps);
  assert.equal(out.exitCode, EXIT.OK);
  assert.deepEqual(asked, [{ phases: ["working", "waiting"] }]);
  assert.deepEqual(out.line.counts, counts);
  assert.deepEqual(out.line.sessions.map((session) => session.phase), ["working", "waiting"]);
  await cli(["sessions"], deps);
  assert.deepEqual(asked.at(-1), {});
});

test("the API client sends ?phase= only when asked", async () => {
  const urls = [];
  const client = new ReloApiClient({ apiUrl: "https://relo.example", token: "x".repeat(44),
    fetchImpl: async (url) => { urls.push(String(url)); return Response.json({ sessions: [], counts: {} }); } });
  await client.listAgentSessions();
  await client.listAgentSessions({ phases: ["working", "waiting"] });
  assert.deepEqual(urls.map((url) => new URL(url).search), ["", "?phase=working%2Cwaiting"]);
});

// ---- relo setup --hooks <off|reminders|presence> ---------------------------------------------------

const EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "SubagentStart", "SubagentStop", "PreCompact", "Stop", "SessionEnd"];
const PRESENCE_EVENTS = [...EVENTS].sort();
const WAIT_MATCHER = "permission_prompt|elicitation_dialog|elicitation_url_dialog|agent_needs_input";
const stringify = (value) => `${JSON.stringify(value, null, 2)}\n`;
/** The one group per event that carries a given Relo hook role. */
const reloGroup = (settings, event, role) => settings.hooks[event].filter((group) => group.hooks.some((hook) => hook.command === `relo hook ${role}`));

async function setupBox(options) {
  const home = await fakeHome({ agents: [], ...options });
  const cwd = await mkdtemp(join(tmpdir(), "relo-hooks-cwd-"));
  await mkdir(join(cwd, ".git"));
  const deps = { ...cardDependencies({}), home, cwd, env: {} };
  return { home, cwd, deps, run: (argv, extra = {}) => cli(argv, { ...deps, ...extra }),
    global: join(home, ".claude", "settings.json"), project: join(cwd, ".claude", "settings.json") };
}

test("--global --agent claude-code --hooks presence writes one marked async entry per presence event", async () => {
  const box = await setupBox();
  const out = await box.run(["setup", "--global", "--agent", "claude-code", "--hooks", "presence"]);
  assert.equal(out.exitCode, EXIT.OK);
  assert.deepEqual(out.line, { ok: true, file: "~/.claude/settings.json", action: "created", hooks: PRESENCE_EVENTS, harnessCredential: "pending" },
    "the server could not mint the harness credential: the flusher will");
  const written = JSON.parse(await readFile(box.global, "utf8"));
  assert.deepEqual(Object.keys(written.hooks).sort(), PRESENCE_EVENTS);
  assert.deepEqual(reloGroup(written, "PostToolUse", "tool-end"), [{ hooks: [{ type: "command", command: "relo hook tool-end", async: true }] }]);
  assert.deepEqual(reloGroup(written, "PreToolUse", "tool-start"), [{ matcher: "Bash|Agent|Task", hooks: [{ type: "command", command: "relo hook tool-start", async: true }] }],
    "only the tools that run long open a tool");
  assert.deepEqual(reloGroup(written, "Notification", "wait"), [{ matcher: WAIT_MATCHER, hooks: [{ type: "command", command: "relo hook wait", async: true }] }],
    "only prompts that block on the owner run the hook");
  for (const [name, event] of [["SessionStart", "start"], ["UserPromptSubmit", "prompt"], ["Stop", "stop"], ["SubagentStart", "subagent-start"],
    ["SubagentStop", "subagent-stop"], ["PreCompact", "compact"]]) {
    assert.deepEqual(reloGroup(written, name, event), [{ hooks: [{ type: "command", command: `relo hook ${event}`, async: true }] }], `${name} never blocks the agent`);
  }
  assert.deepEqual(reloGroup(written, "SessionEnd", "end"), [{ hooks: [{ type: "command", command: "relo hook end", timeout: 3 }] }],
    "SessionEnd is synchronous with a short ceiling (the process is exiting)");
  const again = await box.run(["setup", "--global", "--agent", "claude-code", "--hooks", "presence"]);
  assert.equal(again.line.action, "unchanged");
  assert.equal(await readFile(box.global, "utf8"), stringify(written));
  assert.equal((await box.run(["hooks", "status"])).line.data.level, "presence");
});

test("--project --hooks presence writes <repo>/.claude/settings.json; CLAUDE_CONFIG_DIR moves the global file", async () => {
  const box = await setupBox();
  const project = await box.run(["setup", "--project", "--hooks", "presence"]);
  assert.equal(project.line.action, "created");
  assert.equal(existsSync(box.project), true);
  assert.equal(existsSync(box.global), false);
  const other = await setupBox();
  const custom = join(other.home, "cc");
  const out = await other.run(["setup", "--global", "--agent", "claude-code", "--hooks", "presence"], { env: { CLAUDE_CONFIG_DIR: custom } });
  assert.equal(out.line.file, "~/cc/settings.json");
  assert.equal(existsSync(join(custom, "settings.json")), true);
});

test("setup --hooks presence keeps everything else, and --hooks off restores the file exactly", async () => {
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
  const added = await box.run(["setup", "--global", "--agent", "claude-code", "--hooks", "presence"]);
  assert.equal(added.line.action, "updated");
  const settings = JSON.parse(await readFile(box.global, "utf8"));
  assert.deepEqual(Object.keys(settings), ["model", "permissions", "hooks", "env"], "key order kept");
  assert.deepEqual(settings.hooks.PostToolUse[0], { matcher: "Edit|Write", hooks: [{ type: "command", command: "prettier --write", timeout: 10 }] },
    "the other PostToolUse hook is still there, first");
  assert.equal(reloGroup(settings, "PostToolUse", "tool-end").length, 1);
  assert.deepEqual(settings.hooks.Notification, [{ hooks: [{ type: "command", command: "say done" }] },
    { matcher: WAIT_MATCHER, hooks: [{ type: "command", command: "relo hook wait", async: true }] }], "the owner's own group is untouched");
  const removed = await box.run(["setup", "--hooks", "off"]);
  assert.equal(removed.line.action, "removed");
  assert.equal(removed.line.file, "~/.claude/settings.json");
  assert.equal(await readFile(box.global, "utf8"), original, "byte for byte");
  assert.equal((await box.run(["setup", "--hooks", "off"])).line.action, "unchanged");
  assert.equal((await box.run(["hooks", "status"])).line.data.level, "off");
});

test("--hooks off deletes a settings file that held only Relo's hooks, and a user hook in a shared group survives", async () => {
  const box = await setupBox();
  await box.run(["setup", "--global", "--agent", "claude-code", "--hooks", "presence"]);
  await box.run(["setup", "--hooks", "off"]);
  assert.equal(existsSync(box.global), false);
  await mkdir(join(box.home, ".claude"), { recursive: true });
  const shared = stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "relo hook stop", async: true }, { type: "command", command: "mine" }] }] } });
  await writeFile(box.global, shared);
  await box.run(["setup", "--hooks", "off"]);
  assert.deepEqual(JSON.parse(await readFile(box.global, "utf8")), { hooks: { Stop: [{ hooks: [{ type: "command", command: "mine" }] }] } });
  // relo hooks off does the same from the hooks group.
  await writeFile(box.global, shared);
  const off = await box.run(["hooks", "off"]);
  assert.deepEqual(off.line.data, { action: "removed", level: "off", files: ["~/.claude/settings.json"] });
  assert.deepEqual(JSON.parse(await readFile(box.global, "utf8")), { hooks: { Stop: [{ hooks: [{ type: "command", command: "mine" }] }] } });
  assert.equal((await box.run(["hooks", "off"])).line.data.action, "unchanged");
});

test("a stale synchronous Relo hook is replaced by the async one and 4-space or CRLF formatting is kept", async () => {
  const box = await setupBox();
  await mkdir(join(box.home, ".claude"), { recursive: true });
  const old = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "relo hook stop", timeout: 60 }] }] } }, null, 4).replaceAll("\n", "\r\n");
  await writeFile(box.global, old);
  assert.equal((await box.run(["hooks", "status"])).line.data.files[0].level, "legacy");
  const out = await box.run(["setup", "--global", "--agent", "claude-code", "--hooks", "presence"]);
  assert.equal(out.line.action, "updated");
  const text = await readFile(box.global, "utf8");
  assert.equal(text.includes("\r\n    \"hooks\""), true);
  assert.deepEqual(reloGroup(JSON.parse(text), "Stop", "stop"), [{ hooks: [{ type: "command", command: "relo hook stop", async: true }] }], "no duplicate, no stale timeout");
  assert.equal(text.endsWith("}"), true, "no trailing newline was invented");
});

test("hooks live in one place: the other location refuses, --move relocates, --dry-run writes nothing", async () => {
  const box = await setupBox();
  await box.run(["setup", "--global", "--agent", "claude-code", "--hooks", "presence"]);
  const refused = await box.run(["setup", "--project", "--hooks", "presence"]);
  assert.equal(refused.exitCode, EXIT.USAGE);
  assert.match(refused.line.error.message, /already set up in ~\/\.claude\/settings\.json/u);
  assert.match(refused.line.error.hint, /--move/u);
  assert.equal(existsSync(box.project), false);
  const dry = await box.run(["setup", "--project", "--hooks", "presence", "--move", "--dry-run"]);
  assert.equal(dry.line.dryRun, true);
  assert.equal(existsSync(box.project), false);
  assert.equal(existsSync(box.global), true);
  const moved = await box.run(["setup", "--project", "--hooks", "presence", "--move"]);
  assert.equal(moved.line.action, "moved");
  assert.equal(moved.line.from, "~/.claude/settings.json");
  assert.equal(existsSync(box.global), false);
  assert.equal(existsSync(box.project), true);
});

test("setup --hooks refuses a missing level, the removed --remove, unsupported harnesses, unreadable JSON and missing choices, leaving files alone", async () => {
  const box = await setupBox();
  const bare = await box.run(["setup", "--project", "--hooks"]);
  assert.equal(bare.exitCode, EXIT.USAGE);
  assert.match(bare.line.error.message, /--hooks needs a level: off, reminders or presence/u);
  assert.equal((await box.run(["setup", "--hooks"])).exitCode, EXIT.USAGE);
  assert.equal((await box.run(["setup", "--project", "--hooks", "everything"])).exitCode, EXIT.USAGE);
  const gone = await box.run(["setup", "--hooks", "--remove"]);
  assert.equal(gone.exitCode, EXIT.USAGE);
  assert.match(gone.line.error.message, /relo setup --hooks off/u);
  const codex = await box.run(["setup", "--global", "--agent", "codex", "--hooks", "presence"]);
  assert.equal(codex.exitCode, EXIT.USAGE);
  assert.match(codex.line.error.message, /Hooks are available for claude-code and gemini/u);
  assert.match(codex.line.error.hint, /go stale on their own/u);
  const nowhere = await box.run(["setup", "--hooks", "presence"]);
  assert.equal(nowhere.exitCode, EXIT.USAGE);
  assert.match(nowhere.line.error.message, /Nothing was written/u);
  assert.equal((await box.run(["setup", "--project", "--global", "--hooks", "presence"])).exitCode, EXIT.USAGE);
  assert.equal((await box.run(["setup", "--file", "x.json", "--hooks", "presence"])).exitCode, EXIT.USAGE);
  assert.equal(existsSync(box.project), false);
  assert.equal(existsSync(box.global), false);
  await mkdir(join(box.home, ".claude"), { recursive: true });
  await writeFile(box.global, "{ // comment\n}\n");
  const bad = await box.run(["setup", "--global", "--agent", "claude-code", "--hooks", "presence"]);
  assert.equal(bad.exitCode, EXIT.USAGE);
  assert.match(bad.line.error.message, /not plain JSON/u);
  assert.equal(await readFile(box.global, "utf8"), "{ // comment\n}\n");
  assert.equal(existsSync(join(box.home, ".codex")), false);
});

test("Gemini CLI hooks go in its settings.json with millisecond timeouts and --agent gemini; presence or off only", async () => {
  const box = await setupBox();
  const reminders = await box.run(["setup", "--global", "--agent", "gemini", "--hooks", "reminders"]);
  assert.equal(reminders.exitCode, EXIT.USAGE);
  assert.match(reminders.line.error.message, /only --hooks presence or --hooks off/u);
  const out = await box.run(["setup", "--global", "--agent", "gemini", "--hooks", "presence"]);
  assert.deepEqual(out.line, { ok: true, file: "~/.gemini/settings.json", action: "created",
    hooks: ["AfterAgent", "AfterTool", "BeforeAgent", "Notification", "PreCompress", "SessionEnd", "SessionStart"], harnessCredential: "pending" });
  const settings = JSON.parse(await readFile(join(box.home, ".gemini", "settings.json"), "utf8"));
  assert.deepEqual(settings.hooks.AfterAgent, [{ hooks: [{ type: "command", command: "relo hook stop --agent gemini", timeout: 5000 }] }]);
  const project = await box.run(["setup", "--project", "--agent", "gemini", "--hooks", "presence"]);
  assert.equal(project.exitCode, EXIT.USAGE, "gemini hooks are in one place too");
  assert.equal((await box.run(["setup", "--hooks", "off"])).line.action, "removed");
  assert.equal(existsSync(join(box.home, ".gemini", "settings.json")), false);
});

test("doctor --full reports hooks informationally: where and which events, never a suggestion", async () => {
  const box = await setupBox();
  const none = setupWarnings({ env: {}, home: box.home, cwd: box.cwd, version: "0.10.0" });
  assert.deepEqual(none.hooks, { ok: true, state: "none" });
  await box.run(["setup", "--project", "--hooks", "presence"]);
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
  await step(["activity", "start", "--title", "Deploy", "--status", "Building", "--steps", "Build image,Ship it", ...topic]);
  await step(["activity", "update", "--status", "Testing", ...topic]);
  await step(["ask", "Deploy?", "--approval", ...topic]);
  await step(["notify", "Done", ...topic]);
  await step(["activity", "end", "--status", "Live", "--name", fake.calls.find((call) => call.op === "start").body.key]);
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

test("a server without the sessions API: relo sessions says so, relo hook stays silent", async () => {
  const notFound = () => Response.json({ error: "not_found" }, { status: 404 });
  const deps = { loadConfig: async () => ({ apiUrl: "https://relo.example", token: "x".repeat(44) }), fetchImpl: async () => notFound(), env: {} };
  const out = await cli(["sessions"], deps);
  assert.equal(out.exitCode, EXIT.API);
  assert.deepEqual(out.line, { ok: false, error: { code: "SESSIONS_UNSUPPORTED", message: "This Relo server doesn't report sessions yet.",
    hint: "Update the server to 0.10.0 or later." } });
  const state = await mkdtemp(join(tmpdir(), "relo-hook-404-"));
  const hook = await cli(["hook", "start"], { ...deps, readStdinJson: async () => ({ session_id: SESSION_ID, cwd: tmpdir() }), stdinIsTTY: false,
    hookStateDirectory: join(state, "hooks"), computerName: () => "S", loadComputerName: () => undefined, loadStoredConfig: async () => { throw new Error("x"); },
    configPath: () => join(state, "c.json") });
  assert.equal(hook.exitCode, 0);
  assert.deepEqual(hook.stdout, []);
});

test("setup --hooks presence puts Relo's matcher on its own Notification group, never on a shared one", async () => {
  const box = await setupBox();
  await mkdir(join(box.home, ".claude"), { recursive: true });
  await writeFile(box.global, stringify({ hooks: {
    Notification: [{ hooks: [{ type: "command", command: "relo hook wait", timeout: 5 }] }],
    Stop: [{ matcher: "", hooks: [{ type: "command", command: "relo hook stop", timeout: 5 }, { type: "command", command: "mine" }] }],
  } }));
  assert.equal((await box.run(["setup", "--global", "--agent", "claude-code", "--hooks", "presence"])).line.action, "updated");
  const settings = JSON.parse(await readFile(box.global, "utf8"));
  assert.deepEqual(settings.hooks.Notification, [{ matcher: WAIT_MATCHER, hooks: [{ type: "command", command: "relo hook wait", async: true }] }]);
  assert.deepEqual(settings.hooks.Stop[0], { matcher: "", hooks: [{ type: "command", command: "mine" }] }, "a shared group keeps the owner's matcher and hook");
  assert.equal(reloGroup(settings, "Stop", "stop").length, 1, "Relo's stop lives in its own group");
});

test("presence mints this computer's harness credential with the CLI credential; reminders does not; off revokes it", async () => {
  const box = await setupBox();
  const credentialPath = join(box.home, "harness-credential");
  const calls = [];
  const client = { createHarnessCredential: async (body) => { calls.push(["mint", body]); return { id: "hcr_1", token: "h".repeat(44) }; },
    revokeHarnessCredential: async (id) => { calls.push(["revoke", id]); return {}; } };
  const extra = { env: { RELO_HARNESS_CREDENTIAL_PATH: credentialPath, RELO_COMPUTER: "Build Mac" }, clientFactory: () => client };
  await box.run(["setup", "--project", "--hooks", "reminders"], extra);
  assert.deepEqual(calls, [], "reminders send nothing, so need no credential");
  const presence = await box.run(["setup", "--project", "--hooks", "presence"], extra);
  assert.equal(presence.line.harnessCredential, "ready");
  assert.deepEqual(calls, [["mint", { name: "Build Mac" }]]);
  assert.deepEqual(JSON.parse(await readFile(credentialPath, "utf8")), { apiUrl: "https://relo.example", id: "hcr_1", token: "h".repeat(44) });
  await box.run(["setup", "--project", "--hooks", "presence"], extra);
  assert.equal(calls.length, 1, "kept, not minted again");
  const status = await box.run(["hooks", "status"], extra);
  assert.equal(status.line.data.harnessCredential, "present");
  const off = await box.run(["setup", "--hooks", "off"], extra);
  assert.equal(off.line.harnessCredential, "revoked");
  assert.deepEqual(calls.at(-1), ["revoke", "hcr_1"]);
  assert.equal(existsSync(credentialPath), false);
});
