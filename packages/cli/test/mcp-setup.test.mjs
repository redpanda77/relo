import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { execute } from "../src/cli.mjs";
import { findMcp } from "../src/install/mcp.mjs";

const NODE = "/opt/node/bin/node";
const ENTRY = "/opt/relo/bin/relo.mjs";

function sandbox(env = {}) {
  const root = mkdtempSync(join(tmpdir(), "relo-mcp-setup-"));
  const home = join(root, "home");
  const repo = join(root, "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(repo, ".git"), { recursive: true });
  const deps = { home, cwd: repo, env, platform: "darwin", nodePath: NODE, entrypoint: ENTRY };
  const relo = (argv, extra = {}) => execute(argv, { ...deps, ...extra });
  const mcpRow = (output) => [...output.data.changed, ...output.data.unchanged, ...output.data.skipped, ...output.data.errors].find((row) => row.kind === "mcp");
  const setup = async (...argv) => mcpRow(await relo(["setup", "--mcp", ...argv]));
  const uninstall = async () => mcpRow(await relo(["uninstall", "--apply"])) ?? { action: "unchanged" };
  const put = (path, text) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
  return { root, home, repo, relo, setup, uninstall, put, read: (path) => readFileSync(path, "utf8"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// Relo writes only user-level MCP entries: each works in every project, and a project's own file is shared.
const JSON_CASES = [
  ["claude-code", (b) => join(b.home, ".claude.json"), "mcpServers", { type: "stdio", command: "relo", args: ["mcp"] }],
  ["claude-desktop", (b) => join(b.home, "Library", "Application Support", "Claude", "claude_desktop_config.json"), "mcpServers", { command: NODE, args: [ENTRY, "mcp"] }],
  ["cursor", (b) => join(b.home, ".cursor", "mcp.json"), "mcpServers", { type: "stdio", command: NODE, args: [ENTRY, "mcp"] }],
  ["gemini", (b) => join(b.home, ".gemini", "settings.json"), "mcpServers", { command: "relo", args: ["mcp"] }],
];

for (const [agent, pathOf, key, entry] of JSON_CASES) {
  test(`${agent}: one entry under ${key}, idempotent, and relo uninstall restores the file exactly`, async () => {
    const box = sandbox();
    try {
      const path = pathOf(box);
      const before = JSON.stringify({ theme: "dark", [key]: { other: { command: "x", args: [] } }, tail: [1, 2] }, null, 2) + "\n";
      box.put(path, before);
      const dry = await box.relo(["setup", "--mcp", "--agent", agent, "--dry-run"]);
      assert.equal(dry.data.dryRun, true);
      assert.equal(box.read(path), before, "dry run writes nothing");
      assert.equal((await box.setup("--agent", agent)).action, "added");
      const written = JSON.parse(box.read(path));
      assert.deepEqual(written[key].relo, entry);
      assert.deepEqual(written[key].other, { command: "x", args: [] }, "other servers stay");
      assert.equal(written.theme, "dark");
      assert.match(box.read(path), /^ {2}"theme"/mu, "2-space formatting");
      assert.equal((await box.setup("--agent", agent)).action, "unchanged");
      assert.equal(findMcp({ env: {}, home: box.home, cwd: box.repo, platform: "darwin" }).length, 1);
      assert.equal((await box.uninstall()).action, "removed");
      assert.equal(box.read(path), before, "byte for byte");
    } finally { box.cleanup(); }
  });
}

test("a missing config file is created, and removing the only entry deletes it again", async () => {
  const box = sandbox();
  try {
    const path = join(box.home, ".cursor", "mcp.json");
    assert.equal((await box.setup("--agent", "cursor")).action, "created");
    assert.deepEqual(JSON.parse(box.read(path)), { mcpServers: { relo: { type: "stdio", command: NODE, args: [ENTRY, "mcp"] } } });
    await box.uninstall();
    assert.equal(existsSync(path), false);
  } finally { box.cleanup(); }
});

test("--mcp says why a harness gets no entry: none known, project-level, or not on this platform", async () => {
  const box = sandbox();
  try {
    assert.match((await box.setup("--agent", "opencode")).reason, /no MCP config is known/u);
    assert.match((await box.setup("--agent", "cursor", "--project")).reason, /user-level and works in every project/u);
    const linux = await box.relo(["setup", "--mcp", "--agent", "claude-desktop"], { platform: "linux" });
    assert.match(linux.data.skipped.find((row) => row.kind === "mcp").reason, /no MCP config file on this platform/u);
    assert.equal(existsSync(join(box.repo, ".cursor")), false);
  } finally { box.cleanup(); }
});

test("a file that is not plain JSON, or already has someone else's `relo`, is never edited", async () => {
  const box = sandbox();
  try {
    const path = join(box.home, ".cursor", "mcp.json");
    box.put(path, '{ // comment\n}\n');
    assert.match((await box.setup("--agent", "cursor")).reason, /not plain JSON/u);
    assert.equal(box.read(path), '{ // comment\n}\n');
    const own = '{"mcpServers":{"relo":{"command":"python","args":["server.py"]}}}';
    box.put(path, own);
    assert.match((await box.setup("--agent", "cursor")).reason, /not Relo's/u);
    await box.uninstall();
    assert.equal(box.read(path), own);
  } finally { box.cleanup(); }
});

test("an entry that moved (new node or bin path) is updated in place, keeping the owner's extra keys; --refresh does it too", async () => {
  const box = sandbox();
  try {
    const path = join(box.home, ".cursor", "mcp.json");
    const old = JSON.stringify({ mcpServers: { relo: { type: "stdio", command: "/old/node", args: ["/old/relo.mjs", "mcp"], env: { A: "1" } } } }, null, 2) + "\n";
    box.put(path, old);
    assert.equal((await box.setup("--agent", "cursor")).action, "updated");
    assert.deepEqual(JSON.parse(box.read(path)).mcpServers.relo, { type: "stdio", command: NODE, args: [ENTRY, "mcp"], env: { A: "1" } });
    box.put(path, old);
    const refreshed = await box.relo(["setup", "--refresh"]);
    assert.deepEqual(refreshed.data.changed.map((row) => [row.kind, row.action]), [["mcp", "updated"]]);
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
    assert.equal((await box.setup("--agent", "codex")).action, "added");
    const text = box.read(path);
    assert.ok(text.startsWith(TOML_BEFORE));
    assert.match(text, /\n\[mcp_servers\.relo\]\ncommand = "relo"\nargs = \["mcp"\]\ntool_timeout_sec = 330\n$/u);
    assert.equal((await box.setup("--agent", "codex")).action, "unchanged");
    assert.equal(findMcp({ env: {}, home: box.home, cwd: box.repo, platform: "darwin" })[0].agent, "codex");
    assert.equal((await box.uninstall()).action, "removed");
    assert.equal(box.read(path), TOML_BEFORE);
  } finally { box.cleanup(); }
});

test("codex: a table in the middle of the file, with the owner's extra keys, is updated and removed cleanly", async () => {
  const box = sandbox();
  try {
    const path = join(box.home, ".codex", "config.toml");
    box.put(path, `a = 1\n\n[mcp_servers.relo]\ncommand = "/old/relo"\nargs = [\n  "mcp",\n]\nstartup_timeout_sec = 20\n\n[other]\nb = 2\n`);
    assert.equal((await box.setup("--agent", "codex")).action, "updated");
    assert.match(box.read(path), /command = "relo"\nargs = \[\n  "mcp",\n\]\nstartup_timeout_sec = 20\ntool_timeout_sec = 330\n\n\[other\]\nb = 2\n$/u);
    await box.uninstall();
    assert.equal(box.read(path), "a = 1\n\n[other]\nb = 2\n");
  } finally { box.cleanup(); }
});

test("codex: honours CODEX_HOME, creates the file, and refuses a table that is not Relo's", async () => {
  const custom = mkdtempSync(join(tmpdir(), "relo-codex-home-"));
  const box = sandbox({ CODEX_HOME: custom });
  try {
    assert.equal((await box.setup("--agent", "codex")).action, "created");
    assert.equal(existsSync(join(custom, "config.toml")), true);
    await box.uninstall();
    assert.equal(existsSync(join(custom, "config.toml")), false);
    box.put(join(custom, "config.toml"), '[mcp_servers.relo]\ncommand = "python"\nargs = ["x.py"]\n');
    assert.match((await box.setup("--agent", "codex")).reason, /not Relo's/u);
    box.put(join(custom, "config.toml"), 'mcp_servers.relo.command = "relo"\n');
    assert.match((await box.setup("--agent", "codex")).reason, /will not edit/u);
  } finally { box.cleanup(); rmSync(custom, { recursive: true, force: true }); }
});

test("doctor --full reports MCP entries informationally and never suggests them", async () => {
  const box = sandbox();
  try {
    const { setupWarnings } = await import("../src/owner/doctor.mjs");
    const none = await setupWarnings({ env: {}, home: box.home, cwd: box.repo, version: "0.10.0", platform: "darwin" });
    assert.deepEqual(none.mcp, { ok: true, state: "none" });
    await box.setup("--agent", "gemini");
    const set = await setupWarnings({ env: {}, home: box.home, cwd: box.repo, version: "0.10.0", platform: "darwin" });
    assert.deepEqual(set.mcp.files.map((file) => file.agent), ["gemini"]);
    assert.doesNotMatch(JSON.stringify(none), /setup --mcp/u);
  } finally { box.cleanup(); }
});
