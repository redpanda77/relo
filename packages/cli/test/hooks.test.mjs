import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ReloApiClient } from "../src/shared/api-client.mjs";
import { EXIT } from "../src/shared/errors.mjs";
import { run } from "../src/cli.mjs";
import { setupWarnings } from "../src/owner/doctor.mjs";
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
    phase: "working", waitingFor: null, startedAt: "2026-10-13T10:00:00Z", lastSeenAt: "2026-10-13T10:05:00Z",
    card: { id: "act_11111111-1111-4111-8111-111111111111", state: "active" } },
  { id: "ags_22222222-2222-4222-8222-222222222222", harness: "gemini", computer: null, account: "work", project: null,
    phase: "waiting", waitingFor: "turn", startedAt: "2026-10-13T10:00:00Z", lastSeenAt: "2026-10-13T10:06:00Z", card: null }];
  const deps = cardDependencies({ listAgentSessions: async () => ({ sessions }) });
  const out = await cli(["sessions"], deps);
  assert.equal(out.exitCode, EXIT.OK);
  assert.deepEqual(out.line, { ok: true, sessions: [
    { harness: "claude-code", computer: "Studio", project: "relo", phase: "working", lastSeenAt: "2026-10-13T10:05:00Z", card: { state: "active" } },
    { harness: "gemini", account: "work", phase: "waiting", waitingFor: "turn", lastSeenAt: "2026-10-13T10:06:00Z" },
  ] });
  assert.equal((await cli(["sessions", "extra"], deps)).exitCode, EXIT.USAGE);
});

test("relo sessions shows phases and counts; --live asks the server for working and waiting only", async () => {
  const counts = { working: 1, waiting: 1, idle: 4, ended: 2 };
  const asked = [];
  const sessions = [
    { harness: "claude-code", project: "relo", phase: "working", lastSeenAt: "2026-10-13T10:05:00Z", card: null },
    { harness: "claude-code", project: "relo", phase: "waiting", waitingFor: "input", lastSeenAt: "2026-10-13T10:04:00Z", card: null },
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

// ---- relo setup --level guide|track (hooks: presence | off) ---------------------------------------------------

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
    global: join(home, ".claude", "settings.json"), project: join(cwd, ".claude", "settings.local.json") };
}

/** The hook row of a setup line: what happened to one settings file ({ action, file, level } or a skip's reason). */
const hooks = (line, harness = "claude-code") => [...line.changed, ...(line.skipped ?? []), ...(line.errors ?? [])]
  .find((row) => row.kind === "hooks" && row.harness === harness) ?? { action: "unchanged" };
const CLAUDE = ["setup", "--agent", "claude-code", "--level"];
/** The hook set `relo setup --show` reports for Claude Code (what is installed, user level). */
const shownHooks = async (box, extra) => (await box.run(["setup", "--agent", "claude-code", "--show"], extra)).line.harnesses[0].hooks;
/** A reminders-only file, as the retired level wrote it: presence's entries without the session-phase commands. */
const PHASE_ROLES = new Set(["start", "prompt", "tool-start", "tool-end", "wait", "subagent-start", "subagent-stop", "compact", "stop", "end"]);
const remindersOnly = (settings) => {
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const kept = groups.map((group) => ({ ...group, hooks: group.hooks.filter((hook) => !PHASE_ROLES.has(hook.command.slice("relo hook ".length))) })).filter((group) => group.hooks.length);
    if (kept.length) settings.hooks[event] = kept; else delete settings.hooks[event];
  }
  return settings;
};

test("--level guide writes one marked async entry per presence event into the user settings", async () => {
  const box = await setupBox();
  const out = await box.run([...CLAUDE, "guide"]);
  assert.equal(out.exitCode, EXIT.OK);
  assert.deepEqual(hooks(out.line), { kind: "hooks", harness: "claude-code", file: "~/.claude/settings.json", action: "created", level: "presence" });
  assert.equal(out.line.harnessCredential, "pending", "the server could not mint the harness credential: the flusher will");
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
  assert.equal(hooks((await box.run([...CLAUDE, "guide"])).line).action, "unchanged");
  assert.equal(await readFile(box.global, "utf8"), stringify(written));
  assert.equal(await shownHooks(box), "presence");
});

