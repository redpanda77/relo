import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planMcpFile, wantedEntry } from "../src/install/mcp.mjs";
import { installSkill, bundledSkillDirectory, findSkillCopies } from "../src/install/skill.mjs";
import { isNewerVersion } from "../src/install/versions.mjs";
import { bundledEntrypoint, setUpdateMode, updateMode } from "../src/owner/auto-update.mjs";
import { runUpdateCommand } from "../src/owner/update.mjs";
import { dataRoot } from "../src/work/state-file.mjs";

const box = mkdtempSync(join(tmpdir(), "relo-versions-"));
test.after(() => rmSync(box, { recursive: true, force: true }));

function fakeCli(name, version) {
  const dir = join(box, name);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "relo", version }));
  const entrypoint = join(dir, "src", "relo.mjs");
  writeFileSync(entrypoint, "");
  return entrypoint;
}

test("isNewerVersion compares plain x.y.z and never calls anything else newer", () => {
  assert.equal(isNewerVersion("0.17.10", "0.17.9"), true);
  assert.equal(isNewerVersion("0.17.9", "0.17.10"), false);
  assert.equal(isNewerVersion("0.17.9", "0.17.9"), false);
  assert.equal(isNewerVersion("1.0.0-beta", "0.9.0"), false);
  assert.equal(isNewerVersion(undefined, "0.9.0"), false);
});

test("setup never installs an older skill copy over a newer one", async () => {
  const root = join(box, "skills");
  const source = bundledSkillDirectory();
  const bundled = JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version;
  const [major, minor, patch] = bundled.split(".").map(Number);
  const newer = `${major}.${minor}.${patch + 1}`;
  const target = join(root, "relo-notifications");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "SKILL.md"), "# from a newer relo\n");
  writeFileSync(join(target, "package.json"), JSON.stringify({ name: "relo-notifications", version: newer }));
  const report = await installSkill({ root, agent: "claude-code", home: box, now: Date.now() });
  assert.equal(report.action, "unchanged");
  assert.equal(report.keptNewer, newer);
  assert.equal(readFileSync(join(target, "SKILL.md"), "utf8"), "# from a newer relo\n");
  const copies = findSkillCopies({ env: { CLAUDE_CONFIG_DIR: join(box, "claude") }, home: box, cliVersion: bundled });
  assert.equal(copies.every((copy) => copy.current), true);
  // An older copy is still updated.
  writeFileSync(join(target, "package.json"), JSON.stringify({ name: "relo-notifications", version: "0.0.1" }));
  assert.equal((await installSkill({ root, agent: "claude-code", home: box, now: Date.now() })).action, "updated");
});

test("setup never rewrites an MCP entry that names a newer CLI", async () => {
  const older = fakeCli("older", "0.17.40");
  const newer = fakeCli("newer", "0.17.52");
  const file = join(box, "claude.json");
  const entryFor = (entrypoint) => wantedEntry("cursor", { nodePath: "/usr/bin/node", entrypoint });
  const text = JSON.stringify({ mcpServers: { relo: entryFor(newer) } }, null, 2) + "\n";
  writeFileSync(file, text);
  const kept = await planMcpFile(file, "cursor", entryFor(older));
  assert.equal(kept.plan.action, "unchanged");
  assert.equal(kept.plan.content, undefined);
  writeFileSync(file, JSON.stringify({ mcpServers: { relo: entryFor(older) } }, null, 2) + "\n");
  assert.equal((await planMcpFile(file, "cursor", entryFor(newer))).plan.action, "updated");
});

test("managed updates belong to the bundled CLI only, and leaving managed never npm-installs the bundle", async () => {
  const home = join(box, "home");
  const bundled = "/Applications/Relo.app/Contents/Resources/relo/src/relo.mjs";
  const nvm = "/Users/x/.nvm/versions/node/v22/lib/node_modules/relo/src/relo.mjs";
  assert.equal(bundledEntrypoint(bundled), true);
  assert.equal(bundledEntrypoint(nvm), false);
  setUpdateMode(home, "managed", bundled);
  assert.equal(JSON.parse(readFileSync(join(dataRoot(home), "updates.json"), "utf8")).entrypoint, bundled);
  assert.equal(updateMode({ home, entrypoint: bundled }), "managed");
  assert.equal(updateMode({ home, entrypoint: nvm }), "auto", "an nvm relo is not told the app keeps it up to date");
  const run = (entrypoint) => runUpdateCommand({ options: {}, group: "update", rest: [], dependencies: { home, env: {}, entrypoint, version: "0.17.1" } });
  await assert.rejects(run(nvm), { code: "RELEASES_UNREACHABLE" }, "the nvm relo goes on to update itself (and finds no release server here)");
  setUpdateMode(home, "auto");
  const out = await run(bundled);
  assert.equal(out.data.bundled, true, "the bundled CLI never installs itself, even in auto");
});
