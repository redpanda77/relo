import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EXIT, VERSION, run } from "../src/cli.mjs";
import { bundleSkill } from "../scripts/bundle-skill.mjs";
import { bundledSkillDirectory } from "../src/skill.mjs";
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

test("install, unchanged, update with archive, and remove for one harness in a temp home", async () => {
  const b = await box();
  assert.ok(bundledSkillDirectory());
  const dry = await b.run(["skill", "install", "--agent", "claude-code", "--dry-run"]);
  assert.deepEqual(dry.line, { ok: true, agent: "claude-code", dir: "~/.claude/skills/relo-notifications", version: VERSION, action: "installed", dryRun: true });
  assert.equal(existsSync(join(b.home, ".claude")), false, "a dry run writes nothing");

  const first = await b.run(["skill", "install", "--agent", "claude-code"]);
  assert.equal(first.exitCode, EXIT.OK);
  assert.deepEqual(first.line, { ok: true, agent: "claude-code", dir: "~/.claude/skills/relo-notifications", version: VERSION, action: "installed" });
  const dir = join(b.home, ".claude", "skills", SKILL);
  const files = await tree(dir);
  assert.ok(files.includes("SKILL.md"));
  assert.equal(files.some((file) => file.startsWith("tests/")), false);
  assert.deepEqual(await readdir(join(b.home, ".claude")), ["skills"], "only that harness's skills folder");
  assert.equal(existsSync(join(b.home, ".agents")), false);

  const again = await b.run(["skill", "install", "--agent", "claude-code"]);
  assert.deepEqual(again.line, { ok: true, agent: "claude-code", dir: "~/.claude/skills/relo-notifications", version: VERSION, action: "unchanged" });
  assert.equal(existsSync(join(b.home, ".local")), false, "unchanged archives nothing");

  // same version, edited content: updated, with the old copy archived outside the discovery roots
  await writeFile(join(dir, "SKILL.md"), "edited\n");
  const updated = await b.run(["skill", "install", "--agent", "claude-code"]);
  assert.equal(updated.line.action, "updated");
  assert.match(updated.line.archived, new RegExp(`^~/\\.local/share/relo/skill-archives/20261013T\\d{6}Z-${VERSION.replaceAll(".", "\\.")}$`, "u"));
  const archived = join(b.home, updated.line.archived.slice(2));
  assert.equal(await readFile(join(archived, SKILL, "SKILL.md"), "utf8"), "edited\n");
  assert.notEqual(await readFile(join(dir, "SKILL.md"), "utf8"), "edited\n");

  const removed = await b.run(["skill", "remove", "--agent", "claude-code"]);
  assert.equal(removed.line.action, "removed");
  assert.equal(existsSync(dir), false);
  assert.equal(existsSync(join(b.home, removed.line.archived.slice(2), SKILL, "SKILL.md")), true);
  assert.equal((await b.run(["skill", "remove", "--agent", "claude-code"])).line.action, "absent");
  assert.notEqual(removed.line.archived, updated.line.archived, "each archive is its own folder");
});

test("an older copy is updated and archived under its own version; shared dirs, --dir and CLAUDE_CONFIG_DIR", async () => {
  const b = await box({ skillVersion: "0.1.0" });
  const old = join(b.home, ".agents", "skills", SKILL);
  const out = await b.run(["skill", "install", "--agent", "codex"]);
  assert.equal(out.line.action, "updated");
  assert.equal(out.line.dir, "~/.agents/skills/relo-notifications");
  assert.match(out.line.archived, /-0\.1\.0$/u);
  assert.equal(JSON.parse(await readFile(join(old, "package.json"), "utf8")).version, VERSION);
  assert.equal(existsSync(join(b.home, out.line.archived.slice(2), SKILL, "package.json")), true);

  const custom = join(b.cwd, "elsewhere");
  const dir = await b.run(["skill", "install", "--dir", custom]);
  assert.equal(dir.line.action, "installed");
  assert.equal(dir.line.agent, undefined);
  assert.equal(existsSync(join(custom, SKILL, "SKILL.md")), true);

  const configHome = join(b.cwd, "claude-work");
  const work = { ...b.deps, env: { CLAUDE_CONFIG_DIR: configHome } };
  assert.equal((await cli(["skill", "install", "--agent", "claude"], work)).line.dir, join(configHome, "skills", SKILL));
  for (const [agent, path] of [["opencode", ".config/opencode/skills"], ["gemini-cli", ".gemini/skills"], ["amp", ".config/agents/skills"],
    ["cursor", ".cursor/skills"], ["copilot", ".copilot/skills"]]) {
    assert.equal((await b.run(["skill", "install", "--agent", agent, "--dry-run"])).line.dir, `~/${path}/${SKILL}`, agent);
  }
});

test("bad choices write nothing; links are never followed", async () => {
  const b = await box();
  for (const argv of [["skill", "install"], ["skill", "install", "--agent", "nope"], ["skill", "install", "--agent", "codex", "--dir", "x"],
    ["skill", "remove"], ["skill", "bogus"], ["skill", "status", "--agent", "codex"]]) {
    assert.equal((await b.run(argv)).exitCode, EXIT.USAGE, argv.join(" "));
  }
  assert.match((await b.run(["skill", "install"])).line.error.hint, /--agent <claude-code\|codex/u);
  assert.deepEqual(await readdir(b.home), []);
  await mkdir(join(b.home, ".agents", "skills"), { recursive: true });
  await mkdir(join(b.cwd, "real"));
  await symlink(join(b.cwd, "real"), join(b.home, ".agents", "skills", SKILL));
  const linked = await b.run(["skill", "install", "--agent", "codex"]);
  assert.equal(linked.exitCode, EXIT.USAGE);
  assert.deepEqual(await readdir(join(b.cwd, "real")), []);
});

test("skill status lists every copy with its version and whether it is current", async () => {
  const b = await box({ skillVersion: "0.1.0" });
  assert.deepEqual((await b.run(["skill", "status"])).line, {
    ok: true, cli: VERSION, copies: [{ dir: "~/.agents/skills/relo-notifications", agent: "codex", version: "0.1.0", current: false }],
  });
  await b.run(["skill", "install", "--agent", "claude-code"]);
  const status = (await b.run(["skill", "status"])).line;
  assert.deepEqual(status.copies.map((copy) => [copy.dir, copy.current]),
    [["~/.claude/skills/relo-notifications", true], ["~/.agents/skills/relo-notifications", false]]);
  assert.deepEqual((await (await box()).run(["skill", "status"])).line, { ok: true, cli: VERSION, copies: [] });
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
  assert.equal(none.line.next.run, "relo skill install --agent claude-code");
  const inCodex = await cli(["doctor"], { ...missing.deps, env: { CODEX_THREAD_ID: "t1" } });
  assert.equal(inCodex.line.next.run, "relo skill install --agent codex");
  assert.equal(existsSync(join(missing.home, ".claude", "skills")), false, "doctor never installs");

  const stale = await prepare({ skillVersion: "0.1.0" });
  const behind = await cli(["doctor"], stale.deps);
  assert.equal(behind.line.ready, true);
  assert.equal(behind.line.next.run, "relo skill install --agent codex");
  const installed = await cli(behind.line.next.run.split(" ").slice(1), stale.deps);
  assert.equal(installed.line.action, "updated");
  assert.deepEqual((await cli(["doctor"], stale.deps)).line, { ok: true, ready: true });
});