test("--project --level guide goes in the personal .claude/settings.local.json; CLAUDE_CONFIG_DIR moves the user file", async () => {
  const box = await setupBox();
  const project = await box.run([...CLAUDE, "guide", "--project"]);
  assert.equal(hooks(project.line).action, "created");
  assert.equal(existsSync(box.project), true);
  assert.equal(existsSync(join(box.cwd, ".claude", "settings.json")), false, "never the shared, committed settings file");
  assert.equal(existsSync(box.global), false);
  const other = await setupBox();
  const out = await other.run([...CLAUDE, "guide"], { env: { CLAUDE_CONFIG_DIR: join(other.home, "cc") } });
  assert.equal(hooks(out.line).file, "~/cc/settings.json");
});

test("--level guide keeps everything else, and --level track restores the file exactly", async () => {
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
  assert.equal(hooks((await box.run([...CLAUDE, "guide"])).line).action, "updated");
  const settings = JSON.parse(await readFile(box.global, "utf8"));
  assert.deepEqual(Object.keys(settings), ["model", "permissions", "hooks", "env"], "key order kept");
  assert.deepEqual(settings.hooks.PostToolUse[0], { matcher: "Edit|Write", hooks: [{ type: "command", command: "prettier --write", timeout: 10 }] },
    "the other PostToolUse hook is still there, first");
  assert.equal(reloGroup(settings, "PostToolUse", "tool-end").length, 1);
  assert.deepEqual(settings.hooks.Notification, [{ hooks: [{ type: "command", command: "say done" }] },
    { matcher: WAIT_MATCHER, hooks: [{ type: "command", command: "relo hook wait", async: true }] }], "the owner's own group is untouched");
  const removed = await box.run([...CLAUDE, "track"]);
  assert.deepEqual(hooks(removed.line), { kind: "hooks", harness: "claude-code", file: "~/.claude/settings.json", action: "removed", level: "off" });
  assert.equal(await readFile(box.global, "utf8"), original, "byte for byte");
  assert.deepEqual((await box.run([...CLAUDE, "track"])).line.changed, []);
  assert.equal(await shownHooks(box), "off");
});

test("--level track deletes a settings file that held only Relo's hooks, and a user hook in a shared group survives", async () => {
  const box = await setupBox();
  await box.run([...CLAUDE, "guide"]);
  await box.run([...CLAUDE, "track"]);
  assert.equal(existsSync(box.global), false);
  await mkdir(join(box.home, ".claude"), { recursive: true });
  await writeFile(box.global, stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "relo hook stop", async: true }, { type: "command", command: "mine" }] }] } }));
  await box.run([...CLAUDE, "track"]);
  assert.deepEqual(JSON.parse(await readFile(box.global, "utf8")), { hooks: { Stop: [{ hooks: [{ type: "command", command: "mine" }] }] } });
  assert.equal((await box.run(["hooks", "status"])).exitCode, EXIT.USAGE, "relo hooks is gone: relo setup --show");
  assert.equal((await box.run(["setup", "--agent", "claude-code", "--hooks", "off"])).exitCode, EXIT.USAGE, "--hooks is gone: --level track");
});

test("a stale synchronous Relo hook is replaced by the async one and 4-space or CRLF formatting is kept", async () => {
  const box = await setupBox();
  await mkdir(join(box.home, ".claude"), { recursive: true });
  const old = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "relo hook stop", timeout: 60 }] }] } }, null, 4).replaceAll("\n", "\r\n");
  await writeFile(box.global, old);
  assert.equal(await shownHooks(box), "custom", "an older entry of a command presence runs: refresh and setup rewrite it");
  assert.equal(hooks((await box.run([...CLAUDE, "guide"])).line).action, "updated");
  const text = await readFile(box.global, "utf8");
  assert.equal(text.includes("\r\n    \"hooks\""), true);
  assert.deepEqual(reloGroup(JSON.parse(text), "Stop", "stop"), [{ hooks: [{ type: "command", command: "relo hook stop", async: true }] }], "no duplicate, no stale timeout");
  assert.equal(text.endsWith("}"), true, "no trailing newline was invented");
});

