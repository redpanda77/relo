// Which harnesses are installed on this computer (not merely "running"), what setup refuses, and what `setup --show`
// and a setup result report part by part: instructions, skill, hooks, MCP, approvals.
import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { run } from "../src/cli.mjs";
import { HARNESSES } from "../src/harness/catalog.mjs";
import { installation } from "../src/harness/installed.mjs";
import { EXIT } from "../src/shared/errors.mjs";
import { cardDependencies, fakeHome } from "./fake-cards.mjs";

async function sandbox({ env = {}, platform = "darwin" } = {}) {
  const home = await fakeHome({ agents: [] });
  const cwd = await mkdtemp(join(tmpdir(), "relo-cwd-"));
  const deps = { ...cardDependencies({}), home, cwd, env, platform, nodePath: "/opt/node/bin/node", entrypoint: "/opt/relo/bin/relo.mjs" };
  const cli = async (argv) => {
    const stdout = [];
    const exitCode = await run(argv, { stdout: (line) => stdout.push(line), stderr: () => {}, stdoutIsTTY: false }, deps);
    return { exitCode, line: stdout[0] ? JSON.parse(stdout[0]) : undefined };
  };
  const put = async (...path) => { const target = join(home, ...path); await mkdir(join(target, ".."), { recursive: true }); await writeFile(target, "x"); };
  const dir = (...path) => mkdir(join(home, ...path), { recursive: true });
  const probe = () => ({ env, home, cwd, platform });
  const row = async (id, extra = []) => (await cli(["setup", "--show", "--all", ...extra])).line.harnesses.find((candidate) => candidate.harness === id);
  return { home, cwd, cli, put, dir, probe, row };
}

const installed = (box, id) => installation(HARNESSES.find((harness) => harness.id === id), box.probe()).installed;

test("an empty computer has no agent installed: --show lists none, --show --all lists them all as not installed", async () => {
  const box = await sandbox();
  const none = await box.cli(["setup", "--show"]);
  assert.equal(none.exitCode, EXIT.OK);
  assert.deepEqual(none.line.harnesses, []);
  const all = await box.cli(["setup", "--show", "--all"]);
  const ids = all.line.harnesses.map((row) => row.harness);
  for (const id of ["claude-code", "codex", "gemini", "antigravity", "cursor", "copilot", "opencode", "amp", "claude-desktop"]) assert.ok(ids.includes(id), id);
  assert.equal(ids.includes("agents"), false, "the shared skills folder is no agent");
  assert.ok(all.line.harnesses.every((row) => row.installed === false && row.configured === false && row.level === "none"));
});

test("each harness counts as installed only on its own evidence, never a folder another harness shares", async () => {
  // Gemini CLI and Antigravity share ~/.gemini: the folder, and Relo's own ~/.gemini/config, prove neither.
  const shared = await sandbox();
  await shared.dir(".gemini", "config");
  await shared.put(".gemini", "config", "mcp_config.json");
  await shared.put(".gemini", "GEMINI.md");
  await shared.put(".gemini", "settings.json");
  assert.equal(installed(shared, "gemini"), false);
  assert.equal(installed(shared, "antigravity"), false);
  await shared.dir(".gemini", "antigravity");
  assert.equal(installed(shared, "antigravity"), true, "its own folder");
  assert.equal(installed(shared, "gemini"), false, "Antigravity's folder is not Gemini CLI");
  await shared.put(".gemini", "oauth_creds.json");
  assert.equal(installed(shared, "gemini"), true, "a file only Gemini CLI keeps");

  // Folders Relo writes into (mcp.json, instructions, skills) are not the app's.
  const own = await sandbox();
  await own.put(".cursor", "mcp.json");
  await own.put(".copilot", "copilot-instructions.md");
  await own.put("Library", "Application Support", "Claude", "claude_desktop_config.json");
  await own.put(".config", "amp", "AGENTS.md");
  for (const id of ["cursor", "copilot", "claude-desktop", "amp"]) assert.equal(installed(own, id), false, id);
  await own.dir(".cursor", "extensions");
  await own.put(".copilot", "config.json");
  await own.put("Library", "Application Support", "Claude", "config.json");
  await own.dir(".local", "share", "amp");
  for (const id of ["cursor", "copilot", "claude-desktop", "amp"]) assert.equal(installed(own, id), true, id);

  // The harness's own config folder, its program on PATH, or its app.
  const folders = await sandbox();
  await folders.dir(".claude");
  await folders.dir(".codex");
  await folders.dir(".config", "opencode");
  assert.deepEqual(["claude-code", "codex", "opencode"].map((id) => installed(folders, id)), [true, true, true]);
  const program = await sandbox({ env: { PATH: "/somewhere/bin" } });
  assert.equal(installed(program, "codex"), false);
  await mkdir(join(program.home, "bin"), { recursive: true });
  await writeFile(join(program.home, "bin", "codex"), "#!/bin/sh\n");
  assert.equal(installed(await Object.assign(program, { probe: () => ({ env: { PATH: `/somewhere/bin:${join(program.home, "bin")}` }, home: program.home, cwd: program.cwd, platform: "darwin" }) }), "codex"), true);
  const app = await sandbox();
  await app.dir("Applications", "Cursor.app");
  await app.dir("Applications", "Antigravity.app");
  await app.dir("Applications", "Claude.app");
  assert.deepEqual(["cursor", "antigravity", "claude-desktop"].map((id) => installed(app, id)), [true, true, true]);
  // COPILOT_HOME moves Copilot's folder.
  const moved = await sandbox({ env: { COPILOT_HOME: "/placeholder" } });
  const custom = join(moved.home, "cop");
  await mkdir(custom, { recursive: true });
  await writeFile(join(custom, "config.json"), "{}");
  assert.equal(installation(HARNESSES.find((harness) => harness.id === "copilot"), { env: { COPILOT_HOME: custom }, home: moved.home, platform: "darwin" }).installed, true);
  // The harness this command runs inside is installed by definition.
  const running = await sandbox({ env: { CODEX_THREAD_ID: "t" } });
  assert.equal(installed(running, "codex"), true);
});

