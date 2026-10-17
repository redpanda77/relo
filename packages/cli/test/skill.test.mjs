import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { EXIT } from "../src/shared/errors.mjs";
import { run } from "../src/cli.mjs";
import { VERSION } from "../src/version.mjs";
import { bundleSkill } from "../scripts/bundle-skill.mjs";
import { bundledSkillDirectory } from "../src/install/skill.mjs";
import { cardDependencies, fakeHome } from "./fake-cards.mjs";

const PACKAGE = new URL("..", import.meta.url).pathname;
const SKILL = "relo-notifications";

async function cli(argv, dependencies) {
  const stdout = [];
  const exitCode = await run(argv, { stdout: (line) => stdout.push(line), stderr: () => {}, stdoutIsTTY: false }, dependencies);
  return { exitCode, line: stdout[0] ? JSON.parse(stdout[0]) : undefined };
}

async function box(options = {}) {
  const home = await fakeHome({ agents: [], ...options });
  const cwd = await mkdtemp(join(tmpdir(), "relo-cwd-"));
  let clock = Date.UTC(2026, 9, 13, 10, 15, 0);
  const deps = { ...cardDependencies({}), home, cwd, env: {}, now: () => (clock += 1000) };
  return { home, cwd, deps, run: (argv) => cli(argv, deps) };
}

const tree = async (directory, prefix = "") => {
  const names = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) names.push(...await tree(join(directory, entry.name), `${prefix}${entry.name}/`));
    else names.push(`${prefix}${entry.name}`);
  }
  return names.sort();
};

test("the bundle script copies the skill without tests or node_modules, and the package ships it", async () => {
  const out = await mkdtemp(join(tmpdir(), "relo-bundle-"));
  await bundleSkill({ out: join(out, "skill") });
  const files = await tree(join(out, "skill"));
  assert.ok(files.includes("SKILL.md") && files.includes("package.json") && files.includes("LICENSE"));
  assert.ok(files.includes("scripts/skill-discovery.mjs") && files.includes("agents/openai.yaml"));
  assert.ok(files.some((file) => file.startsWith("references/")));
  assert.equal(files.some((file) => file.startsWith("tests/") || file.includes("node_modules")), false);
  assert.equal(JSON.parse(await readFile(join(out, "skill", "package.json"), "utf8")).version, VERSION);
  const manifest = JSON.parse(await readFile(join(PACKAGE, "package.json"), "utf8"));
  assert.ok(manifest.files.includes("skill"));
  assert.match(await readFile(join(PACKAGE, ".gitignore"), "utf8"), /^skill\/$/mu);
  assert.match(manifest.scripts.prepack, /bundle-skill/u);
  assert.match(manifest.scripts.test, /bundle-skill/u);
  await rm(out, { recursive: true, force: true });
});

test("a skill whose version differs from the CLI fails the bundle and the prepack check", async () => {
  const temp = await mkdtemp(join(tmpdir(), "relo-mismatch-"));
  const source = join(temp, "source");
  await cp(join(PACKAGE, "skill"), source, { recursive: true });
  const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  await writeFile(join(source, "package.json"), JSON.stringify({ ...manifest, version: "0.0.1" }));
  await assert.rejects(bundleSkill({ source, out: join(temp, "out") }), /does not match CLI/u);
  await writeFile(join(source, "package.json"), JSON.stringify({ ...manifest, reviewedToolingVersions: { "@relo/cli": "0.0.1" } }));
  await assert.rejects(bundleSkill({ source, out: join(temp, "out") }), /does not match CLI/u);

  // prepack-check in a copy of the package whose bundled skill is out of step
  const copy = join(temp, "package");
  await cp(PACKAGE, copy, { recursive: true });
  await writeFile(join(copy, "skill", "package.json"), JSON.stringify({ ...manifest, version: "0.0.1" }));
  assert.throws(() => execFileSync(process.execPath, [join(copy, "scripts", "prepack-check.mjs")], { stdio: "pipe" }), /does not match CLI/u);
  await writeFile(join(copy, "skill", "package.json"), JSON.stringify(manifest));
  execFileSync(process.execPath, [join(copy, "scripts", "prepack-check.mjs")], { stdio: "pipe" });
  await rm(temp, { recursive: true, force: true });
});

