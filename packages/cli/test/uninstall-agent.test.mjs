import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EXIT } from "../src/shared/errors.mjs";
import { run } from "../src/cli.mjs";
import { cardDependencies, fakeHome } from "./fake-cards.mjs";

async function sandbox() {
  const home = await fakeHome({ agents: ["claude-code", "gemini", "antigravity"], installed: ["claude-code", "gemini", "antigravity"] });
  const cwd = await mkdtemp(join(tmpdir(), "relo-cwd-"));
  const deps = { ...cardDependencies({}), home, cwd, env: {}, platform: "darwin", nodePath: "/opt/node/bin/node", entrypoint: "/opt/relo/bin/relo.mjs" };
  const cli = async (argv) => {
    const stdout = [];
    const exitCode = await run(argv, { stdout: (line) => stdout.push(line), stderr: () => {}, stdoutIsTTY: false }, deps);
    return { exitCode, line: JSON.parse(stdout[0]) };
  };
  return { home, cli };
}

const AGENTS = ["--agent", "claude-code", "--agent", "gemini", "--agent", "antigravity"];
const files = (home) => ({
  claudeBlock: join(home, ".claude", "CLAUDE.md"), geminiBlock: join(home, ".gemini", "GEMINI.md"),
  claudeSettings: join(home, ".claude", "settings.json"), antigravityHooks: join(home, ".gemini", "config", "hooks.json"),
  antigravityMcp: join(home, ".gemini", "config", "mcp_config.json"), geminiMcp: join(home, ".gemini", "settings.json"),
  claudeSkill: join(home, ".claude", "skills", "relo-notifications"),
});
const holds = async (path) => existsSync(path) && /relo/iu.test(await readFile(path, "utf8"));

test("relo uninstall --agent removes one harness and leaves the others, the credential and their files", async () => {
  const box = await sandbox();
  const f = files(box.home);
  assert.equal((await box.cli(["setup", "--level", "guide", "--mcp", ...AGENTS])).exitCode, EXIT.OK);
  assert.ok(await holds(f.antigravityHooks) && await holds(f.antigravityMcp) && await holds(f.claudeBlock) && await holds(f.claudeSettings));

  const dry = await box.cli(["uninstall", "--agent", "antigravity"]);
  assert.equal(dry.line.dryRun, true);
  assert.ok(dry.line.changed.length > 0);
  assert.deepEqual([...new Set(dry.line.changed.map((row) => row.harness))], ["antigravity"], "the dry run lists only that harness");
  assert.equal(dry.line.harnessCredential, undefined);
  assert.ok(await holds(f.antigravityHooks), "a dry run writes nothing");

  const applied = await box.cli(["uninstall", "--agent", "antigravity", "--apply", "--json"]);
  assert.equal(applied.exitCode, EXIT.OK);
  assert.equal(applied.line.ok, true);
  assert.equal(applied.line.errors, undefined);
  assert.equal(applied.line.harnessCredential, undefined, "the shared credential is not touched");
  assert.ok(!applied.line.next.some((step) => /npm uninstall/u.test(step)));
  assert.ok(!(await holds(f.antigravityHooks)) && !(await holds(f.antigravityMcp)));
  assert.ok(await holds(f.claudeBlock) && await holds(f.geminiBlock) && await holds(f.claudeSettings) && await holds(f.geminiMcp), "other harnesses keep theirs");
  assert.ok(existsSync(f.claudeSkill), "the Claude Code skill stays");
});

test("relo uninstall --agent claude-code removes its block, skill and hooks only", async () => {
  const box = await sandbox();
  const f = files(box.home);
  await box.cli(["setup", "--level", "guide", ...AGENTS]);
  const out = await box.cli(["uninstall", "--agent", "claude-code", "--apply"]);
  assert.equal(out.exitCode, EXIT.OK);
  assert.ok(!(await holds(f.claudeBlock)) && !(await holds(f.claudeSettings)) && !existsSync(f.claudeSkill));
  assert.ok(await holds(f.geminiBlock) && await holds(f.antigravityHooks));
  assert.equal(out.line.harnessCredential, undefined);
});

test("relo uninstall --agent rejects an unknown agent, and without it uninstall still removes everything", async () => {
  const box = await sandbox();
  const f = files(box.home);
  assert.equal((await box.cli(["uninstall", "--agent", "nope"])).exitCode, EXIT.USAGE);
  await box.cli(["setup", "--level", "guide", ...AGENTS]);
  await box.cli(["uninstall", "--apply"]);
  assert.ok(!(await holds(f.claudeBlock)) && !(await holds(f.geminiBlock)) && !(await holds(f.antigravityHooks)));
});