test("--refresh rewrites outdated hook entries at the set installed, an old reminders-only set to presence, and --dry-run writes nothing", async () => {
  const box = await setupBox();
  await mkdir(join(box.home, ".claude"), { recursive: true });
  await box.run([...CLAUDE, "guide"]);
  const installed = await readFile(box.global, "utf8");
  const settings = JSON.parse(installed);
  settings.hooks.Stop[0].hooks[0].timeout = 99;
  await writeFile(box.global, stringify(settings));
  const dry = await box.run(["setup", "--refresh", "--dry-run"]);
  assert.deepEqual(dry.line.changed.filter((row) => row.kind === "hooks").map((row) => [row.action, row.level]), [["updated", "presence"]]);
  assert.equal(JSON.parse(await readFile(box.global, "utf8")).hooks.Stop[0].hooks[0].timeout, 99);
  await box.run(["setup", "--refresh"]);
  assert.equal(await readFile(box.global, "utf8"), installed, "back to exactly what the set installs");
  await writeFile(box.global, stringify(remindersOnly(JSON.parse(installed))));
  assert.equal(await shownHooks(box), "custom", "the retired reminders set is a custom one now");
  const upgraded = await box.run(["setup", "--refresh"]);
  assert.deepEqual(upgraded.line.changed.filter((row) => row.kind === "hooks").map((row) => [row.action, row.level]), [["updated", "presence"]]);
  assert.equal(await readFile(box.global, "utf8"), installed, "refresh upgrades it to presence");
});

test("setup refuses an unknown level or --hooks, says why a harness gets none, and never edits unreadable JSON", async () => {
  const box = await setupBox();
  assert.equal((await box.run([...CLAUDE, "everything"])).exitCode, EXIT.USAGE);
  assert.equal((await box.run([...CLAUDE, "track", "--approvals", "on"])).exitCode, EXIT.USAGE, "approvals need guide or optimize");
  const codex = await box.run(["setup", "--agent", "codex", "--level", "guide"]);
  assert.equal(codex.exitCode, EXIT.OK);
  assert.match(hooks(codex.line, "codex").reason, /^no hooks for this harness$/u);
  const track = await box.run(["setup", "--agent", "codex", "--level", "track"]);
  assert.equal((track.line.skipped ?? []).some((row) => row.kind === "hooks"), false, "a depth without hooks has no hooks row to explain");
  assert.equal(existsSync(box.global), false);
  await mkdir(join(box.home, ".claude"), { recursive: true });
  await writeFile(box.global, "{ // comment\n}\n");
  const bad = await box.run([...CLAUDE, "guide"]);
  assert.equal(bad.exitCode, EXIT.USAGE);
  assert.match(hooks(bad.line).reason, /not plain JSON/u);
  assert.equal(await readFile(box.global, "utf8"), "{ // comment\n}\n");
});

test("Gemini CLI hooks go in its settings.json with millisecond timeouts and --agent gemini; presence or off only (approvals fall back to presence); no project file", async () => {
  const box = await setupBox();
  const out = await box.run(["setup", "--agent", "gemini", "--level", "guide", "--approvals", "on"]);
  assert.deepEqual(hooks(out.line, "gemini"), { kind: "hooks", harness: "gemini", file: "~/.gemini/settings.json", action: "created", level: "presence" });
  const settings = JSON.parse(await readFile(join(box.home, ".gemini", "settings.json"), "utf8"));
  assert.deepEqual(settings.hooks.AfterAgent, [{ hooks: [{ type: "command", command: "relo hook stop --agent gemini", timeout: 5000 }] }]);
  assert.match(hooks((await box.run(["setup", "--project", "--agent", "gemini", "--level", "guide"])).line, "gemini").reason, /no personal project settings file/u);
  await box.run(["setup", "--agent", "gemini", "--level", "track"]);
  assert.equal(existsSync(join(box.home, ".gemini", "settings.json")), false, "a file that held only Relo's hooks goes");
});

test("doctor reports installed hooks (where, level, events), flags what needs fixing, and never suggests adding them", async () => {
  const box = await setupBox();
  const none = await setupWarnings({ env: {}, home: box.home, cwd: box.cwd, version: "0.10.0" });
  assert.deepEqual(none.hooks, { ok: true, state: "none" });
  assert.equal(JSON.stringify(none).includes("--level"), false);
  await mkdir(join(box.cwd, ".claude"), { recursive: true });
  await box.run([...CLAUDE, "guide", "--project"]);
  await writeFile(box.project, stringify(remindersOnly(JSON.parse(await readFile(box.project, "utf8")))));
  const old = await setupWarnings({ env: {}, home: box.home, cwd: box.cwd, version: "0.10.0" });
  assert.deepEqual([old.hooks.ok, old.hooks.state, old.hooks.files[0].level, old.hooks.files[0].nearest], [false, "stale", "custom", "presence"]);
  assert.match(old.hooks.hint, /relo setup --refresh/u);
  await box.run([...CLAUDE, "guide", "--project"]);
  const presence = await setupWarnings({ env: {}, home: box.home, cwd: box.cwd, version: "0.10.0" });
  assert.deepEqual(presence.hooks.files[0].events, EVENTS);
  assert.match(presence.hooks.hint, /harness credential: relo setup --level guide/u, "presence hooks with no credential cannot send");
});