test("setup refuses a harness that is not installed with a plain error and writes nothing", async () => {
  const box = await sandbox();
  await box.dir(".gemini", "config"); // what an old setup left behind for Antigravity: not an installation
  const before = await readdir(join(box.home, ".gemini", "config"));
  for (const argv of [["setup", "--agent", "antigravity", "--level", "guide", "--mcp"], ["setup", "--agent", "antigravity", "--dry-run"]]) {
    const out = await box.cli(argv);
    assert.equal(out.exitCode, EXIT.USAGE);
    assert.equal(out.line.error.message, "Antigravity isn't installed on this Mac.");
  }
  assert.deepEqual(await readdir(join(box.home, ".gemini", "config")), before);
  assert.deepEqual((await readdir(join(box.home, ".gemini"))).sort(), ["config"]);
  const linux = await sandbox({ platform: "linux" });
  assert.equal((await linux.cli(["setup", "--agent", "cursor"])).line.error.message, "Cursor isn't installed on this computer.");
  // --show names any harness; uninstall too (it only removes).
  assert.equal((await box.cli(["setup", "--show", "--agent", "antigravity"])).line.harnesses[0].installed, false);
  assert.equal((await box.cli(["uninstall", "--agent", "antigravity"])).exitCode, EXIT.OK);
});

test("a configured Antigravity (hooks and MCP, no instructions file) reports its level from the hooks, part by part", async () => {
  const box = await sandbox();
  await box.dir(".gemini", "antigravity");
  const missing = await box.row("antigravity");
  assert.deepEqual([missing.installed, missing.configured, missing.level], [true, false, "none"]);
  assert.deepEqual(missing.parts, { instructions: "n/a", skill: "n/a", hooks: "off", mcp: false, approvals: false });

  const set = await box.cli(["setup", "--agent", "antigravity", "--level", "guide", "--mcp"]);
  assert.equal(set.exitCode, EXIT.OK);
  const result = set.line.harnesses.find((row) => row.harness === "antigravity");
  assert.deepEqual(result.changes, { instructions: "n/a", skill: "n/a", hooks: "added", mcp: "added", approvals: "unchanged" });
  assert.deepEqual(result.summary, ["Added hooks", "Added MCP entry"]);
  assert.deepEqual([result.level, result.configured], ["guide", true]);
  assert.deepEqual(result.parts, { instructions: "n/a", skill: "n/a", hooks: "presence", mcp: true, approvals: false });

  const shown = await box.row("antigravity");
  assert.deepEqual([shown.level, shown.configured, shown.hooks], ["guide", true, "presence"]);
  assert.deepEqual(shown.parts, result.parts);
  // The same, listed by default now that it is installed.
  assert.deepEqual((await box.cli(["setup", "--show"])).line.harnesses.map((row) => row.harness), ["antigravity"]);

  const approvals = await box.cli(["setup", "--agent", "antigravity", "--level", "guide", "--approvals", "on"]);
  assert.equal(approvals.exitCode, EXIT.OK);
  const again = approvals.line.harnesses[0];
  assert.equal(again.changes.approvals, approvals.line.harnesses[0].parts.hooks === "approvals" ? "on" : "unchanged");
  // Antigravity offers presence only: approvals stay as its highest set allows, and the part says what is installed.
  assert.equal(again.parts.approvals, again.parts.hooks === "approvals");

  // Only MCP: never "none" while something of Relo's is there.
  const mcpOnly = await sandbox();
  await mcpOnly.dir(".gemini", "antigravity");
  await mcpOnly.cli(["setup", "--agent", "antigravity", "--level", "track", "--mcp"]);
  const row = await mcpOnly.row("antigravity");
  assert.deepEqual([row.level, row.configured, row.parts.hooks, row.parts.mcp], ["notify", true, "off", true]);
  // Track on a harness with no instructions file says so instead of silently doing nothing.
  const nothing = await sandbox();
  await nothing.dir(".gemini", "antigravity");
  const note = (await nothing.cli(["setup", "--agent", "antigravity", "--level", "track"])).line.harnesses[0];
  assert.match(note.note, /session hooks \(--level guide\) or the MCP entry \(--mcp\)/u);
});

