import "./hermetic-env.mjs";
// Windows: the commands a harness runs are absolute (node + relo.mjs, forward slashes, double quotes) so they do not
// depend on PATH in Git Bash, cmd or whatever shell the harness uses; setup replaces a bare or absolute Relo hook
// instead of duplicating it, uninstall removes both, and the editors keep a BOM and CRLF. POSIX stays `relo hook ...`.
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ADAPTERS } from "../src/harness/adapters/index.mjs";
import { configDirectory } from "../src/harness/paths.mjs";
import { inferLevel, planLevel } from "../src/harness/core/install.mjs";
import { isReloHookCommand, isReloStatusline, launchPrefix, reloCommand } from "../src/harness/core/launch.mjs";
import { planLevelFile, commitLevel } from "../src/install/hooks.mjs";
import { planMcpFile, wantedEntry } from "../src/install/mcp.mjs";
import { planFile } from "../src/install/block.mjs";
import descriptors from "../src/harness/adapters/opencode/descriptor.mjs";

const WIN = { nodePath: "C:\\Users\\x\\AppData\\Local\\Relo\\node\\node.exe", entrypoint: "C:\\Users\\x\\AppData\\Local\\Relo\\app\\bin\\relo.mjs", platform: "win32" };
const PREFIX = '"C:/Users/x/AppData/Local/Relo/node/node.exe" "C:/Users/x/AppData/Local/Relo/app/bin/relo.mjs"';
const claude = ADAPTERS["claude-code"];
const commands = (content) => Object.values(JSON.parse(content.replace(/^\uFEFF/u, "")).hooks).flatMap((gs) => gs.flatMap((g) => g.hooks.map((h) => h.command)));

test("the launch prefix is absolute with forward slashes on win32 only", () => {
  assert.equal(launchPrefix(WIN), PREFIX);
  assert.equal(reloCommand("hook guard", WIN), `${PREFIX} hook guard`);
  assert.equal(launchPrefix({ ...WIN, platform: "linux" }), undefined);
  assert.equal(reloCommand("hook guard", { ...WIN, platform: "darwin" }), "relo hook guard");
  assert.equal(reloCommand("hook guard"), process.platform === "win32" ? "relo hook guard" : "relo hook guard");
});

test("both spellings are recognized as Relo's; other commands are not", () => {
  assert.ok(isReloHookCommand("relo hook stop"));
  assert.ok(isReloHookCommand(`${PREFIX} hook stop`));
  assert.ok(isReloHookCommand('"C:/n/node.exe" "C:/r/bin/relo.mjs" hook tool-start'));
  assert.ok(!isReloHookCommand('"C:/n/node.exe" "C:/x/other.mjs" hook stop'));
  assert.ok(!isReloHookCommand("echo relo hook stop"));
  assert.ok(isReloStatusline("relo statusline") && isReloStatusline(`${PREFIX} statusline`));
  assert.ok(!isReloStatusline(`${PREFIX} hook stop`));
});

test("POSIX output is the bare command; win32 output is absolute for every entry", () => {
  const bare = commands(planLevel("s.json", undefined, "approvals+lean", claude).content);
  assert.ok(bare.every((c) => c.startsWith("relo hook ")));
  const wins = commands(planLevel("s.json", undefined, "approvals+lean", claude, WIN).content);
  assert.equal(wins.length, bare.length);
  assert.ok(wins.every((c) => c.startsWith(`${PREFIX} hook `)));
  assert.deepEqual(wins.map((c) => c.slice(PREFIX.length + 1)), bare.map((c) => c.slice("relo ".length)));
  const gemini = commands(planLevel("s.json", undefined, "presence", ADAPTERS.gemini, WIN).content);
  assert.ok(gemini.every((c) => c.startsWith(`${PREFIX} hook `) && c.endsWith(" --agent gemini")));
});

test("setup replaces a bare Relo hook with the absolute one and back, never duplicating; inference sees through both", () => {
  const first = planLevel("s.json", undefined, "presence", claude);
  const swapped = planLevel("s.json", first.content, "presence", claude, WIN);
  assert.equal(swapped.action, "updated");
  assert.equal(commands(swapped.content).length, commands(first.content).length);
  assert.ok(commands(swapped.content).every((c) => c.startsWith(PREFIX)));
  assert.equal(planLevel("s.json", swapped.content, "presence", claude, WIN).action, "unchanged");
  assert.equal(inferLevel(JSON.parse(swapped.content), claude).level, "presence");
  assert.equal(planLevel("s.json", swapped.content, "presence", claude).action, "updated");
});

