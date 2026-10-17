import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EXIT } from "../src/shared/errors.mjs";
import { run } from "../src/cli.mjs";
import { VERSION } from "../src/version.mjs";
import { DEPTHS, planBlock, renderBlock, renderBlockText } from "../src/install/block.mjs";
import { cardDependencies, fakeCards, fakeHome } from "./fake-cards.mjs";

const BLOCK = renderBlock(DEPTHS.track).join("\n");

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
  return { home, cwd, deps, run: (argv, extra = {}) => cli(argv, { ...deps, ...extra }) };
}

/** The rows of one kind in a setup or uninstall line: [{ harness?, file, action }]. */
const rows = (line, kind, list = "changed") => (line[list] ?? []).filter((row) => row.kind === kind).map(({ harness, file, action }) => ({ ...(harness ? { harness } : {}), file, action }));
/** What happened to the block: its change, "kept" when the owner froze it, else "unchanged". */
const blockAction = (line) => line.changed.find((row) => row.kind === "block")?.action
  ?? (line.skipped?.some((row) => row.kind === "block" && /relo:keep/u.test(row.reason)) ? "kept" : "unchanged");

test("relo setup with no harness on this computer names --agent and writes nothing", async () => {
  const box = await sandbox({ agents: [] });
  const out = await box.run(["setup"]);
  assert.equal(out.exitCode, EXIT.USAGE);
  assert.match(out.line.error.hint, /relo setup --agent claude-code/u);
  assert.deepEqual(await readdir(box.home), []);
  assert.equal((await box.run(["setup", "--agent", "nope"])).exitCode, EXIT.USAGE);
  for (const retired of ["--global", "--move", "--remove"]) assert.equal((await box.run(["setup", retired])).exitCode, EXIT.USAGE, retired);
});

test("relo setup writes the block and installs the skill for every harness found here; again, it changes nothing", async () => {
  const box = await sandbox();
  const first = await box.run(["setup"]);
  assert.equal(first.exitCode, EXIT.OK);
  assert.deepEqual(rows(first.line, "block"), [
    { harness: "claude-code", file: "~/.claude/CLAUDE.md", action: "created" },
    { harness: "codex", file: "~/.codex/AGENTS.md", action: "created" },
  ]);
  assert.deepEqual(rows(first.line, "skill"), [
    { harness: "claude-code", file: "~/.claude/skills", action: "installed" },
    { harness: "codex", file: "~/.agents/skills", action: "installed" },
  ]);
  assert.equal(await readFile(join(box.home, ".claude", "CLAUDE.md"), "utf8"), `${BLOCK}\n`);
  assert.ok(existsSync(join(box.home, ".claude", "skills", "relo-notifications", "SKILL.md")));
  assert.match(first.line.next[0], /^Restart Claude Code, Codex/u);
  const again = await box.run(["setup"]);
  assert.deepEqual(again.line.changed, []);
  assert.deepEqual(again.line.next, ["relo doctor"]);
});

test("--agent picks the harnesses, each into its documented files, with config-dir overrides", async () => {
  const box = await sandbox({ agents: [] });
  const env = { CLAUDE_CONFIG_DIR: join(box.home, "work-claude"), CODEX_HOME: join(box.home, "work-codex"), COPILOT_HOME: join(box.home, "cop") };
  const out = await box.run(["setup", "--agent", "claude-code", "--agent", "codex", "--agent", "gemini", "--agent", "opencode",
    "--agent", "copilot", "--agent", "amp"], { env });
  assert.deepEqual(rows(out.line, "block").map((row) => row.file), [
    "~/work-claude/CLAUDE.md", "~/work-codex/AGENTS.md", "~/.gemini/GEMINI.md", "~/.config/opencode/AGENTS.md",
    "~/cop/copilot-instructions.md", "~/.config/amp/AGENTS.md",
  ]);
  assert.deepEqual(rows(out.line, "skill").map((row) => row.file), [
    "~/work-claude/skills", "~/.agents/skills", "~/.gemini/skills", "~/cop/skills", "~/.config/agents/skills",
  ]);
  // OpenCode reads the shared ~/.agents/skills (Codex's copy here), so it gets no second copy.
  assert.deepEqual(out.line.skipped.filter((row) => row.kind === "skill"), [{ kind: "skill", harness: "opencode", reason: "reads the skill from ~/.agents/skills" }]);
});

