import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EXIT, VERSION, run } from "../src/cli.mjs";
import { BLOCK_LINES, planBlock } from "../src/setup.mjs";
import { cardDependencies, fakeCards, fakeHome } from "./fake-cards.mjs";

const BLOCK = BLOCK_LINES.join("\n");

async function cli(argv, dependencies) {
  const stdout = [];
  const exitCode = await run(argv, { stdout: (line) => stdout.push(line), stderr: () => {}, stdoutIsTTY: false }, dependencies);
  return { exitCode, line: stdout[0] ? JSON.parse(stdout[0]) : undefined };
}

/** Every setup command runs against a throwaway home and working folder. */
async function sandbox(options) {
  const home = await fakeHome(options);
  const cwd = await mkdtemp(join(tmpdir(), "relo-cwd-"));
  const healthy = { ready: async () => ({ ready: true }), doctor: async () => ({ version: 1, ok: true }),
    authStatus: async () => ({ authenticated: true, credential: { id: "c", clientName: "Studio", prefix: "p", expiresAt: "2027-01-01T00:00:00Z",
      scopes: ["activities:read", "activities:write", "devices:read", "interactions:create", "interactions:read", "notifications:send"] } }) };
  const deps = { ...cardDependencies(healthy), home, cwd, env: {} };
  return { home, cwd, deps, run: (argv) => cli(argv, deps) };
}

test("the block is short, marked, and carries no version or date", () => {
  assert.ok(BLOCK_LINES.length <= 12);
  assert.equal(BLOCK_LINES[0], "<!-- relo:start -->");
  assert.equal(BLOCK_LINES.at(-1), "<!-- relo:end -->");
  assert.equal(/\d+\.\d+\.\d+|20\d\d-\d\d-\d\d/u.test(BLOCK), false);
});

test("bare setup writes nothing and lists the choices", async () => {
  const box = await sandbox();
  const out = await box.run(["setup"]);
  assert.equal(out.exitCode, EXIT.USAGE);
  assert.match(out.line.error.hint, /--project.*--global --agent <claude-code\|codex.*--file PATH/u);
  assert.equal(existsSync(join(box.home, ".claude", "CLAUDE.md")), false);
  assert.equal(existsSync(join(box.home, ".codex", "AGENTS.md")), false);
  assert.deepEqual(await readdir(box.cwd), []);
  for (const argv of [["setup", "--global"], ["setup", "--agent", "codex"], ["setup", "--project", "--file", "a.md"],
    ["setup", "--file", "a.md", "--file", "b.md"], ["setup", "--global", "--agent", "nope"]]) {
    assert.equal((await box.run(argv)).exitCode, EXIT.USAGE, argv.join(" "));
  }
  const unknown = await box.run(["setup", "--global", "--agent", "nope"]);
  assert.match(unknown.line.error.hint, /--file PATH/u);
});

test("--global --agent writes the one file of that harness and nothing else", async () => {
  const box = await sandbox({ agents: [] });
  const claude = await box.run(["setup", "--global", "--agent", "claude-code"]);
  assert.equal(claude.exitCode, EXIT.OK);
  assert.deepEqual({ file: claude.line.file, action: claude.line.action }, { file: "~/.claude/CLAUDE.md", action: "created" });
  assert.equal(await readFile(join(box.home, ".claude", "CLAUDE.md"), "utf8"), `${BLOCK}\n`);
  assert.equal(claude.line.files, undefined);
  assert.equal(claude.line.skill.installed.length, 0);
  assert.match(claude.line.hint, /relo skill install --agent claude-code/u);
  assert.equal(existsSync(join(box.home, ".codex")), false);
});