// ---- hooks are optional: nothing depends on them -----------------------------------------------------

test("an ask, notify and end flow with no hooks installed makes no session-event request", async () => {
  const { fakeCards } = await import("./fake-cards.mjs");
  const fake = fakeCards({ answer: "approved" });
  fake.client.sendNotification = async () => ({ eventId: "ntf_1", delivery: { eligibleDevices: 1, durableCommands: 1, apnsJobs: 1 } });
  const requested = [];
  const client = new Proxy(fake.client, { get: (target, name) => { requested.push(String(name)); return target[name]; } });
  const box = await setupBox();
  const deps = { ...cardDependencies(client), home: box.home, cwd: box.cwd, env: {} };
  const topic = ["--topic", "Release 0.7.57"];
  const step = async (argv) => { const out = await cli(argv, deps); assert.equal(out.exitCode, EXIT.OK, JSON.stringify(out.line)); };
  await fake.client.startActivity({ title: "Deploy", status: "Building", key: "deploy-card" });
  await step(["ask", "Deploy?", "--approval", ...topic]);
  await step(["notify", "Done", ...topic]);
  await step(["activity", "end", "--status", "Live", "--name", "deploy-card"]);
  assert.ok(requested.length > 4, "the flow really ran");
  assert.deepEqual(requested.filter((name) => /session/iu.test(name)), [], "no session event or session list was requested");
  // setup without a hooked --level writes no hooks, and doctor never suggests them.
  await cli(["setup", "--project", "--agent", "claude-code"], deps);
  await cli(["setup", "--agent", "claude-code"], deps);
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

test("setup --level guide puts Relo's matcher on its own Notification group, never on a shared one", async () => {
  const box = await setupBox();
  await mkdir(join(box.home, ".claude"), { recursive: true });
  await writeFile(box.global, stringify({ hooks: {
    Notification: [{ hooks: [{ type: "command", command: "relo hook wait", timeout: 5 }] }],
    Stop: [{ matcher: "", hooks: [{ type: "command", command: "relo hook stop", timeout: 5 }, { type: "command", command: "mine" }] }],
  } }));
  assert.equal(hooks((await box.run([...CLAUDE, "guide"])).line).action, "updated");
  const settings = JSON.parse(await readFile(box.global, "utf8"));
  assert.deepEqual(settings.hooks.Notification, [{ matcher: WAIT_MATCHER, hooks: [{ type: "command", command: "relo hook wait", async: true }] }]);
  assert.deepEqual(settings.hooks.Stop[0], { matcher: "", hooks: [{ type: "command", command: "mine" }] }, "a shared group keeps the owner's matcher and hook");
  assert.equal(reloGroup(settings, "Stop", "stop").length, 1, "Relo's stop lives in its own group");
});

test("guide mints this computer's harness credential with the CLI credential; track needs none; going back to track revokes it", async () => {
  const box = await setupBox();
  const credentialPath = join(box.home, "harness-credential");
  const calls = [];
  const client = { createHarnessCredential: async (body) => { calls.push(["mint", body]); return { id: "hcr_1", token: "h".repeat(44) }; },
    revokeHarnessCredential: async (id) => { calls.push(["revoke", id]); return {}; } };
  const extra = { env: { RELO_HARNESS_CREDENTIAL_PATH: credentialPath, RELO_COMPUTER: "Build Mac" }, clientFactory: () => client };
  await box.run([...CLAUDE, "track", "--project"], extra);
  assert.deepEqual(calls, [], "track installs no hooks, so needs no credential");
  const presence = await box.run([...CLAUDE, "guide", "--project"], extra);
  assert.equal(presence.line.harnessCredential, "ready");
  assert.deepEqual(calls, [["mint", { name: "Build Mac" }]]);
  assert.deepEqual(JSON.parse(await readFile(credentialPath, "utf8")), { apiUrl: "https://relo.example", id: "hcr_1", token: "h".repeat(44) });
  await box.run([...CLAUDE, "guide", "--project"], extra);
  assert.equal(calls.length, 1, "kept, not minted again");
  assert.equal(existsSync(credentialPath), true);
  const off = await box.run([...CLAUDE, "track", "--project"], extra);
  assert.equal(off.line.harnessCredential, "revoked");
  assert.deepEqual(calls.at(-1), ["revoke", "hcr_1"]);
  assert.equal(existsSync(credentialPath), false);
});