const skillRow = (line) => line.changed.find((row) => row.kind === "skill") ?? { action: "unchanged" };

test("relo setup installs the skill into one harness's folder; unchanged, updated with an archive, and removed by relo uninstall", async () => {
  const b = await box();
  assert.ok(bundledSkillDirectory());
  const dry = await b.run(["setup", "--agent", "claude-code", "--dry-run"]);
  assert.deepEqual(skillRow(dry.line), { kind: "skill", harness: "claude-code", file: "~/.claude/skills", action: "installed" });
  assert.equal(existsSync(join(b.home, ".claude")), false, "a dry run writes nothing");

  const first = await b.run(["setup", "--agent", "claude-code"]);
  assert.equal(first.exitCode, EXIT.OK);
  assert.equal(skillRow(first.line).action, "installed");
  const dir = join(b.home, ".claude", "skills", SKILL);
  const files = await tree(dir);
  assert.ok(files.includes("SKILL.md"));
  assert.equal(files.some((file) => file.startsWith("tests/")), false);
  assert.equal(existsSync(join(b.home, ".agents")), false, "only that harness's skills folder");

  assert.equal(skillRow((await b.run(["setup", "--agent", "claude-code"])).line).action, "unchanged");
  assert.equal(existsSync(join(b.home, ".local")), false, "unchanged archives nothing");

  // same version, edited content: updated, with the old copy archived outside the discovery roots
  await writeFile(join(dir, "SKILL.md"), "edited\n");
  const updated = skillRow((await b.run(["setup", "--agent", "claude-code"])).line);
  assert.equal(updated.action, "updated");
  assert.match(updated.archived, new RegExp(`^~/\\.local/share/relo/skill-archives/20261013T\\d{6}Z-${VERSION.replaceAll(".", "\\.")}$`, "u"));
  assert.equal(await readFile(join(b.home, updated.archived.slice(2), SKILL, "SKILL.md"), "utf8"), "edited\n");
  assert.notEqual(await readFile(join(dir, "SKILL.md"), "utf8"), "edited\n");

  const removed = skillRow((await b.run(["uninstall", "--apply"])).line);
  assert.equal(removed.action, "removed");
  assert.equal(existsSync(dir), false);
  assert.equal(existsSync(join(b.home, removed.archived.slice(2), SKILL, "SKILL.md")), true);
  assert.notEqual(removed.archived, updated.archived, "each archive is its own folder");
});

test("an older copy is updated and archived under its own version; each harness's folder; CLAUDE_CONFIG_DIR", async () => {
  const b = await box({ skillVersion: "0.1.0" });
  const old = join(b.home, ".agents", "skills", SKILL);
  const out = skillRow((await b.run(["setup", "--agent", "codex"])).line);
  assert.equal(out.action, "updated");
  assert.equal(out.file, "~/.agents/skills");
  assert.match(out.archived, /-0\.1\.0$/u);
  assert.equal(JSON.parse(await readFile(join(old, "package.json"), "utf8")).version, VERSION);
  const configHome = join(b.cwd, "claude-work");
  const work = { ...b.deps, env: { CLAUDE_CONFIG_DIR: configHome } };
  assert.equal(skillRow((await cli(["setup", "--agent", "claude"], work)).line).file, join(configHome, "skills"));
  assert.deepEqual((await b.run(["setup", "--agent", "opencode", "--dry-run"])).line.skipped.map((row) => row.reason),
    ["reads the skill from ~/.agents/skills"], "OpenCode reads the copy in ~/.agents/skills");
  for (const [agent, path] of [["gemini-cli", ".gemini/skills"], ["amp", ".config/agents/skills"],
    ["cursor", ".cursor/skills"], ["copilot", ".copilot/skills"]]) {
    assert.equal(skillRow((await b.run(["setup", "--agent", agent, "--dry-run"])).line).file, `~/${path}`, agent);
  }
});

