import "./hermetic-env.mjs";
// `relo admin`: the owner's cross-session surface. Normal session commands never reach other sessions; admin
// is the deliberate switch (the owner's terminal, or an agent the owner asked for help).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { run } from "../src/cli.mjs";

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

function shell(env, works) {
  const state = mkdtempSync(join(tmpdir(), "relo-admin-"));
  const calls = [];
  const respond = (body, status = 200) => ({ ok: status < 400, status, headers: new Headers(), json: async () => body });
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path: u.pathname, search: u.search, headers: init.headers, body });
    if (init.method === "GET" && u.pathname === "/api/works") return respond({ works });
    const finish = u.pathname.match(/^\/api\/works\/([^/]+)\/finish$/u);
    if (init.method === "POST" && finish) {
      const work = works.find((w) => w.id === decodeURIComponent(finish[1]));
      if (work.lifecycle === "open" && Date.now() - Date.parse(work.updatedAt) < 20 * 60_000) {
        return respond({ error: "work_running", message: "This work is still moving (updated 2 min ago)." }, 409);
      }
      return respond({ work: { ...work, lifecycle: body.result, outcome: body.outcome.readable } });
    }
    return respond({ error: "not_found" }, 404);
  };
  const overrides = {
    env: { XDG_STATE_HOME: state, HOME: state, ...env },
    loadConfig: async () => ({ apiUrl: "http://relo.test", token: "t".repeat(44) }),
    configPath: () => join(state, "config.json"),
    fetchImpl,
    stdinIsTTY: true,
  };
  const relo = async (...argv) => {
    const out = [];
    const code = await run(argv, { stdout: (l) => out.push(l), stderr: (l) => out.push(l), stdoutIsTTY: false }, overrides);
    return { code, text: out.join("\n") };
  };
  return { relo, calls, done: () => rmSync(state, { recursive: true, force: true }) };
}

const WORKS = () => [
  { id: "wrk_1300cd16-e93a-4d48-8e74-ac877c448d5b", lifecycle: "paused", sealed: false, goal: "Paused test card",
    plan: { steps: [{ id: "s1", label: "One", state: "current" }, { id: "s2", label: "Two", state: "open" }] },
    producer: { type: "agent_session", harness: "claude-code" }, updatedAt: minutesAgo(90) },
  { id: "wrk_867bc3c8-5c5d-4331-aebf-ca2bbb282a5f", lifecycle: "open", sealed: false, goal: "Release 0.18",
    plan: { steps: [{ id: "s1", label: "Build", state: "current" }] },
    producer: { type: "agent_session", harness: "codex" }, updatedAt: minutesAgo(2) },
];

test("an agent in a session administers every session's works only through relo admin", async (t) => {
  const s = shell({ CLAUDE_CODE_SESSION_ID: "admin-helper" }, WORKS());
  t.after(s.done);
  // Normal commands stay in the session: the overview is refused and points at admin.
  const refused = await s.relo("sessions");
  assert.equal(refused.code, 2);
  assert.match(refused.text, /relo admin sessions {3}\(only when the owner asks you for help\)/u);

  const listed = await s.relo("admin", "works");
  assert.equal(listed.code, 0, listed.text);
  assert.match(listed.text, /^2 open or paused works on the account:/u);
  assert.match(listed.text, /wrk_1300cd16-e93a-4d48-8e74-ac877c448d5b {2}paused {2}Claude Code {2}"Paused test card" {2}step 1\/2 {2}updated 2h ago {2}hanging/u);
  assert.match(listed.text, /wrk_867bc3c8-\S+ {2}open {2}Codex {2}"Release 0.18" {2}step 1\/1 {2}updated 2m ago {2}moving/u);
  // Admin acts as the owner's terminal: no session key travels with it.
  assert.equal(s.calls.at(-1).path, "/api/works");
  assert.equal(s.calls.at(-1).search, "?state=live");
  assert.equal(s.calls.at(-1).headers["relo-session-key"], undefined);

  const ended = await s.relo("admin", "finish", "wrk_1300cd16", "--dropped", "--outcome", "Test card, no longer needed");
  assert.equal(ended.code, 0, ended.text);
  assert.match(ended.text, /^Ended wrk_1300cd16-\S+ \(dropped\): "Test card, no longer needed" · was "Paused test card"/u);
  assert.deepEqual(s.calls.at(-1).body, { result: "dropped", outcome: { readable: "Test card, no longer needed" } });
  assert.equal(s.calls.at(-1).headers["relo-session-key"], undefined);
});

test("admin finish refuses a moving work, a short or missing id, and a missing outcome", async (t) => {
  const s = shell({ CLAUDE_CODE_SESSION_ID: "admin-helper-2" }, WORKS());
  t.after(s.done);
  const moving = await s.relo("admin", "finish", "wrk_867bc3c8", "--dropped", "--outcome", "Not hanging");
  assert.equal(moving.code, 2, moving.text);
  assert.match(moving.text, /^Refused: wrk_867bc3c8-\S+ is still moving; its own session or script finishes it/u);
  for (const argv of [["wrk_13"], ["wrk_1300cd16"], []]) {
    const r = await s.relo("admin", "finish", ...argv, ...(argv[0] === "wrk_1300cd16" ? [] : ["--outcome", "x y"]));
    assert.equal(r.code, 2, r.text);
    assert.match(r.text, /^Refused: /u);
  }
  const unknown = await s.relo("admin", "rm", "-rf");
  assert.equal(unknown.code, 2);
});
