import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { run } from "../src/cli.mjs";
import { ReloApiClient } from "../src/shared/api-client.mjs";
import { claudeSessionName, cleanSessionName, SESSION_NAME_MAX } from "../src/harness/adapters/claude-code/session-name.mjs";
import { b64u, generateKeyPair, keyId, prekeySigningInput, signBytes } from "../src/crypto/e2ee.mjs";

const SESSION = "0f1e2d3c-4b5a-4969-8778-695a4b3c2d1e";
const CWD = "/work/example-app";

/** A Claude config dir with one project directory for CWD; returns paths to fill. */
function claudeHome(t) {
  const root = mkdtempSync(join(tmpdir(), "relo-claude-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "projects", "-work-example-app");
  mkdirSync(project, { recursive: true });
  return {
    root,
    project,
    title(name) {
      mkdirSync(join(project, SESSION), { recursive: true });
      writeFileSync(join(project, SESSION, "custom-title.json"), JSON.stringify({ customTitle: name }));
    },
    transcript(records, { padding = 0 } = {}) {
      const filler = { type: "user", message: { role: "user", content: "x".repeat(1000) } };
      const lines = [...Array(padding).fill(filler), ...records].map((r) => JSON.stringify(r));
      writeFileSync(join(project, `${SESSION}.jsonl`), `${lines.join("\n")}\n`);
    },
  };
}

const read = (home, overrides = {}) => claudeSessionName({ sessionId: SESSION, env: { CLAUDE_CONFIG_DIR: home.root }, cwd: CWD, ...overrides });

test("the title file names the session", (t) => {
  const home = claudeHome(t);
  home.title("Release checklist review");
  home.transcript([{ type: "custom-title", customTitle: "An older title", sessionId: SESSION }]);
  assert.equal(read(home), "Release checklist review");
  // From a subdirectory of the project, and from an unrelated directory (bounded scan).
  assert.equal(read(home, { cwd: `${CWD}/packages/web` }), "Release checklist review");
  assert.equal(read(home, { cwd: "/elsewhere" }), "Release checklist review");
});

test("without a title file the transcript's last title wins, then Claude's generated title or summary", (t) => {
  const home = claudeHome(t);
  home.transcript([
    { type: "summary", summary: "Summary of the login work" },
    { type: "custom-title", customTitle: "Login crash", sessionId: SESSION },
    { type: "custom-title", customTitle: "Login crash fix", sessionId: SESSION },
    { type: "agent-name", agentName: "Login crash fix", sessionId: SESSION },
  ]);
  assert.equal(read(home), "Login crash fix");
  home.transcript([{ type: "ai-title", aiTitle: "Theme palette refresh" }, { type: "summary", summary: "Older summary" }]);
  assert.equal(read(home), "Theme palette refresh");
  home.transcript([{ type: "summary", summary: "Inbox sync investigation", leafUuid: "abc" }]);
  assert.equal(read(home), "Inbox sync investigation");
});

test("nothing found, a bad session id or unsafe titles give no name", (t) => {
  const home = claudeHome(t);
  assert.equal(read(home), undefined);
  assert.equal(read(home, { sessionId: "../../etc" }), undefined);
  assert.equal(read(home, { env: { CLAUDE_CONFIG_DIR: join(home.root, "missing") } }), undefined);
  home.title("Fix /Users/someone/project/file.ts");
  home.transcript([{ type: "custom-title", customTitle: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" }]);
  assert.equal(read(home), undefined);
  assert.equal(cleanSessionName("  Two\nlines\u0007 here  "), "Two lines here");
  assert.equal(cleanSessionName("12345"), undefined);
  const long = cleanSessionName("word ".repeat(40));
  assert.equal(Array.from(long).length <= SESSION_NAME_MAX, true);
  assert.match(long, /…$/u);
});

test("a huge transcript is read only at its tail, quickly", (t) => {
  const home = claudeHome(t);
  // ~12 MB of turns before the title, as in a long session.
  home.transcript([{ type: "custom-title", customTitle: "Long running session", sessionId: SESSION }], { padding: 12_000 });
  const started = performance.now();
  assert.equal(read(home), "Long running session");
  assert.ok(performance.now() - started < 200, "bounded read");
  // A title only at the very start of a huge transcript is out of reach: no name, no full read.
  home.transcript([{ type: "custom-title", customTitle: "Early title" }, ...Array(12_000).fill({ type: "user", message: { content: "y".repeat(1000) } })]);
  assert.equal(read(home), undefined);
});

function fakeServer() {
  const calls = [];
  let work;
  const respond = (o, status = 200) => ({ ok: status < 400, status, headers: new Headers(), json: async () => o });
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path: u.pathname, body });
    if (init.method === "GET") return respond({ open: work ?? null, parked: [] });
    if (init.method === "POST") {
      work = { id: "wrk_aaaaaaa1-0000", version: 1, lifecycle: "open", sealed: Boolean(body.sealed), goal: body.goal.readable ?? null, status: null, plan: { version: 1, next: 1, complete: false, steps: [] }, progress: null };
      return respond({ disposition: "started", work, parked: [], replayed: false, ignored: [] }, 201);
    }
    work = { ...work, version: work.version + 1, status: body.status?.readable ?? work.status };
    return respond({ disposition: "updated", work, parked: [], replayed: false, ignored: [] });
  };
  return { fetchImpl, calls };
}

test("relo work sends the session's name as the topic and refreshes it once when Claude renames the session", async (t) => {
  const home = claudeHome(t);
  const state = mkdtempSync(join(tmpdir(), "relo-work-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const server = fakeServer();
  const overrides = {
    env: { XDG_STATE_HOME: state, CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_CONFIG_DIR: home.root },
    cwd: CWD,
    identityDefaults: () => ({ providerName: "Claude Code", project: "example-app" }),
    loadConfig: async () => ({ apiUrl: "http://relo.test", token: "t".repeat(44) }),
    configPath: () => join(state, "config.json"),
    clientFactory: (c) => new ReloApiClient({ apiUrl: c.apiUrl, token: c.token, fetchImpl: server.fetchImpl }),
  };
  const relo = async (...argv) => run(argv, { stdout: () => {}, stderr: () => {}, stdoutIsTTY: false }, overrides);

  home.transcript([{ type: "custom-title", customTitle: "New session", sessionId: SESSION }]);
  assert.equal(await relo("work", "start", "--goal", "Fix the login crash"), 0);
  const start = server.calls.find((c) => c.method === "POST");
  assert.deepEqual(start.body.context, { providerName: "Claude Code", project: "example-app", threadName: "New session" });

  assert.equal(await relo("work", "update", "--status", "Reading the crash report"), 0);
  let patches = server.calls.filter((c) => c.method === "PATCH");
  assert.equal(patches.at(-1).body.context, undefined, "an unchanged name is not sent again");

  home.title("Login crash fix");
  assert.equal(await relo("work", "update", "--status", "Writing the fix"), 0);
  patches = server.calls.filter((c) => c.method === "PATCH");
  assert.deepEqual(patches.at(-1).body.context, { threadName: "Login crash fix" });

  assert.equal(await relo("work", "update", "--status", "Testing the fix"), 0);
  patches = server.calls.filter((c) => c.method === "PATCH");
  assert.equal(patches.at(-1).body.context, undefined);
});

const PHONE = "dev_00000000-0000-4000-8000-00000000000b";

function phoneKeys(deviceId) {
  const identity = generateKeyPair();
  const prekey = generateKeyPair();
  const createdAt = new Date().toISOString();
  return { deviceId, name: "iPhone",
    identityKey: { keyId: keyId(identity.publicKey), publicKey: b64u(identity.publicKey), changedAt: createdAt },
    prekey: { prekeyId: "pk_1", publicKey: b64u(prekey.publicKey), createdAt, stale: false,
      signature: b64u(signBytes(identity.privateKey, prekeySigningInput({ deviceId, prekeyId: "pk_1", publicKey: prekey.publicKey, createdAt }))) } };
}

test("on an end-to-end account the session's name goes as a handle, never readable", async (t) => {
  const home = claudeHome(t);
  const state = mkdtempSync(join(tmpdir(), "relo-work-"));
  t.after(() => rmSync(state, { recursive: true, force: true }));
  const server = fakeServer();
  const keys = phoneKeys(PHONE);
  const overrides = {
    env: { XDG_STATE_HOME: state, CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_CONFIG_DIR: home.root,
      RELO_KEY_STORE_PATH: join(state, "e2ee.json") },
    cwd: CWD,
    identityDefaults: () => ({ providerName: "Claude Code", project: "example-app" }),
    loadConfig: async () => ({ apiUrl: "http://relo.test", token: "t".repeat(44) }),
    configPath: () => join(state, "config.json"),
    clientFactory: (c) => Object.assign(new ReloApiClient({ apiUrl: c.apiUrl, token: c.token, fetchImpl: server.fetchImpl }), {
      listDevices: async () => ({ hasMore: false, cursor: null, devices: [{ deviceId: PHONE, liveActivityAuthorization: "authorized" }] }),
      listDeviceKeys: async () => ({ devices: [keys] }),
      publishClientKey: async () => ({}),
    }),
  };
  const relo = async (...argv) => run(argv, { stdout: () => {}, stderr: () => {}, stdoutIsTTY: false }, overrides);

  home.title("Secret project planning");
  assert.equal(await relo("work", "start", "--goal", "Fix the login crash"), 0);
  const start = server.calls.find((c) => c.method === "POST");
  assert.ok(start.body.sealed, "the work is sealed");
  assert.match(start.body.context.threadName, /^t-[a-z2-7]{16}$/u);
  assert.match(start.body.context.project, /^p-[a-z2-7]{16}$/u);
  assert.equal(start.body.context.providerName, "Claude Code");
  assert.ok(!JSON.stringify(start.body).includes("Secret project"), "the name never reaches the server");
  assert.ok(!JSON.stringify(start.body).includes("example-app"), "nor the project");

  home.title("Secret project rollout");
  assert.equal(await relo("work", "update", "--status", "Writing the fix"), 0);
  const patch = server.calls.filter((c) => c.method === "PATCH").at(-1);
  assert.match(patch.body.context.threadName, /^t-[a-z2-7]{16}$/u);
  assert.notEqual(patch.body.context.threadName, start.body.context.threadName);
  assert.ok(!JSON.stringify(patch.body).includes("Secret project"));
  // This computer keeps handle → name to resolve them; the phone gets the same map inside the sealed card.
  const known = JSON.parse(readFileSync(join(state, "relo", "names.json"), "utf8"));
  assert.equal(known[patch.body.context.threadName], "Secret project rollout");
});
