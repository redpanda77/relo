// Under Claude Desktop the sidebar title names the session; elsewhere today's sources do. The file is found once
// and its path kept in the observed state (local only); later due snapshots read just that file.
import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sessionName } from "../src/agent/session-name.mjs";
import { desktopTitleFor } from "../src/harness/adapters/claude-code/desktop-title.mjs";
import { SESSION_ID, hookBox } from "./hook-fixture.mjs";

const DESKTOP = { CLAUDE_CODE_ENTRYPOINT: "claude-desktop" };

/** Writes Desktop's metadata file for the session under `home` (the box's state folder). */
function desktopFile(home, content, name = "local_0001.json") {
  const folder = join(home, "Library", "Application Support", "Claude", "claude-code-sessions", "acct", "org");
  mkdirSync(folder, { recursive: true });
  const path = join(folder, name);
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}
const meta = (title) => ({ cliSessionId: SESSION_ID, title, titleSource: "user" });

/** A terminal-style title Claude Code keeps under CLAUDE_CONFIG_DIR for the box's repo. */
function terminalTitle(box, title) {
  const project = join(box.state, ".claude", "projects", box.repo.replace(/[^A-Za-z0-9]/gu, "-"), SESSION_ID);
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "custom-title.json"), JSON.stringify({ customTitle: title }));
}

const due = async (box) => { // a prompt then a stop: two phase changes, each a due snapshot
  await box.event("UserPromptSubmit", "prompt", {});
  await box.event("Stop", "stop", {});
};
const titles = (box) => box.entries.map((entry) => entry.meta?.title);

test("under Desktop the sidebar title wins over the terminal title", async () => {
  const box = await hookBox({ env: DESKTOP });
  terminalTitle(box, "Terminal title here");
  desktopFile(box.state, meta("Sidebar title here"));
  await box.event("SessionStart", "start", { source: "startup" });
  assert.equal(titles(box).at(-1), "Sidebar title here");
});

test("a terminal session ignores Desktop's files", async () => {
  const box = await hookBox({ env: { CLAUDE_CODE_ENTRYPOINT: "cli" } });
  desktopFile(box.state, meta("Sidebar title here"));
  await box.event("SessionStart", "start", { source: "startup" });
  assert.notEqual(titles(box).at(-1), "Sidebar title here");
});

test("a missing or malformed Desktop file falls back silently", async () => {
  const box = await hookBox({ env: DESKTOP });
  await box.event("SessionStart", "start", { source: "startup" });
  assert.equal(box.entries.length, 1, "no Desktop folder: the snapshot still goes out");
  assert.notEqual(titles(box).at(-1), "Sidebar title here");
  desktopFile(box.state, "{ not json");
  desktopFile(box.state, { cliSessionId: SESSION_ID, title: "/Users/someone/private" }, "local_0002.json");
  await due(box);
  assert.ok(box.entries.length >= 2);
  assert.ok(titles(box).every((title) => title === undefined || !title.includes("/")), "an unrecognized title is not used");
});

test("the file path is cached in the observed state, never sent, and a rename is picked up on the next due snapshot", async () => {
  const box = await hookBox({ env: DESKTOP });
  const path = desktopFile(box.state, meta("First sidebar name"));
  await box.event("SessionStart", "start", { source: "startup" });
  assert.equal(titles(box).at(-1), "First sidebar name");
  const files = [];
  const walk = async (dir) => { for (const e of await readdir(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) await walk(p); else files.push(p); } };
  await walk(box.state);
  const kept = files.filter((file) => !file.includes("Library") && !file.includes("outbox"));
  assert.ok(kept.some((file) => readFileSync(file, "utf8").includes(path)), "the path is kept in the observed state");
  writeFileSync(path, JSON.stringify(meta("Renamed sidebar name")));
  await due(box);
  assert.equal(titles(box).at(-1), "Renamed sidebar name");
  for (const entry of box.entries) assert.equal(JSON.stringify(entry.body).includes(path), false, "the path is not on the wire");
});

test("a cached path is read directly: no scan, so a folder-less home still answers", (t) => {
  const box = { state: mkdtempSync(join(tmpdir(), "relo-desktop-")) };
  t.after(() => rmSync(box.state, { recursive: true, force: true }));
  const path = desktopFile(box.state, meta("Cached sidebar name"));
  const nowhere = join(box.state, "no-such-home");
  assert.deepEqual(desktopTitleFor({ sessionId: SESSION_ID, home: nowhere, cachedPath: path }), { title: "Cached sidebar name", path, scanned: false });
  assert.equal(desktopTitleFor({ sessionId: SESSION_ID, home: nowhere }).title, undefined, "without the cache the scan finds nothing");
  writeFileSync(path, JSON.stringify({ ...meta("Another"), cliSessionId: "other-session" }));
  assert.equal(desktopTitleFor({ sessionId: SESSION_ID, home: nowhere, cachedPath: path }).title, undefined, "a file of another session is refused");
});

test("not-found is cached for ten minutes, on the hook path too", async () => {
  const box = await hookBox({ env: DESKTOP });
  await box.event("SessionStart", "start", { source: "startup" });
  desktopFile(box.state, meta("Late sidebar name"));
  await due(box); // a minute at most later: the miss is still trusted, no scan
  assert.notEqual(titles(box).at(-1), "Late sidebar name");
  box.clock += 11 * 60 * 1000;
  await due(box);
  assert.equal(titles(box).at(-1), "Late sidebar name");
});

// One rule for both callers: the same inputs give the same name through the hook and through a relo command.
const AGENT = { type: "agent_session", harness: "claude-code", sessionId: SESSION_ID, sessionKey: "k".repeat(43) };
const CASES = [
  ["desktop with a sidebar title", { CLAUDE_CODE_ENTRYPOINT: "claude-desktop" }, meta("Sidebar title here"), "Sidebar title here"],
  ["terminal ignores Desktop", { CLAUDE_CODE_ENTRYPOINT: "cli" }, meta("Sidebar title here"), "Terminal title here"],
  ["no entrypoint ignores Desktop", {}, meta("Sidebar title here"), "Terminal title here"],
  ["desktop with a malformed file", { CLAUDE_CODE_ENTRYPOINT: "claude-desktop" }, "{ nope", "Terminal title here"],
  ["desktop with a path as title", { CLAUDE_CODE_ENTRYPOINT: "claude-desktop" }, meta("/Users/someone/private"), "Terminal title here"],
];
for (const [label, env, file, expected] of CASES) {
  test(`hook and command agree: ${label}`, async () => {
    const box = await hookBox({ env });
    terminalTitle(box, "Terminal title here");
    desktopFile(box.state, file);
    await box.event("SessionStart", "start", { source: "startup" });
    const viaHook = titles(box).at(-1);
    const viaCommand = sessionName({ caller: AGENT, env, home: box.state, cwd: box.repo,
      sessionsDirectory: join(box.state, "sessions"), now: () => box.clock });
    assert.equal(viaHook, expected);
    assert.equal(viaCommand, expected);
  });
}
