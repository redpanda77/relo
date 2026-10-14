import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { execute } from "../src/cli.mjs";
import { inspectMcp } from "../src/mcp-config.mjs";

const NODE = "/opt/node/bin/node";
const ENTRY = "/opt/relo/bin/relo.mjs";

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "relo-mcp-setup-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(repo, ".git"), { recursive: true });
  const setup = (...argv) => execute(["setup", "--mcp", ...argv], { home, cwd: repo, env: {}, platform: "darwin", nodePath: NODE, entrypoint: ENTRY });
  const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  return { root, home, repo, setup, put, read: (path) => readFileSync(path, "utf8"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const JSON_CASES = [
  ["claude-code", "--global", (b) => join(b.home, ".claude.json"), "mcpServers", { type: "stdio", command: "relo", args: ["mcp"] }],
  ["claude-code", "--project", (b) => join(b.repo, ".mcp.json"), "mcpServers", { type: "stdio", command: "relo", args: ["mcp"] }],
  ["claude-desktop", "--global", (b) => join(b.home, "Library", "Application Support", "Claude", "claude_desktop_config.json"), "mcpServers", { command: NODE, args: [ENTRY, "mcp"] }],
  ["cursor", "--global", (b) => join(b.home, ".cursor", "mcp.json"), "mcpServers", { type: "stdio", command: NODE, args: [ENTRY, "mcp"] }],
  ["cursor", "--project", (b) => join(b.repo, ".cursor", "mcp.json"), "mcpServers", { type: "stdio", command: NODE, args: [ENTRY, "mcp"] }],
  ["gemini", "--global", (b) => join(b.home, ".gemini", "settings.json"), "mcpServers", { command: "relo", args: ["mcp"] }],
  ["gemini", "--project", (b) => join(b.repo, ".gemini", "settings.json"), "mcpServers", { command: "relo", args: ["mcp"] }],
  ["vscode", "--project", (b) => join(b.repo, ".vscode", "mcp.json"), "servers", { type: "stdio", command: NODE, args: [ENTRY, "mcp"] }],
];

for (const [agent, place, pathOf, key, entry] of JSON_CASES) {
  test(`${agent} ${place}: writes one entry under ${key}, is idempotent, and --remove restores the file exactly`, async () => {
    const box = sandbox();
    try {
      const path = pathOf(box);
      const before = JSON.stringify({ theme: "dark", [key]: { other: { command: "x", args: [] } }, tail: [1, 2] }, null, 2) + "\n";
      box.put(path, before);
      const dry = await box.setup("--agent", agent, place, "--dry-run");
      assert.equal(dry.data.dryRun, true);
      assert.equal(box.read(path), before, "dry run writes nothing");
      const first = await box.setup("--agent", agent, place);
      assert.equal(first.data.action, "added");
      const written = JSON.parse(box.read(path));
      assert.deepEqual(written[key].relo, entry);
      assert.deepEqual(written[key].other, { command: "x", args: [] }, "other servers stay");
      assert.equal(written.theme, "dark");
      assert.equal(box.read(path).endsWith("\n"), true);
      assert.match(box.read(path), /^ {2}"theme"/mu, "2-space formatting");
      const again = await box.setup("--agent", agent, place);
      assert.equal(again.data.action, "unchanged");
      assert.equal(inspectMcp({ env: {}, home: box.home, cwd: box.repo, platform: "darwin" }).state, "set");
      const removed = await box.setup("--remove", "--agent", agent);
      assert.equal(removed.data.action, "removed");
      assert.equal(box.read(path), before, "byte for byte");
      assert.equal((await box.setup("--remove")).data.action, "unchanged");
    } finally { box.cleanup(); }
  });
}

test("a missing config file is created and removing the only entry deletes it again", async () => {
  const box = sandbox();
  try {
    const path = join(box.repo, ".mcp.json");
    assert.equal((await box.setup("--agent", "claude-code", "--project")).data.action, "created");
    assert.deepEqual(JSON.parse(box.read(path)), { mcpServers: { relo: { type: "stdio", command: "relo", args: ["mcp"] } } });
    await box.setup("--remove");
    assert.equal(existsSync(path), false);
  } finally { box.cleanup(); }
});

test("one place only: a second location is refused without --move, which relocates the entry", async () => {
  const box = sandbox();
  try {
    await box.setup("--agent", "claude-code", "--global");
    await assert.rejects(box.setup("--agent", "claude-code", "--project"), (error) => /already set up in ~\/\.claude\.json/u.test(error.message) && /--move/u.test(error.details.hint));
    assert.equal(existsSync(join(box.repo, ".mcp.json")), false);
    const moved = await box.setup("--agent", "claude-code", "--project", "--move");
    assert.equal(moved.data.action, "moved");
    assert.equal(moved.data.from, "~/.claude.json");
    assert.equal(existsSync(join(box.repo, ".mcp.json")), true);
    assert.equal(existsSync(join(box.home, ".claude.json")), false);
    // A different harness is a different place: cursor is not blocked by claude-code.
    assert.equal((await box.setup("--agent", "cursor", "--global")).data.action, "created");
  } finally { box.cleanup(); }
});

test("choices must be explicit, supported and honest", async () => {
  const box = sandbox();
  try {
    await assert.rejects(box.setup(), /needs the harness/u);
    await assert.rejects(box.setup("--agent", "claude-code"), /pick the one file/u);
    await assert.rejects(box.setup("--agent", "emacs", "--global"), /Unknown agent/u);
    await assert.rejects(box.setup("--agent", "vscode", "--global"), /no global MCP config/u);
    await assert.rejects(box.setup("--agent", "claude-desktop", "--project"), /no project MCP config/u);
    await assert.rejects(box.setup("--agent", "cursor", "--global", "--project"), /exactly one/u);
    await assert.rejects(box.setup("--agent", "cursor", "--global", "--hooks"), /separate/u);
    assert.equal((await box.setup("--agent", "claude-desktop")).data.action, "created", "a single-place harness needs no scope flag");
    assert.equal((await box.setup("--agent", "vscode")).data.action, "created");
  } finally { box.cleanup(); }
});

test("a file that is not plain JSON, or already has someone else's `relo`, is never edited", async () => {
  const box = sandbox();
  try {
    const path = join(box.home, ".cursor", "mcp.json");
    box.put(path, '{ // comment\n}\n');
    await assert.rejects(box.setup("--agent", "cursor", "--global"), /not plain JSON/u);
    assert.equal(box.read(path), '{ // comment\n}\n');
    const own = '{"mcpServers":{"relo":{"command":"python","args":["server.py"]}}}';
    box.put(path, own);
    await assert.rejects(box.setup("--agent", "cursor", "--global"), /not Relo's/u);
    await assert.rejects(box.setup("--remove"), /not Relo's|unchanged/u).catch(() => {});
    assert.equal(box.read(path), own);
  } finally { box.cleanup(); }
});

test("an entry that moved (new node or bin path) is updated in place, keeping the owner's extra keys", async () => {
  const box = sandbox();
  try {
    const path = join(box.home, ".cursor", "mcp.json");
    box.put(path, JSON.stringify({ mcpServers: { relo: { type: "stdio", command: "/old/node", args: ["/old/relo.mjs", "mcp"], env: { A: "1" } } } }, null, 2) + "\n");
    assert.equal((await box.setup("--agent", "cursor", "--global")).data.action, "updated");
    const relo = JSON.parse(box.read(path)).mcpServers.relo;
    assert.deepEqual(relo, { type: "stdio", command: NODE, args: [ENTRY, "mcp"], env: { A: "1" } });
  } finally { box.cleanup(); }
});

// ---- Codex: TOML, Relo's table only, textually

const TOML_BEFORE = `# my codex config
model = "gpt-5"

[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]

[profiles.fast]
model = "mini"
`;

test("codex: Relo's [mcp_servers.relo] table is appended, idempotent, and removed leaving the file byte for byte", async () => {
  const box = sandbox();
  try {
    const path = join(box.home, ".codex", "config.toml");
    box.put(path, TOML_BEFORE);
    const dry = await box.setup("--agent", "codex", "--global", "--dry-run");
    assert.equal(dry.data.dryRun, true);
    assert.equal(box.read(path), TOML_BEFORE);
    assert.equal((await box.setup("--agent", "codex", "--global")).data.action, "added");
    const text = box.read(path);
    assert.ok(text.startsWith(TOML_BEFORE));
    assert.match(text, /\n\[mcp_servers\.relo\]\ncommand = "relo"\nargs = \["mcp"\]\ntool_timeout_sec = 330\n$/u);
    assert.equal((await box.setup("--agent", "codex", "--global")).data.action, "unchanged");
    assert.equal(inspectMcp({ env: {}, home: box.home, cwd: box.repo, platform: "darwin" }).files[0].agent, "codex");
    assert.equal((await box.setup("--remove", "--agent", "codex")).data.action, "removed");
    assert.equal(box.read(path), TOML_BEFORE);
  } finally { box.cleanup(); }
});

test("codex: a table in the middle of the file, with the owner's extra keys, is updated and removed cleanly", async () => {
  const box = sandbox();
  try {
    const path = join(box.home, ".codex", "config.toml");
    const mid = `a = 1\n\n[mcp_servers.relo]\ncommand = "/old/relo"\nargs = [\n  "mcp",\n]\nstartup_timeout_sec = 20\n\n[other]\nb = 2\n`;
    box.put(path, mid);
    assert.equal((await box.setup("--agent", "codex", "--global")).data.action, "updated");
    const text = box.read(path);
    assert.match(text, /command = "relo"\nargs = \[\n  "mcp",\n\]\nstartup_timeout_sec = 20\ntool_timeout_sec = 330\n\n\[other\]\nb = 2\n$/u);
    assert.equal((await box.setup("--agent", "codex", "--global")).data.action, "unchanged");
    await box.setup("--remove");
    assert.equal(box.read(path), "a = 1\n\n[other]\nb = 2\n");
  } finally { box.cleanup(); }
});

test("codex: honours CODEX_HOME, creates the file, and refuses a table that is not Relo's", async () => {
  const box = sandbox();
  try {
    const custom = join(box.root, "codex-home");
    const run = (...argv) => execute(["setup", "--mcp", ...argv], { home: box.home, cwd: box.repo, env: { CODEX_HOME: custom }, platform: "darwin", nodePath: NODE, entrypoint: ENTRY });
    assert.equal((await run("--agent", "codex", "--global")).data.action, "created");
    assert.equal(existsSync(join(custom, "config.toml")), true);
    await run("--remove");
    assert.equal(existsSync(join(custom, "config.toml")), false);
    const path = join(box.repo, ".codex", "config.toml");
    box.put(path, '[mcp_servers.relo]\ncommand = "python"\nargs = ["x.py"]\n');
    await assert.rejects(box.setup("--agent", "codex", "--project"), /not Relo's/u);
    box.put(path, 'mcp_servers.relo.command = "relo"\n');
    await assert.rejects(box.setup("--agent", "codex", "--project"), /will not edit/u);
  } finally { box.cleanup(); }
});

test("claude-desktop is macOS or Windows only", async () => {
  const box = sandbox();
  try {
    await assert.rejects(execute(["setup", "--mcp", "--agent", "claude-desktop"], { home: box.home, cwd: box.repo, env: {}, platform: "linux" }), /no MCP config file on this platform/u);
  } finally { box.cleanup(); }
});

test("doctor --full reports MCP entries informationally and never suggests them", async () => {
  const box = sandbox();
  try {
    const { setupWarnings } = await import("../src/doctor.mjs");
    const none = setupWarnings({ env: {}, home: box.home, cwd: box.repo, version: "0.10.0", platform: "darwin" });
    assert.deepEqual(none.mcp, { ok: true, state: "none" });
    await box.setup("--agent", "gemini", "--project");
    const set = setupWarnings({ env: {}, home: box.home, cwd: box.repo, version: "0.10.0", platform: "darwin" });
    assert.equal(set.mcp.ok, true);
    assert.deepEqual(set.mcp.files.map((file) => file.agent), ["gemini"]);
    assert.doesNotMatch(JSON.stringify(none), /setup --mcp/u);
  } finally { box.cleanup(); }
});