test("OpenCode gets its own AGENTS.md and reads the skill from Claude Code's or the shared folder", async () => {
  const box = await sandbox({ agents: [] });
  const out = await box.run(["setup", "--agent", "opencode", "--agent", "claude-code"]);
  assert.deepEqual(rows(out.line, "block").map((row) => row.file), ["~/.config/opencode/AGENTS.md", "~/.claude/CLAUDE.md"]);
  assert.deepEqual(rows(out.line, "skill").map((row) => row.file), ["~/.claude/skills"]);
  assert.deepEqual(out.line.skipped, [{ kind: "skill", harness: "opencode", reason: "reads the skill from ~/.claude/skills" }]);
  // OpenCode alone, with nothing to read, gets its own skill; OPENCODE_DISABLE_CLAUDE_CODE turns the reading off.
  const fresh = await sandbox({ agents: [] });
  assert.deepEqual(rows((await fresh.run(["setup", "--agent", "opencode", "--dry-run"])).line, "skill").map((row) => row.file), ["~/.config/opencode/skills"]);
  const off = await fresh.run(["setup", "--agent", "opencode", "--agent", "claude-code", "--dry-run"], { env: { OPENCODE_DISABLE_CLAUDE_CODE: "1" } });
  assert.deepEqual(rows(off.line, "skill").map((row) => row.file), ["~/.config/opencode/skills", "~/.claude/skills"]);
});

test("the block is appended after one blank line, refreshed in place, and the rest of the file kept byte for byte", async () => {
  const box = await sandbox({ agents: [".claude"] });
  const claude = join(box.home, ".claude", "CLAUDE.md");
  const argv = ["setup", "--agent", "claude-code"];
  await writeFile(claude, "# Mine\r\nkeep  \r\n");
  assert.equal(blockAction((await box.run(argv)).line), "appended");
  assert.equal(await readFile(claude, "utf8"), `# Mine\r\nkeep  \r\n\r\n${BLOCK.replaceAll("\n", "\r\n")}\r\n`);
  assert.equal(blockAction((await box.run(argv)).line), "unchanged");
  const stale = (await readFile(claude, "utf8")).replace("Relo (live", "Relo OLD (live");
  await writeFile(claude, `before\n${stale}after without newline`);
  assert.equal(blockAction((await box.run(argv)).line), "updated");
  const text = await readFile(claude, "utf8");
  assert.ok(text.startsWith("before\n") && text.endsWith("<!-- relo:end -->\r\nafter without newline") && !text.includes("OLD"));
});

test("a keep marker freezes the block; markers inside a line do not count; an unterminated block is an error row", async () => {
  const box = await sandbox({ agents: [".claude"] });
  const claude = join(box.home, ".claude", "CLAUDE.md");
  const argv = ["setup", "--agent", "claude-code"];
  const custom = "<!-- relo:start -->\nmy own words\n<!-- relo:keep -->\n<!-- relo:end -->\n";
  await writeFile(claude, custom);
  assert.equal(blockAction((await box.run(argv)).line), "kept");
  assert.equal(await readFile(claude, "utf8"), custom);
  await writeFile(claude, "text <!-- relo:start --> inline\n");
  assert.equal(blockAction((await box.run(argv)).line), "appended");
  assert.equal(planBlock("<!-- relo:start -->\nno end\n").action, "skipped");
  await writeFile(claude, "<!-- relo:start -->\nno end\n");
  const broken = await box.run(argv);
  assert.equal(broken.exitCode, EXIT.USAGE);
  assert.equal(broken.line.errors[0].kind, "block");
  assert.equal(broken.line.unchanged, 1, "the rest of the plan (the skill) still ran");
});