test("each supported harness maps to its documented global file, with config-dir overrides", async () => {
  const box = await sandbox({ agents: [] });
  const custom = join(box.home, "custom-codex");
  const env = { CODEX_HOME: custom, CLAUDE_CONFIG_DIR: join(box.home, "cc"), COPILOT_HOME: join(box.home, "cp") };
  const expected = {
    codex: join(custom, "AGENTS.md"), "claude-code": join(box.home, "cc", "CLAUDE.md"), copilot: join(box.home, "cp", "copilot-instructions.md"),
    gemini: join(box.home, ".gemini", "GEMINI.md"), opencode: join(box.home, ".config", "opencode", "AGENTS.md"),
    amp: join(box.home, ".config", "amp", "AGENTS.md"),
  };
  for (const [agent, path] of Object.entries(expected)) {
    const out = await cli(["setup", "--global", "--agent", agent, "--dry-run"], { ...box.deps, env });
    assert.equal(out.line.file, path.replace(box.home, "~"), agent);
    assert.equal(out.line.dryRun, true);
    assert.equal(existsSync(path), false, "dry-run writes nothing");
  }
  assert.equal((await cli(["setup", "--global", "--agent", "claude", "--dry-run"], { ...box.deps, env })).line.file, "~/cc/CLAUDE.md");
  await cli(["setup", "--global", "--agent", "gemini"], box.deps);
  assert.equal(existsSync(expected.gemini), true, "the harness folder is created for a global target");
});

test("setup is idempotent, appends after one blank line, and preserves the rest byte for byte", async () => {
  const box = await sandbox();
  const claude = join(box.home, ".claude", "CLAUDE.md");
  const argv = ["setup", "--global", "--agent", "claude-code"];
  await writeFile(claude, "# Mine\r\nkeep  \r\n");
  assert.equal((await box.run(argv)).line.action, "appended");
  assert.equal(await readFile(claude, "utf8"), `# Mine\r\nkeep  \r\n\r\n${BLOCK.replaceAll("\n", "\r\n")}\r\n`);
  assert.equal((await box.run(argv)).line.action, "unchanged");
  const stale = (await readFile(claude, "utf8")).replace("Relo (live", "Relo OLD (live");
  await writeFile(claude, `before\n${stale}after without newline`);
  assert.equal((await box.run(argv)).line.action, "updated");
  const text = await readFile(claude, "utf8");
  assert.equal(text.startsWith("before\n"), true);
  assert.equal(text.endsWith("<!-- relo:end -->\r\nafter without newline"), true);
  assert.equal(text.includes("OLD"), false);
});

test("a keep marker freezes the block; markers inside a line do not count", async () => {
  const box = await sandbox();
  const claude = join(box.home, ".claude", "CLAUDE.md");
  const argv = ["setup", "--global", "--agent", "claude-code"];
  const custom = "<!-- relo:start -->\nmy own words\n<!-- relo:keep -->\n<!-- relo:end -->\n";
  await writeFile(claude, custom);
  assert.equal((await box.run(argv)).line.action, "kept");
  assert.equal((await box.run(["setup", "--remove"])).line.action, "kept");
  assert.equal(await readFile(claude, "utf8"), custom);
  const inline = "text <!-- relo:start --> inline\n";
  await writeFile(claude, inline);
  assert.equal((await box.run(argv)).line.action, "appended");
  assert.equal((await readFile(claude, "utf8")).startsWith(inline), true);
});

test("an unterminated block is left alone", async () => {
  assert.equal(planBlock("<!-- relo:start -->\nno end\n").action, "skipped");
  const box = await sandbox();
  await writeFile(join(box.home, ".claude", "CLAUDE.md"), "<!-- relo:start -->\nno end\n");
  const out = await box.run(["setup", "--global", "--agent", "claude-code"]);
  assert.equal(out.exitCode, EXIT.USAGE);
});

