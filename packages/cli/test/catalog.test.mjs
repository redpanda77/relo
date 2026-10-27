// One descriptor per harness (harness/adapters/<id>/descriptor.mjs) is the only place a harness fact
// lives; the catalog derives detection, labels, session variables and paths from them.
import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { posix } from "./posix-path.mjs";
import { fileURLToPath } from "node:url";
import { HARNESSES, SESSION_VARIABLES, detectHarness, harnessFor, harnessLabel } from "../src/harness/catalog.mjs";
import { configDirectory, harnessPath, projectPath } from "../src/harness/paths.mjs";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
const KEYS = new Set(["id", "label", "aliases", "detect", "ephemeral", "sessionVariable", "config", "instructions", "skills", "agents", "agentFormat", "statusLine", "legacySkills", "inherits", "hooks", "mcp", "mcpClient", "processPattern", "installation"]);
const home = "/home/owner";

test("ids, aliases and labels are unique, and every descriptor has only known fields", () => {
  const names = HARNESSES.flatMap((harness) => [harness.id, ...harness.aliases]);
  assert.equal(new Set(names).size, names.length, "an id or alias names two harnesses");
  assert.equal(new Set(HARNESSES.map((harness) => harness.label)).size, HARNESSES.length);
  for (const harness of HARNESSES) {
    for (const key of Object.keys(harness)) assert.ok(KEYS.has(key), `${harness.id}: unknown field ${key}`);
    assert.equal(harnessFor(harness.id.toUpperCase()), harness);
    for (const alias of harness.aliases) assert.equal(harnessFor(alias), harness);
  }
  assert.equal(harnessLabel("gemini"), "Gemini CLI");
  assert.equal(harnessLabel("aider"), "aider", "an unknown id is shown as given");
});

test("detection reads only each harness's own markers, in order", () => {
  assert.equal(detectHarness({ CLAUDECODE: "1" })?.id, "claude-code");
  assert.equal(detectHarness({ CODEX_THREAD_ID: "t" })?.id, "codex");
  assert.equal(detectHarness({ CODEX_HOME: "/x" }), undefined, "CODEX_HOME is only config");
  assert.equal(detectHarness({ OPENCODE: "1" })?.id, "opencode");
  assert.equal(detectHarness({ ANTIGRAVITY_CONVERSATION_ID: "c" })?.id, "antigravity");
  assert.equal(detectHarness({ GEMINI_CLI: "1" })?.id, "gemini");
  assert.equal(detectHarness({ ANTIGRAVITY_AGENT: "1", GEMINI_CLI: "1" })?.id, "antigravity", "Antigravity's agent shell, even with Gemini's marker");
  assert.equal(detectHarness({ CURSOR_AGENT: "1" })?.id, "cursor");
  assert.equal(detectHarness({}), undefined);
  assert.deepEqual(SESSION_VARIABLES, [["claude-code", "CLAUDE_CODE_SESSION_ID"], ["codex", "CODEX_THREAD_ID"], ["opencode", "OPENCODE_SESSION_ID"], ["antigravity", "ANTIGRAVITY_CONVERSATION_ID"]]);
});