test("uninstall removes both forms and keeps the owner's hooks, BOM and CRLF", () => {
  const owner = { type: "command", command: "echo mine" };
  const text = "\uFEFF" + JSON.stringify({ theme: "dark", hooks: { Stop: [{ hooks: [owner, { type: "command", command: "relo hook stop", async: true }, { type: "command", command: `${PREFIX} hook remind` }] }] } }, null, 2).replaceAll("\n", "\r\n") + "\r\n";
  const off = planLevel("s.json", text, "off", claude, WIN);
  assert.equal(off.action, "removed");
  assert.ok(off.content.startsWith("\uFEFF"));
  assert.ok(off.content.includes("\r\n") && !/[^\r]\n/u.test(off.content));
  assert.deepEqual(JSON.parse(off.content.slice(1)).hooks.Stop[0].hooks, [owner]);
  const on = planLevel("s.json", text, "presence", claude, WIN);
  assert.ok(on.content.startsWith("\uFEFF") && !/[^\r]\n/u.test(on.content));
  assert.ok(commands(on.content).includes("echo mine"));
});

test("planLevelFile reads a CRLF+BOM settings.json from disk and writes it back with both", async () => {
  const dir = await mkdtemp(join(tmpdir(), "relo-win-"));
  const path = join(dir, "settings.json");
  await writeFile(path, "\uFEFF{\r\n  \"model\": \"x\"\r\n}\r\n");
  const planned = await planLevelFile(path, "claude-code", "presence", WIN);
  await commitLevel(planned);
  const written = await readFile(path, "utf8");
  assert.ok(written.startsWith("\uFEFF{\r\n"));
  assert.ok(!/[^\r]\n/u.test(written));
  assert.ok(commands(written).every((c) => c.startsWith(PREFIX)));
});

test("the MCP JSON and TOML editors and the instruction block keep BOM and CRLF", async () => {
  const dir = await mkdtemp(join(tmpdir(), "relo-win-mcp-"));
  const entry = wantedEntry("claude-code", WIN);
  const json = join(dir, ".claude.json");
  await writeFile(json, "\uFEFF{\r\n  \"a\": 1\r\n}\r\n");
  const planned = await planMcpFile(json, "claude-code", entry, {});
  assert.ok(planned.plan.content.startsWith("\uFEFF") && !/[^\r]\n/u.test(planned.plan.content), "json");
  const toml = join(dir, "config.toml");
  await writeFile(toml, "model = \"x\"\r\n");
  const t = await planMcpFile(toml, "codex", wantedEntry("codex", WIN), {});
  assert.ok(t.plan.content.includes("\r\n") && !/[^\r]\n/u.test(t.plan.content), "toml");
  const md = join(dir, "CLAUDE.md");
  await writeFile(md, "\uFEFF# Mine\r\n\r\ntext\r\n");
  const b = await planFile(md, { modules: ["notify"] });
  const content = b.plan.content;
  assert.ok(content.startsWith("\uFEFF# Mine"), "block keeps the BOM");
  assert.ok(!/[^\r]\n/u.test(content), "block keeps CRLF");
});

test("win32 descriptor paths: backslash homes, APPDATA", async () => {
  const probe = { env: { APPDATA: "C:\\Users\\x\\AppData\\Roaming" }, home: "C:\\Users\\x", platform: "win32" };
  const norm = (p) => p.replaceAll("\\", "/");
  assert.equal(norm(claude.install.global(probe)), "C:/Users/x/.claude/settings.json");
  assert.equal(norm(ADAPTERS.opencode.install.global(probe)), "C:/Users/x/.config/opencode/relo-hooks.json");
  assert.equal(norm(configDirectory(descriptors, probe).directory), "C:/Users/x/.config/opencode");
  assert.equal(norm(configDirectory(ADAPTERS.amp ?? (await import("../src/harness/adapters/amp/descriptor.mjs")).default, probe).directory), "C:/Users/x/.config/amp");
});

test("the OpenCode runner is always stamped with node and the entry, and the plugin has no shell fallback", async () => {
  const runner = ADAPTERS.opencode.install.runner(join(tmpdir(), "relo-hooks.json"));
  const stamped = runner.content(WIN);
  assert.ok(stamped.includes(JSON.stringify({ node: WIN.nodePath, script: WIN.entrypoint })));
  const own = runner.content({});
  assert.ok(!own.includes("const LAUNCH = null;"), "setup without a launch still stamps this CLI");
  const source = await readFile(fileURLToPath(new URL("../src/harness/adapters/opencode/plugin.js", import.meta.url)), "utf8");
  assert.ok(!source.includes("/bin/sh"));
  assert.ok(source.includes("windowsHide: true"));
});