test("--project picks the one instruction file in the repository root, never both", async () => {
  const box = await sandbox();
  await mkdir(join(box.cwd, ".git"));
  await mkdir(join(box.cwd, "packages", "app"), { recursive: true });
  const deps = { ...box.deps, cwd: join(box.cwd, "packages", "app") };
  const created = await cli(["setup", "--project"], deps);
  assert.deepEqual({ file: created.line.file, action: created.line.action }, { file: join(box.cwd, "AGENTS.md"), action: "created" });
  assert.equal(existsSync(join(box.cwd, "CLAUDE.md")), false);
  assert.equal((await cli(["setup", "--project"], deps)).line.action, "unchanged");
  await rm(join(box.cwd, "AGENTS.md"));
  await writeFile(join(box.cwd, "CLAUDE.md"), "# Claude\n");
  const only = await cli(["setup", "--project"], deps);
  assert.deepEqual({ file: only.line.file, action: only.line.action }, { file: join(box.cwd, "CLAUDE.md"), action: "appended" });
  assert.equal(existsSync(join(box.cwd, "AGENTS.md")), false);
  await writeFile(join(box.cwd, "AGENTS.md"), "# Agents\n");
  const both = await cli(["setup", "--project"], deps);
  assert.equal(both.exitCode, EXIT.USAGE);
  assert.match(both.line.error.hint, /--file/u);
  assert.equal((await readFile(join(box.cwd, "AGENTS.md"), "utf8")), "# Agents\n");
  assert.equal(existsSync(join(box.home, ".claude", "CLAUDE.md")), false, "--project leaves the global files alone");
});

test("a symlinked AGENTS.md and CLAUDE.md count as one file", async () => {
  const box = await sandbox();
  await mkdir(join(box.cwd, ".git"));
  await writeFile(join(box.cwd, "AGENTS.md"), "# Shared\n");
  await symlink(join(box.cwd, "AGENTS.md"), join(box.cwd, "CLAUDE.md"));
  const out = await cli(["setup", "--project"], box.deps);
  assert.equal(out.exitCode, EXIT.OK);
  assert.equal(out.line.file, join(box.cwd, "AGENTS.md"));
});

test("--file is exactly that file, relative to the working folder", async () => {
  const box = await sandbox();
  const out = await box.run(["setup", "--file", "a.md"]);
  assert.deepEqual({ file: out.line.file, action: out.line.action }, { file: join(box.cwd, "a.md"), action: "created" });
  assert.equal(existsSync(join(box.home, ".claude", "CLAUDE.md")), false);
  const missing = await box.run(["setup", "--file", "notes/b.md"]);
  assert.equal(missing.exitCode, EXIT.USAGE);
  assert.equal((await box.run(["setup", "stray", "--file", "c.md"])).exitCode, EXIT.USAGE);
});

test("setup refuses when the block is already in another file, and --move relocates it", async () => {
  const box = await sandbox();
  const codex = join(box.home, ".codex", "AGENTS.md");
  await mkdir(join(box.cwd, ".git"));
  await writeFile(codex, "# Codex rules\n");
  await box.run(["setup", "--global", "--agent", "codex"]);
  const refused = await box.run(["setup", "--project"]);
  assert.equal(refused.exitCode, EXIT.USAGE);
  assert.equal(refused.line.error.message, "Relo is already set up in ~/.codex/AGENTS.md.");
  assert.match(refused.line.error.hint, /relo setup --project --move/u);
  assert.equal(existsSync(join(box.cwd, "AGENTS.md")), false);
  assert.equal((await readFile(codex, "utf8")).includes("relo:start"), true);

  const dry = await box.run(["setup", "--project", "--move", "--dry-run"]);
  assert.deepEqual({ action: dry.line.action, from: dry.line.from, dry: dry.line.dryRun }, { action: "moved", from: "~/.codex/AGENTS.md", dry: true });
  assert.equal((await readFile(codex, "utf8")).includes("relo:start"), true);

  const moved = await box.run(["setup", "--project", "--move"]);
  assert.deepEqual({ file: moved.line.file, action: moved.line.action, from: moved.line.from },
    { file: join(box.cwd, "AGENTS.md"), action: "moved", from: "~/.codex/AGENTS.md" });
  assert.equal(await readFile(codex, "utf8"), "# Codex rules\n");
  assert.equal(await readFile(join(box.cwd, "AGENTS.md"), "utf8"), `${BLOCK}\n`);
  // The same file again is an in-place refresh, not a conflict.
  assert.equal((await box.run(["setup", "--project"])).line.action, "unchanged");
});

