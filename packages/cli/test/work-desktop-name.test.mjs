// An agent's `relo work` card takes the Claude Desktop sidebar name too (same precedence as the hooks).
import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { run } from "../src/cli.mjs";
import { ReloApiClient } from "../src/shared/api-client.mjs";

const SESSION = "0f1e2d3c-4b5a-4969-8778-695a4b3c2d1e";
const CWD = "/work/example-app";

function setup(t, env = {}) {
  const state = mkdtempSync(join(tmpdir(), "relo-work-desktop-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const claude = join(state, "claude");
  const project = join(claude, "projects", "-work-example-app", SESSION);
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "custom-title.json"), JSON.stringify({ customTitle: "Terminal title here" }));
  const folder = join(state, "Library", "Application Support", "Claude", "claude-code-sessions", "acct", "org");
  mkdirSync(folder, { recursive: true });
  const file = join(folder, "local_0001.json");
  const calls = [];
  let started = null;
  const respond = (o, status = 200) => ({ ok: status < 400, status, headers: new Headers(), json: async () => o });
  const fetchImpl = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, body });
    if (init.method === "GET") return respond({ open: started, parked: [] });
    if (init.method === "PATCH") return respond({ disposition: "updated", work: { ...started, version: 2 }, parked: [], replayed: false, ignored: [] });
    const work = { id: "wrk_aaaaaaa1-0000", version: 1, lifecycle: "open", sealed: false, goal: "Fix it", status: null, plan: { version: 1, next: 1, complete: false, steps: [] }, progress: null };
    started = work;
    return respond({ disposition: "started", work, parked: [], replayed: false, ignored: [] }, 201);
  };
  const clock = { now: Date.now() };
  const overrides = {
    env: { XDG_STATE_HOME: state, CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_CONFIG_DIR: claude, ...env },
    cwd: CWD, home: state, now: () => clock.now,
    identityDefaults: () => ({ providerName: "Claude Code", project: "example-app" }),
    loadConfig: async () => ({ apiUrl: "http://relo.test", token: "t".repeat(44) }),
    configPath: () => join(state, "config.json"),
    clientFactory: (c) => new ReloApiClient({ apiUrl: c.apiUrl, token: c.token, fetchImpl }),
  };
  const start = async () => {
    assert.equal(await run(["work", "start", "--goal", "Fix it"], { stdout: () => {}, stderr: () => {}, stdoutIsTTY: false }, overrides), 0);
    return calls.find((call) => call.method === "POST").body.context.threadName;
  };
  // The topic the last write sent: a start's context, else an update's (only sent when the name changed).
  const update = async () => {
    const before = calls.length;
    const err = [];
    const code = await run(["work", "update", "--status", "Reading the crash report"], { stdout: (l) => err.push(l), stderr: (l) => err.push(l), stdoutIsTTY: false }, overrides);
    assert.equal(code, 0, JSON.stringify(err));
    const patch = calls.slice(before).find((call) => call.method === "PATCH");
    return patch?.body?.context?.threadName ?? sessionFileOf({ state }).sessionName;
  };
  return { state, file, start, update, clock };
}
const meta = (title) => JSON.stringify({ cliSessionId: SESSION, title });

test("under Desktop a started work takes the sidebar name over the terminal title", async (t) => {
  const box = setup(t, { CLAUDE_CODE_ENTRYPOINT: "claude-desktop" });
  writeFileSync(box.file, meta("Sidebar title here"));
  assert.equal(await box.start(), "Sidebar title here");
});

test("a terminal session keeps its terminal title", async (t) => {
  const box = setup(t, { CLAUDE_CODE_ENTRYPOINT: "cli" });
  writeFileSync(box.file, meta("Sidebar title here"));
  assert.equal(await box.start(), "Terminal title here");
});

test("a malformed Desktop file falls back to the terminal title", async (t) => {
  const box = setup(t, { CLAUDE_CODE_ENTRYPOINT: "claude-desktop" });
  writeFileSync(box.file, "{ not json");
  assert.equal(await box.start(), "Terminal title here");
});

const sessionFileOf = (box) => JSON.parse(readFileSync(join(box.state, "relo", "sessions", `${readdirSync(join(box.state, "relo", "sessions")).find((n) => n.endsWith(".json"))}`), "utf8"));

test("the scan runs once: the found path is kept in the session's file and reused", async (t) => {
  const box = setup(t, { CLAUDE_CODE_ENTRYPOINT: "claude-desktop" });
  writeFileSync(box.file, meta("Sidebar title here"));
  assert.equal(await box.start(), "Sidebar title here");
  assert.equal(sessionFileOf(box).titleCache.titlePath, box.file);
  // The file is renamed in place: the kept path finds it. Moved away entirely, the kept path alone cannot.
  writeFileSync(box.file, meta("Renamed sidebar title"));
  assert.equal(await box.update(), "Renamed sidebar title");
});

test("not-found is kept for ten minutes", async (t) => {
  const box = setup(t, { CLAUDE_CODE_ENTRYPOINT: "claude-desktop" });
  assert.equal(await box.start(), "Terminal title here");
  assert.ok(Number.isFinite(sessionFileOf(box).titleCache.titleMissAt));
  writeFileSync(box.file, meta("Sidebar title here"));
  assert.equal(await box.update(), "Terminal title here", "no rescan yet");
  box.clock.now += 11 * 60 * 1000;
  assert.equal(await box.update(), "Sidebar title here");
});