test("paths resolve under the home folder, and the harness's own variable moves its config folder", () => {
  const claude = harnessFor("claude-code");
  assert.equal(posix(harnessPath(claude, claude.instructions.global, { env: {}, home })), "/home/owner/.claude/CLAUDE.md");
  assert.equal(posix(harnessPath(claude, claude.skills, { env: { CLAUDE_CONFIG_DIR: "/w/.claude-work" }, home })), "/w/.claude-work/skills");
  const configured = configDirectory(claude, { env: { CLAUDE_CONFIG_DIR: "/w/.claude-work" }, home });
  assert.deepEqual({ ...configured, directory: posix(configured.directory) }, { directory: "/w/.claude-work", custom: true });
  const codex = harnessFor("codex");
  assert.equal(posix(harnessPath(codex, codex.mcp.global, { env: { CODEX_HOME: "/c" }, home })), "/c/config.toml");
  assert.equal(posix(harnessPath(codex, codex.skills, { env: { CODEX_HOME: "/c" }, home })), "/home/owner/.agents/skills", "~/ paths ignore the config folder");
  const copilot = harnessFor("copilot");
  assert.equal(posix(harnessPath(copilot, copilot.instructions.global, { env: { COPILOT_HOME: "/p" }, home })), "/p/copilot-instructions.md");
  const desktop = harnessFor("claude-desktop");
  assert.equal(harnessPath(desktop, desktop.mcp.global, { env: {}, home, platform: "linux" }), undefined, "no file on this platform");
  assert.equal(posix(harnessPath(desktop, desktop.mcp.global, { env: {}, home, platform: "darwin" })),
    "/home/owner/Library/Application Support/Claude/claude_desktop_config.json");
  assert.equal(posix(projectPath(".mcp.json", { cwd: "/nowhere/repo" })), "/nowhere/repo/.mcp.json");
  for (const harness of HARNESSES) {
    for (const spec of [harness.instructions?.global, harness.skills, harness.legacySkills, harness.hooks?.global, harness.mcp?.global]) {
      if (spec === undefined) continue;
      const path = harnessPath(harness, spec, { env: {}, home, platform: "darwin" });
      assert.ok(posix(path)?.startsWith(`${home}/`), `${harness.id}: ${spec} resolves to ${path}`);
    }
  }
});

test("each harness has its own skills folder; only Codex and the shared folder are one", () => {
  const folders = new Map();
  for (const harness of HARNESSES.filter((candidate) => candidate.skills)) {
    const path = harnessPath(harness, harness.skills, { env: {}, home });
    folders.set(path, [...(folders.get(path) ?? []), harness.id]);
  }
  const shared = [...folders.values()].filter((ids) => ids.length > 1);
  assert.deepEqual(shared, [["codex", "agents"]]);
});

const FACTS = /CLAUDE_CONFIG_DIR|CODEX_HOME|COPILOT_HOME|CLAUDE_CODE_SESSION_ID|CODEX_THREAD_ID|GEMINI_CLI|CURSOR_AGENT|CLAUDECODE|"Claude Code"|"Gemini CLI"/u;

test("no harness fact is written outside its descriptor and adapter", () => {
  for (const name of readdirSync(SRC, { recursive: true }).filter((file) => file.endsWith(".mjs"))) {
    const file = relative(SRC, join(SRC, name)).split(sep).join("/");
    if (file.startsWith("harness/adapters/")) continue;
    const code = readFileSync(join(SRC, name), "utf8").split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*\*)/u.test(line));
    for (const line of code) assert.doesNotMatch(line, FACTS, `${file}: ${line.trim()}`);
  }
});

test("the README's harness matrix says what each descriptor sets up", async () => {
  const { ADAPTERS } = await import("../src/harness/adapters/index.mjs");
  const readme = readFileSync(resolve(SRC, "..", "README.md"), "utf8");
  const rows = readme.split("<!-- harness-matrix:start -->")[1].split("<!-- harness-matrix:end -->")[0]
    .trim().split("\n").slice(2).map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
  const mark = (value) => (value ? "yes" : "—");
  const expected = HARNESSES
    .filter((harness) => harness.instructions || harness.skills || harness.hooks || harness.mcp)
    .map((harness) => [harness.label, `\`${harness.id}\``, mark(harness.instructions), mark(harness.skills),
      mark(harness.hooks && ADAPTERS[harness.id]), mark(harness.mcp)]);
  assert.deepEqual(rows, expected);
});

test("the hook path's loader has one loader per adapter and loads the same adapter as the index", async () => {
  const { ADAPTERS, ADAPTER_IDS, adapterFor } = await import("../src/harness/adapters/index.mjs");
  const { LOADER_IDS, loadAdapter } = await import("../src/harness/adapters/load.mjs");
  assert.deepEqual([...LOADER_IDS].sort(), [...ADAPTER_IDS].sort());
  for (const id of ADAPTER_IDS) assert.equal(await loadAdapter(id.toUpperCase()), ADAPTERS[id]);
  assert.equal(await loadAdapter("gemini-cli"), adapterFor("gemini-cli"), "an alias goes through the index");
  assert.equal(await loadAdapter(), ADAPTERS["claude-code"]);
  assert.equal(await loadAdapter("aider"), undefined);
});