test("--project: the repository's own file, or AGENTS.md plus a CLAUDE.md that imports it; both with their own text is an error", async () => {
  const box = await sandbox({ agents: [".claude"] });
  await mkdir(join(box.cwd, ".git"));
  await mkdir(join(box.cwd, "packages", "app"), { recursive: true });
  const deps = { cwd: join(box.cwd, "packages", "app") };
  const fresh = await box.run(["setup", "--project"], deps);
  assert.deepEqual(rows(fresh.line, "block"), [{ file: join(box.cwd, "AGENTS.md"), action: "created" }]);
  assert.equal(await readFile(join(box.cwd, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
  assert.equal(existsSync(join(box.home, ".claude", "CLAUDE.md")), false, "--project leaves the global files alone");
  assert.equal(blockAction((await box.run(["setup", "--project"], deps)).line), "unchanged", "the import counts as the same file");
  await rm(join(box.cwd, "AGENTS.md"));
  await writeFile(join(box.cwd, "CLAUDE.md"), "# Claude\n");
  assert.deepEqual(rows((await box.run(["setup", "--project"], deps)).line, "block"), [{ file: join(box.cwd, "CLAUDE.md"), action: "appended" }]);
  await writeFile(join(box.cwd, "AGENTS.md"), "# Agents\n");
  const both = await box.run(["setup", "--project"], deps);
  assert.equal(both.exitCode, EXIT.USAGE);
  assert.match(both.line.errors[0].reason, /both AGENTS.md and CLAUDE.md/u);
  assert.equal(await readFile(join(box.cwd, "AGENTS.md"), "utf8"), "# Agents\n");
  await rm(join(box.cwd, "AGENTS.md"));
  await symlink(join(box.cwd, "CLAUDE.md"), join(box.cwd, "AGENTS.md"));
  assert.equal((await box.run(["setup", "--project"], deps)).exitCode, EXIT.OK, "a symlinked pair is one file");
});

test("--dry-run writes nothing and shows the block it would write; a symlinked file is written through", async () => {
  const box = await sandbox({ agents: [".claude"] });
  const dry = await box.run(["setup", "--dry-run"]);
  assert.equal(dry.line.dryRun, true);
  assert.equal(dry.line.block, renderBlockText(DEPTHS.track));
  assert.deepEqual(rows(dry.line, "block"), [{ harness: "claude-code", file: "~/.claude/CLAUDE.md", action: "created" }]);
  assert.deepEqual(await readdir(join(box.home, ".claude")), []);
  const real = join(box.cwd, "dotfiles-CLAUDE.md");
  await writeFile(real, "# Dotfiles\n");
  await symlink(real, join(box.home, ".claude", "CLAUDE.md"));
  await box.run(["setup"]);
  assert.ok((await readFile(real, "utf8")).includes("relo:start"));
});

test("--refresh brings what is installed up to this CLI and adds nothing", async () => {
  const box = await sandbox({ block: "stale", skillVersion: "0.0.1" });
  const out = await box.run(["setup", "--refresh"]);
  assert.deepEqual(rows(out.line, "block"), [{ file: "~/.claude/CLAUDE.md", action: "updated" }]);
  assert.deepEqual(rows(out.line, "skill"), [{ harness: "codex", file: "~/.agents/skills", action: "updated" }]);
  assert.equal(existsSync(join(box.home, ".codex", "AGENTS.md")), false, "refresh never adds a block");
  assert.deepEqual((await box.run(["setup", "--refresh"])).line.changed, []);
  assert.equal((await box.run(["setup", "--refresh", "--project"])).exitCode, EXIT.USAGE);
});

test("relo uninstall lists Relo's files, and --apply removes Relo's parts only", async () => {
  const box = await sandbox({ agents: [".claude"] });
  await mkdir(join(box.cwd, ".git"));
  await writeFile(join(box.home, ".claude", "CLAUDE.md"), "# Mine\n");
  // The project block first: once a user-level block exists, setup --project leaves the repository alone.
  await box.run(["setup", "--project"]);
  await box.run(["setup"]);
  const listed = await box.run(["uninstall"]);
  assert.equal(listed.line.dryRun, true);
  assert.deepEqual(rows(listed.line, "block").map((row) => row.action), ["removed", "removed"]);
  assert.deepEqual(listed.line.next, ["relo uninstall --apply   (removes what is listed above)"]);
  assert.ok(existsSync(join(box.cwd, "AGENTS.md")), "a dry run changes nothing");
  const removed = await box.run(["uninstall", "--apply"]);
  assert.equal(removed.exitCode, EXIT.OK);
  assert.equal(await readFile(join(box.home, ".claude", "CLAUDE.md"), "utf8"), "# Mine\n");
  assert.equal(existsSync(join(box.cwd, "AGENTS.md")), false, "a file that held only the block goes with it");
  assert.equal(existsSync(join(box.cwd, "CLAUDE.md")), false, "and so does the CLAUDE.md that only imported it");
  assert.equal(existsSync(join(box.home, ".claude", "skills", "relo-notifications")), false);
  assert.deepEqual(rows(removed.line, "skill").map((row) => row.action), ["removed"]);
  assert.match(removed.line.next.at(-1), /npm uninstall --global @relo\/cli/u);
  assert.deepEqual((await box.run(["uninstall", "--apply"])).line.changed, []);
});

test("doctor points a missing skill at relo setup, never suggests hooks or MCP, and --full reports the block", async () => {
  const bare = await sandbox();
  const out = await bare.run(["doctor"]);
  assert.equal(out.exitCode, EXIT.OK);
  assert.equal(out.line.ok, true);
  assert.deepEqual(Object.keys(out.line.warnings), ["skill"]);
  assert.doesNotMatch(JSON.stringify(out.line), /--level|--hooks|--mcp/u);
  assert.equal(out.line.warnings.skill.state, "missing");
  assert.match(out.line.warnings.skill.hint, /relo-notifications.*relo setup --agent claude-code/u);
  const none = await bare.run(["doctor", "--full"]);
  assert.deepEqual(none.line.data.warnings.agentSetup, { ok: true, state: "none" });
  assert.equal(none.line.data.warnings.path, undefined, "PATH matters only once hooks or a shell MCP entry run relo");

  const behind = await sandbox({ block: true, skillVersion: "0.0.1" });
  const stale = await behind.run(["doctor"]);
  assert.equal(stale.line.warnings.skill.state, "outdated");
  const full = await behind.run(["doctor", "--full"]);
  assert.deepEqual(full.line.data.warnings.agentSetup, { ok: true, state: "set", files: [{ file: "~/.claude/CLAUDE.md", state: "current", modules: ["reporting", "planning"] }] });
  assert.equal(full.line.data.warnings.skill.cliVersion, VERSION);
});

test("doctor flags what setup wrote that needs fixing, each with the command that fixes it", async () => {
  const { setupWarnings } = await import("../src/owner/doctor.mjs");
  const box = await sandbox({ block: "stale", agents: [".claude"] });
  const probe = { ...box.deps, env: {}, version: VERSION, platform: "darwin" };
  const stale = await setupWarnings(probe);
  assert.deepEqual([stale.agentSetup.ok, stale.agentSetup.state], [false, "stale"]);
  assert.match(stale.agentSetup.hint, /relo setup --refresh$/u);

  // A project AGENTS.md block Claude Code never reads: no CLAUDE.md imports it. (Without a user-level block, or
  // setup --project would leave the repository alone.)
  await box.run(["setup", "--refresh"]);
  await rm(join(box.home, ".claude", "CLAUDE.md"));
  await mkdir(join(box.cwd, ".git"));
  await box.run(["setup", "--project"]);
  await rm(join(box.cwd, "CLAUDE.md"));
  const hidden = await setupWarnings(probe);
  assert.equal(hidden.agentSetup.state, "hidden");
  assert.match(hidden.agentSetup.hint, /not read by Claude Code: relo setup --project/u);
  await box.run(["setup", "--project"]);
  assert.equal((await setupWarnings(probe)).agentSetup.ok, true, "setup --project adds the import back");

  // A GUI app's MCP entry that names a node or relo that moved; and a relo on PATH that is not this CLI.
  const bin = await mkdtemp(join(tmpdir(), "relo-bin-"));
  await writeFile(join(bin, "relo"), "#!/bin/sh\n");
  const moved = { ...probe, nodePath: process.execPath, entrypoint: join(bin, "old-relo.mjs"), env: { PATH: bin } };
  await mkdir(join(box.home, ".cursor"), { recursive: true });
  await writeFile(join(box.home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { relo: { type: "stdio", command: "/gone/node", args: ["/gone/relo.mjs", "mcp"] } } }));
  const gui = await setupWarnings(moved);
  assert.match(gui.mcp.hint, /points at a node or relo that moved: relo setup --refresh/u);
  await box.run(["setup", "--mcp", "--agent", "claude-code"]);
  const path = (await setupWarnings(moved)).path;
  assert.deepEqual([path.ok, path.state], [false, "other"], "a shell MCP entry runs whatever relo PATH finds first");
});

test("doctor names an agent installed after setup, with the setup that covers it; nothing before any setup", async () => {
  const box = await sandbox({ agents: [".claude", ".codex"] });
  assert.equal((await box.run(["doctor"])).line.warnings?.agentsNotSetUp, undefined, "before setup the skill advice says it");
  await box.run(["setup", "--agent", "claude-code"]);
  const out = await box.run(["doctor"]);
  assert.equal(out.exitCode, EXIT.OK, "advice, never a failure");
  assert.equal(out.line.warnings.agentsNotSetUp.state, "Codex");
  assert.match(out.line.warnings.agentsNotSetUp.hint, /Relo does not cover Codex here yet: relo setup --agent codex$/u);
  await box.run(["setup", "--agent", "codex"]);
  assert.equal((await box.run(["doctor"])).line.warnings?.agentsNotSetUp, undefined);
});

test("relo schema COMMAND prints only those commands plus the exit codes", async () => {
  const deps = cardDependencies(fakeCards().client);
  for (const argv of [["schema", "activity", "end"], ["schema", "activity.end"]]) {
    const { line } = await cli(argv, deps);
    assert.deepEqual(line.data.commands.map((command) => command.name), ["activity end"]);
    assert.ok(line.data.exitCodes[5]);
    assert.equal(line.data.environment, undefined);
  }
  const several = await cli(["schema", "ask", "activity.get", "activity.end"], deps);
  assert.deepEqual(several.line.data.commands.map((command) => command.name), ["ask", "activity get", "activity end"]);
  const group = await cli(["schema", "activity"], deps);
  assert.ok(group.line.data.commands.length >= 5);
  const bare = await cli(["schema"], deps);
  assert.ok(bare.line.data.environment);
  const typo = await cli(["schema", "activity", "edn"], deps);
  assert.equal(typo.exitCode, EXIT.USAGE);
  assert.equal(typo.line.error.hint, "Did you mean activity end?");
  assert.equal((await cli(["schema", "setup"], deps)).line.data.commands[0].name, "setup");
});

test("services list is compact; auth login and logout have compact shapes too", async () => {
  const client = { listServices: async () => ({ services: [{ id: "svc_1", title: "Builds", prefix: "hook_a", createdAt: "2026-01-01T00:00:00Z", imageUrl: null, updatedAt: "x" }] }) };
  const out = await cli(["services", "list"], cardDependencies(client));
  assert.deepEqual(out.line, { ok: true, services: [{ id: "svc_1", title: "Builds", prefix: "hook_a", createdAt: "2026-01-01T00:00:00Z" }] });
  const full = await cli(["services", "list", "--full"], cardDependencies(client));
  assert.equal(full.line.command, "services.list");
});

/** A signed-in computer whose client records the name and icon PUTs, and a config that records the cached name. */
async function named(extra = {}) {
  const box = await sandbox();
  const puts = [];
  const asked = [];
  const depthAsked = [];
  const written = [];
  const base = {
    clientFactory: () => ({ putComputerSelf: async (change, key) => { puts.push({ change, key }); } }),
    env: { RELO_STATE_DIR: join(box.home, "state") },
    configPath: () => join(box.home, "config.json"),
    loadStoredConfig: async () => ({ apiUrl: "https://relo.example", token: "x".repeat(44), revision: "r1" }),
    writeConfig: async (_path, config) => { written.push(config); },
    computerName: () => "studio-mac",
    // The depth and agent questions are counted apart: these tests are about the name and icon questions.
    ask: async (question, fallback) => { (/^(How deep|Relo found these agents)/u.test(question) ? depthAsked : asked).push(question); return fallback; },
    ...extra,
  };
  return { ...box, puts, asked, depthAsked, written, run: (argv, more = {}) => box.run(argv, { ...base, ...more }) };
}
const terminal = { stdinIsTTY: true, stdoutIsTTY: true };

test("--computer and --icon name this computer without a prompt, for any caller, and cache the name", async () => {
  const box = await named();
  const out = await box.run(["setup", "--computer", "Studio Mac", "--icon", "desktop"]);
  assert.equal(out.exitCode, EXIT.OK);
  assert.deepEqual(box.puts.map((put) => put.change), [{ name: "Studio Mac", icon: "desktop" }]);
  assert.deepEqual(box.asked, []);
  assert.equal(box.written[0].computerName, "Studio Mac");
  const row = out.line.changed.find((entry) => entry.kind === "computer");
  assert.equal(row.action, "updated");
  assert.match(row.reason, /relo uninstall keeps it/u);
  const icon = await box.run(["setup", "--icon", "cloud"]);
  assert.deepEqual(box.puts.at(-1).change, { icon: "cloud" });
  assert.equal(icon.exitCode, EXIT.OK);
});

test("an agent session never prompts, even at a terminal; its flags still apply", async () => {
  const box = await named();
  const agent = { ...terminal, caller: { type: "agent_session", harness: "claude-code", sessionId: "s", sessionKey: "k" } };
  assert.equal((await box.run(["setup"], agent)).exitCode, EXIT.OK);
  assert.deepEqual([box.asked, box.puts], [[], []]);
  await box.run(["setup", "--computer", "Build box", "--icon", "build"], agent);
  assert.deepEqual(box.puts.map((put) => put.change), [{ name: "Build box", icon: "build" }]);
});

test("a person at a terminal is asked once, with the detected name and icon as the defaults", async () => {
  const box = await named();
  const first = await box.run(["setup"], terminal);
  assert.equal(first.exitCode, EXIT.OK);
  assert.deepEqual(box.asked, ["What should Relo call this computer? [studio-mac] ", `Icon: laptop, desktop, server, cloud, terminal, build [${box.asked[1].match(/\[(\w+)\] $/u)[1]}] `]);
  assert.equal(box.puts[0].change.name, "studio-mac");
  assert.ok(["laptop", "desktop", "server", "cloud", "terminal", "build"].includes(box.puts[0].change.icon));
  await box.run(["setup"], terminal);
  assert.equal(box.puts.length, 1, "answered once, never asked again");
  assert.equal(box.asked.length, 2);
});

test("the answers are what is sent; a wrong icon is asked again", async () => {
  const answers = ["Office Mac", "spaceship", "Desktop"];
  const box = await named({ ask: async (question) => (/^(How deep|Relo found these agents)/u.test(question) ? "" : answers.shift()) });
  await box.run(["setup"], terminal);
  assert.deepEqual(box.puts.map((put) => put.change), [{ name: "Office Mac", icon: "desktop" }]);
});

test("--json, --dry-run, a pipe and an environment credential never prompt or send", async () => {
  const box = await named();
  for (const [argv, extra] of [[["setup", "--json"], terminal], [["setup", "--dry-run"], terminal], [["setup"], { stdinIsTTY: true, stdoutIsTTY: false }],
    [["setup"], { stdinIsTTY: false, stdoutIsTTY: true }]]) {
    assert.equal((await box.run(argv, extra)).exitCode, EXIT.OK, argv.join(" "));
  }
  assert.deepEqual([box.asked, box.puts], [[], []]);
  const dry = await box.run(["setup", "--dry-run", "--computer", "X", "--icon", "server"], terminal);
  assert.equal(dry.line.changed.find((entry) => entry.kind === "computer").action, "updated");
  assert.deepEqual(box.puts, [], "a dry run sends nothing");
  const env = await box.run(["setup", "--icon", "server"], { loadConfig: async () => ({ apiUrl: "https://relo.example", token: "x".repeat(44), source: "environment" }) });
  assert.deepEqual(box.puts, []);
  assert.match(env.line.skipped.find((entry) => entry.kind === "computer").reason, /relo auth login/u);
});

test("signed out, setup still works, sends nothing and says how to sign in", async () => {
  const box = await named({ loadConfig: async () => { throw new Error("no login"); } });
  for (const [argv, extra] of [[["setup", "--computer", "Mac"], {}], [["setup"], terminal]]) {
    const out = await box.run(argv, extra);
    assert.equal(out.exitCode, EXIT.OK);
    assert.match(out.line.skipped.find((entry) => entry.kind === "computer").reason, /^Sign in with relo auth login to name this computer on your phone\.$/u);
  }
  assert.deepEqual([box.asked, box.puts], [[], []]);
});

test("bad --icon, an over-long name, and --refresh or --level track with them are usage errors", async () => {
  const box = await named();
  assert.equal((await box.run(["setup", "--icon", "spaceship"])).exitCode, EXIT.USAGE);
  assert.equal((await box.run(["setup", "--computer", "x".repeat(81)])).exitCode, EXIT.USAGE);
  assert.equal((await box.run(["setup", "--refresh", "--icon", "cloud"])).exitCode, EXIT.USAGE);
  assert.equal((await box.run(["setup", "--refresh", "--level", "track"])).exitCode, EXIT.USAGE);
  assert.deepEqual(box.puts, []);
});

test("a failed send is reported, and the next setup asks again", async () => {
  let failing = true;
  const puts = [];
  const box = await named({ clientFactory: () => ({ putComputerSelf: async (change) => { if (failing) throw new Error("offline"); puts.push(change); } }) });
  const out = await box.run(["setup"], terminal);
  assert.equal(out.exitCode, EXIT.USAGE);
  assert.equal(out.line.errors.find((entry) => entry.kind === "computer").reason, "offline");
  failing = false;
  await box.run(["setup"], terminal);
  assert.equal(puts.length, 1);
});

test("relo uninstall does not undo the name or icon", async () => {
  const box = await named();
  await box.run(["setup", "--computer", "Mac", "--icon", "laptop"]);
  const out = await box.run(["uninstall", "--apply"]);
  assert.equal(out.line.changed.some((entry) => entry.kind === "computer"), false);
  assert.equal(box.puts.length, 1);
});