test("--move will not touch a block the owner froze with relo:keep", async () => {
  const box = await sandbox();
  await writeFile(join(box.home, ".codex", "AGENTS.md"), "<!-- relo:start -->\nmine\n<!-- relo:keep -->\n<!-- relo:end -->\n");
  const out = await box.run(["setup", "--global", "--agent", "claude-code", "--move"]);
  assert.equal(out.exitCode, EXIT.USAGE);
  assert.equal(existsSync(join(box.home, ".claude", "CLAUDE.md")), false);
});

test("--remove takes the block out wherever it is, with no target flags; --dry-run changes nothing", async () => {
  const box = await sandbox();
  const codex = join(box.home, ".codex", "AGENTS.md");
  await writeFile(codex, "# Codex rules\n");
  await box.run(["setup", "--global", "--agent", "codex"]);
  const dry = await box.run(["setup", "--remove", "--dry-run"]);
  assert.deepEqual({ file: dry.line.file, action: dry.line.action, dry: dry.line.dryRun }, { file: "~/.codex/AGENTS.md", action: "removed", dry: true });
  assert.equal((await readFile(codex, "utf8")).includes("relo:start"), true);
  const removed = await box.run(["setup", "--remove"]);
  assert.equal(removed.line.action, "removed");
  assert.equal(removed.line.skill, undefined);
  assert.equal(await readFile(codex, "utf8"), "# Codex rules\n");
  const again = await box.run(["setup", "--remove"]);
  assert.equal(again.line.action, "unchanged");
  await box.run(["setup", "--global", "--agent", "claude-code"]);
  await box.run(["setup", "--remove"]);
  assert.equal(existsSync(join(box.home, ".claude", "CLAUDE.md")), false, "a file that held only the block goes away with it");
});

test("setup writes through a symlinked instruction file instead of replacing it", async () => {
  const box = await sandbox();
  const real = join(box.cwd, "dotfiles-CLAUDE.md");
  await writeFile(real, "# Dotfiles\n");
  await rm(join(box.home, ".claude"), { recursive: true });
  await mkdir(join(box.home, ".claude"));
  await symlink(real, join(box.home, ".claude", "CLAUDE.md"));
  await box.run(["setup", "--global", "--agent", "claude-code"]);
  assert.equal((await readFile(real, "utf8")).includes("relo:start"), true);
});

test("setup reports the skill copies and whether they match this CLI", async () => {
  const argv = ["setup", "--global", "--agent", "claude-code"];
  const current = await sandbox({ skillVersion: VERSION });
  const fine = await current.run(argv);
  assert.deepEqual(fine.line.skill, { installed: ["~/.agents/skills/relo-notifications"], version: VERSION, matchesCli: true });
  assert.equal(fine.line.hint, undefined);
  const old = await sandbox({ skillVersion: "0.1.0" });
  const behind = await old.run(argv);
  assert.equal(behind.line.skill.matchesCli, false);
  assert.match(behind.line.hint, /0\.1\.0.*relo skill install --agent codex/u);
});

test("doctor never nudges toward setup; --full reports it informationally; the skill warning stays", async () => {
  const bare = await sandbox();
  const out = await bare.run(["doctor"]);
  assert.equal(out.exitCode, EXIT.OK);
  assert.equal(out.line.ok, true);
  assert.deepEqual(Object.keys(out.line.warnings), ["skill"]);
  assert.equal(JSON.stringify(out.line).includes("relo setup"), false);
  assert.equal(out.line.warnings.skill.state, "missing");
  assert.match(out.line.warnings.skill.hint, /relo-notifications/u);
  const none = await bare.run(["doctor", "--full"]);
  assert.deepEqual(none.line.data.warnings.agentSetup, { ok: true, state: "none" });

  const behind = await sandbox({ block: true, skillVersion: "0.0.1" });
  const stale = await behind.run(["doctor"]);
  assert.equal(stale.line.warnings.skill.state, "outdated");
  const full = await behind.run(["doctor", "--full"]);
  assert.deepEqual(full.line.data.warnings.agentSetup, { ok: true, state: "set", file: "~/.claude/CLAUDE.md" });
  assert.equal(full.line.data.warnings.skill.cliVersion, VERSION);
});