test("the setup choices: instructions only, live cards without hooks, with session hooks, approvals", async () => {
  const box = await sandbox();
  await box.dir(".claude");
  const part = async () => (await box.row("claude-code")).parts;

  const notify = await box.cli(["setup", "--agent", "claude-code", "--level", "notify"]);
  assert.deepEqual(notify.line.harnesses[0].summary, ["Added instructions"]);
  assert.deepEqual(await part(), { instructions: "current", skill: "none", hooks: "off", mcp: false, approvals: false });
  assert.equal((await box.row("claude-code")).level, "notify");

  const track = await box.cli(["setup", "--agent", "claude-code", "--level", "track"]);
  assert.deepEqual(track.line.harnesses[0].summary, ["Updated instructions", "Added skill"]);
  assert.deepEqual(await part(), { instructions: "current", skill: "current", hooks: "off", mcp: false, approvals: false });
  assert.equal((await box.row("claude-code")).level, "track", "track installs no hooks");

  const guide = await box.cli(["setup", "--agent", "claude-code", "--level", "guide", "--mcp"]);
  assert.deepEqual(guide.line.harnesses[0].summary, ["Updated instructions", "Added hooks", "Added MCP entry"]);
  assert.deepEqual(await part(), { instructions: "current", skill: "current", hooks: "presence", mcp: true, approvals: false });

  const on = await box.cli(["setup", "--agent", "claude-code", "--level", "guide", "--approvals", "on"]);
  assert.equal(on.line.harnesses[0].changes.approvals, "on");
  assert.ok(on.line.harnesses[0].summary.includes("Turned on approvals"));
  assert.equal((await part()).approvals, true);
  const off = await box.cli(["setup", "--agent", "claude-code", "--level", "guide", "--approvals", "off"]);
  assert.equal(off.line.harnesses[0].changes.approvals, "off");
  assert.deepEqual([(await part()).hooks, (await part()).approvals], ["presence", false]);

  const back = await box.cli(["setup", "--agent", "claude-code", "--level", "track"]);
  assert.equal(back.line.harnesses[0].changes.hooks, "removed");
  assert.equal((await box.row("claude-code")).parts.hooks, "off");
  const dry = await box.cli(["setup", "--agent", "claude-code", "--level", "guide", "--dry-run"]);
  assert.deepEqual(dry.line.harnesses[0].summary, ["Would update instructions", "Would add hooks"]);
  assert.equal(dry.line.harnesses[0].level, undefined, "a dry run reads nothing after");

  assert.equal((await box.cli(["setup", "--agent", "claude-code", "--approvals", "on", "--level", "track"])).exitCode, EXIT.USAGE);
  const show = (await box.cli(["setup", "--show"])).line;
  assert.deepEqual(Object.keys(show.levels), ["notify", "track", "guide", "optimize"]);
  assert.deepEqual([show.levels.notify.skill, show.levels.track.hooks, show.levels.guide.hooks, show.levels.guide.approvalsAllowed], [false, "off", "presence", true]);
  assert.equal((await box.cli(["setup", "--all"])).exitCode, EXIT.USAGE, "--all only goes with --show");
});