test("in a checkout the skill comes from its source, and a copy is current only when its files match it", async () => {
  assert.equal(bundledSkillDirectory(), fileURLToPath(new URL("../../../skills/relo-notifications", import.meta.url)).replace(/\/$/u, ""));
  const b = await box({ skillVersion: VERSION });
  const copy = join(b.home, ".agents", "skills", SKILL);
  const { findSkillCopies } = await import("../src/install/skill.mjs");
  assert.deepEqual(findSkillCopies({ env: {}, home: b.home, cliVersion: VERSION }).map((found) => found.current), [true]);
  await writeFile(join(copy, "SKILL.md"), "edited at the same version\n");
  assert.deepEqual(findSkillCopies({ env: {}, home: b.home, cliVersion: VERSION }).map((found) => found.current), [false],
    "same version, different files: stale");
  assert.equal(skillRow((await b.run(["setup", "--refresh"])).line).action, "updated");
});

test("links are never followed: a linked skill folder is an error row and nothing is written through it", async () => {
  const b = await box();
  await mkdir(join(b.home, ".agents", "skills"), { recursive: true });
  await mkdir(join(b.cwd, "real"));
  await symlink(join(b.cwd, "real"), join(b.home, ".agents", "skills", SKILL));
  const linked = await b.run(["setup", "--agent", "codex"]);
  assert.equal(linked.exitCode, EXIT.USAGE);
  assert.equal(linked.line.errors[0].kind, "skill");
  assert.deepEqual(await readdir(join(b.cwd, "real")), []);
  assert.equal((await b.run(["skill", "install", "--agent", "codex"])).exitCode, EXIT.USAGE, "relo skill is relo setup now");
});

test("doctor's skill step is the exact install command and never installs", async () => {
  const healthy = { ready: async () => ({ ready: true }), doctor: async () => ({ version: 1, ok: true }),
    authStatus: async () => ({ authenticated: true, credential: { id: "c", clientName: "Studio", prefix: "p", expiresAt: "2027-01-01T00:00:00Z",
      scopes: ["activities:read", "activities:write", "devices:read", "interactions:create", "interactions:read", "notifications:send"] } }),
    listDevices: async () => ({ hasMore: false, cursor: null, devices: [{ deviceId: "dev_abcdefghijkl", liveActivityAuthorization: "authorized" }] }) };
  const verified = { loadConfig: async () => ({ apiUrl: "https://relo.example", token: "x".repeat(44), phoneTest: { deviceId: "dev_abcdefghijkl" } }) };
  const prepare = async (options, env = {}) => {
    const b = await box({ agents: [".claude", ".codex"], ...options });
    return { ...b, deps: { ...cardDependencies(healthy), ...verified, home: b.home, cwd: b.cwd, env } };
  };

  const missing = await prepare({});
  const none = await cli(["doctor"], missing.deps);
  assert.equal(none.line.next.step, "skill");
  assert.equal(none.line.next.run, "relo setup --agent claude-code");
  const inCodex = await cli(["doctor"], { ...missing.deps, env: { CODEX_THREAD_ID: "t1" } });
  assert.equal(inCodex.line.next.run, "relo setup --agent codex");
  assert.equal(existsSync(join(missing.home, ".claude", "skills")), false, "doctor never installs");

  const stale = await prepare({ skillVersion: "0.1.0" });
  const behind = await cli(["doctor"], stale.deps);
  assert.equal(behind.line.ready, true);
  assert.equal(behind.line.next.run, "relo setup --refresh");
  const refreshed = await cli(behind.line.next.run.split(" ").slice(1), stale.deps);
  assert.equal(skillRow(refreshed.line).action, "updated");
  assert.deepEqual((await cli(["doctor"], stale.deps)).line, { ok: true, ready: true });
});