test("relo schema COMMAND prints only those commands plus the exit codes", async () => {
  const deps = cardDependencies(fakeCards().client);
  for (const argv of [["schema", "activity", "update"], ["schema", "activity.update"]]) {
    const { line } = await cli(argv, deps);
    assert.deepEqual(line.data.commands.map((command) => command.name), ["activity update"]);
    assert.ok(line.data.exitCodes[5]);
    assert.equal(line.data.environment, undefined);
  }
  const several = await cli(["schema", "ask", "activity.start", "activity.end"], deps);
  assert.deepEqual(several.line.data.commands.map((command) => command.name), ["ask", "activity start", "activity end"]);
  const group = await cli(["schema", "activity"], deps);
  assert.ok(group.line.data.commands.length >= 6);
  const bare = await cli(["schema"], deps);
  assert.ok(bare.line.data.environment);
  const typo = await cli(["schema", "activity", "updat"], deps);
  assert.equal(typo.exitCode, EXIT.USAGE);
  assert.equal(typo.line.error.hint, "Did you mean activity update?");
  assert.equal((await cli(["schema", "setup"], deps)).line.data.commands[0].name, "setup");
});

test("progress on a card that draws it from steps is flagged, never silently dropped", async () => {
  const note = "progress follows this card's steps; use --next-step or --step-current";
  const withSteps = (id) => ({ id, state: "active", sequence: 1, progress: 0.5,
    presentation: { components: [{ type: "steps", items: [{ label: "A", state: "current" }, { label: "B", state: "pending" }] }] } });
  const delivery = { eligibleDevices: 1, durableCommands: 1, apnsJobs: 1 };
  const client = {
    startActivity: async () => ({ activity: withSteps("act_1"), delivery }),
    getActivity: async () => ({ activity: withSteps("act_1") }),
    updateActivity: async () => ({ activity: withSteps("act_1"), delivery }),
  };
  const deps = { ...cardDependencies(client), env: { CLAUDE_CODE_SESSION_ID: "s-progress" } };
  const topic = ["--topic", "Release"];
  const update = await cli(["activity", "update", "--progress", "40%"], deps);
  assert.equal(update.line.note, note);
  const quiet = await cli(["activity", "update", "--status", "Working"], deps);
  assert.equal(quiet.line.note, undefined);
  const start = await cli(["activity", "start", "--title", "T", "--status", "S", "--progress", "0.2", "--new", ...topic], deps);
  assert.equal(start.line.note, note);
  const refused = await cli(["activity", "start", "--title", "T", "--status", "S", "--steps", "A,B", "--progress", "0.2", ...topic], deps);
  assert.equal(refused.exitCode, EXIT.USAGE);
  assert.match(refused.line.error.hint, /--step-current or --next-step/u);
});

test("services list is compact; auth login and logout have compact shapes too", async () => {
  const client = { listServices: async () => ({ services: [{ id: "svc_1", title: "Builds", prefix: "hook_a", createdAt: "2026-01-01T00:00:00Z", imageUrl: null, updatedAt: "x" }] }) };
  const out = await cli(["services", "list"], cardDependencies(client));
  assert.deepEqual(out.line, { ok: true, services: [{ id: "svc_1", title: "Builds", prefix: "hook_a", createdAt: "2026-01-01T00:00:00Z" }] });
  const full = await cli(["services", "list", "--full"], cardDependencies(client));
  assert.equal(full.line.command, "services.list");
});
