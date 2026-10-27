import "./hermetic-env.mjs";
import { loginKeyStoreEnv } from "./cli-fixtures.mjs";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { qrText } from "../src/shared/qr.mjs";
import { ApiError, AuthError, EXIT } from "../src/shared/errors.mjs";
import { GUIDE, HELP } from "../src/help.mjs";
import { run } from "../src/cli.mjs";
import { VERSION } from "../src/version.mjs";
import { COMMANDS } from "../src/registry.mjs";
import { OPTIONS } from "../src/shared/options.mjs";
import { cardKey } from "../src/messages/card-context.mjs";
import { detectAccount } from "../src/shared/identity.mjs";
import { cardOwner, detectAgent, detectCaller, waitsShort } from "../src/caller.mjs";
import { cardDependencies, fakeCards, fakeHome } from "./fake-cards.mjs";

/** The card key the caller of `env` gets: its own card's owner comes from the caller (as its message port says). */
const keyFor = ({ env = {}, ...rest }) => cardKey({ ...rest, env, owner: cardOwner(detectCaller(env)) });
const ownerOf = (env) => cardOwner(detectCaller(env));


const PHONE = "dev_abcdefghijkl";
const SPARE = "dev_mnopqrstuvwx";
const DEVICE_CODE = "d".repeat(43);
const TOKEN = `relo_${"s".repeat(43)}`;
const SCOPES = ["activities:read", "activities:write", "devices:read", "interactions:create", "interactions:read",
  "notifications:send", "services:read", "services:write"];
const topic = ["--topic", "Release 0.7.57"];

async function cli(argv, dependencies) {
  const stdout = [];
  const exitCode = await run(argv, { stdout: (line) => stdout.push(line), stderr: () => {}, stdoutIsTTY: false }, dependencies);
  return { exitCode, line: stdout[0] ? JSON.parse(stdout[0]) : undefined };
}

const authorized = (deviceId = PHONE) => ({ deviceId, liveActivityAuthorization: "authorized" });
const devicePage = (devices) => ({ hasMore: false, cursor: null, devices });

/** In-memory config store standing in for the 0600 file; tests never touch a real one. */
function memoryConfig(initial = {}) {
  const state = { config: { apiUrl: "https://relo.example", token: "x".repeat(44), revision: "r1", path: "/cfg/c.json", ...initial }, writes: [] };
  return { state, deps: {
    configPath: () => "/cfg/c.json",
    loadConfig: async () => state.config,
    loadStoredConfig: async () => state.config,
    writeConfig: async (_path, config) => { state.writes.push(config); state.config = { ...state.config, ...config, revision: `r${state.writes.length + 1}` };
      for (const key of ["phoneTest", "pendingTest"]) if (config[key] === undefined) delete state.config[key]; },
  } };
}

/** A clock that only waits advance, so a 100s wait costs no real time. */
function clocked(client) {
  const clock = { now: 1_000_000, polls: [] };
  const base = client.waitForInteraction;
  client.waitForInteraction = async (id, seconds) => { clock.polls.push(seconds); clock.now += seconds * 1_000; return base(id, seconds); };
  return clock;
}

function testSetup({ answer = "yes", answerAfterPolls = 1, devices = [authorized()], config = {}, env = {} } = {}) {
  const fake = fakeCards({ answer, answerAfterPolls });
  fake.client.listDevices = async () => devicePage(devices);
  const clock = clocked(fake.client);
  const memory = memoryConfig(config);
  const deps = { ...cardDependencies(fake.client, { env }), ...memory.deps, now: () => clock.now };
  return { ...fake, clock, memory, deps };
}

// ---- harness detection -------------------------------------------------------------------------

test("agent harnesses are recognized only by confirmed markers", () => {
  assert.equal(detectAgent({ CLAUDECODE: "1" }), "Claude Code");
  assert.equal(detectAgent({ CODEX_THREAD_ID: "t" }), "Codex");
  assert.equal(detectAgent({ OPENCODE: "1" }), "OpenCode");
  assert.equal(detectAgent({ GEMINI_CLI: "1" }), "Gemini CLI");
  assert.equal(detectAgent({ CURSOR_AGENT: "1" }), "Cursor");
  for (const env of [{}, { GEMINI_CLI: "0" }, { CURSOR_AGENT: " " }, { COPILOT_CLI: "1" }, { AGENT: "goose" }, { CODEX_HOME: "/x" }]) {
    assert.equal(detectAgent(env), undefined, JSON.stringify(env));
  }
});

test("RELO_SESSION gives a script or the owner's shell one card per session, never a harness", () => {
  assert.deepEqual(ownerOf({ RELO_SESSION: " s-42 " }), { label: "relo", id: "s-42" });
  assert.deepEqual(ownerOf({ RELO_SESSION: "s", CLAUDE_CODE_SESSION_ID: "c" }), { label: "claude-code", id: "c" });
  assert.equal(ownerOf({ RELO_SESSION: "s", GEMINI_CLI: "1" }), undefined);
  assert.equal(ownerOf({ GEMINI_CLI: "1" }), undefined);
  const a = keyFor({ env: { RELO_SESSION: "one" }, context: { providerName: "Aider", project: "p", threadName: "t" } });
  const b = keyFor({ env: { RELO_SESSION: "one" }, context: { providerName: "Aider", project: "p", threadName: "other" } });
  const c = keyFor({ env: { RELO_SESSION: "two" }, context: {} });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(waitsShort(detectCaller({ RELO_SESSION: "s" })), true);
  assert.equal(waitsShort(detectCaller({ GEMINI_CLI: "1" })), true);
  assert.equal(waitsShort(detectCaller({})), false);
});

test("ask waits 100s for any detected harness or RELO_SESSION, not only Claude and Codex", async () => {
  for (const env of [{ GEMINI_CLI: "1" }, { CURSOR_AGENT: "1" }, { RELO_SESSION: "s1" }]) {
    const fake = fakeCards({ answerAfterPolls: 10_000 });
    const clock = clocked(fake.client);
    const deps = { ...cardDependencies(fake.client, { env, identity: { providerName: "Gemini CLI", project: "relo" } }), now: () => clock.now };
    const out = await cli(["ask", "Ship?", "--approval", ...topic], deps);
    assert.equal(out.exitCode, EXIT.TERMINAL, JSON.stringify(env));
    assert.equal(clock.polls[0], 90, JSON.stringify(env));
  }
});

test("accounts work for any harness: RELO_ACCOUNT, and a nickname keyed by the harness name", async () => {
  assert.equal(detectAccount({ GEMINI_CLI: "1", RELO_ACCOUNT: "work" }, { home: "/h" }).account, "work");
  assert.equal(detectAccount({ RELO_ACCOUNT: "work" }, { home: "/h" }).account, "work");
  assert.equal(detectAccount({ RELO_SESSION: "s" }, { home: "/h" }).account, undefined);
  assert.equal(detectAccount({ GEMINI_CLI: "1" }, { home: "/h" }).account, undefined);
  assert.equal(detectAccount({ GEMINI_CLI: "1" }, { home: "/h", accounts: () => ({ "harness:gemini cli": "personal" }) }).account, "personal");
  const memory = memoryConfig();
  const env = { RELO_SESSION: "s", RELO_SOURCE: "Aider" };
  const deps = { env, home: "/h", ...memory.deps, loadAccounts: () => memory.state.config.accounts ?? {} };
  const saved = await cli(["account", "Acme"], deps);
  assert.equal(saved.line.account, "Acme");
  assert.deepEqual(memory.state.writes[0].accounts, { "harness:aider": "Acme" });
  const none = await cli(["account", "Acme"], { ...deps, env: {} });
  assert.equal(none.exitCode, EXIT.USAGE);
});

// ---- steps vs progress -------------------------------------------------------------------------

// ---- login through an agent's shell ------------------------------------------------------------

function authorizationStart() {
  return { deviceCode: DEVICE_CODE, userCode: "ABCD-EFGH", verificationUri: "http://192.168.1.10:8180/cli/authorize",
    verificationUriComplete: "http://192.168.1.10:8180/cli/authorize?code=ABCD-EFGH", expiresInSeconds: 600, intervalSeconds: 5 };
}

async function loginBox({ env = {}, polls = [] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "relo-login-"));
  const path = join(dir, "config.json");
  const state = { now: 1_000_000, polls: [...polls], written: [], opened: [], started: 0 };
  const client = {
    startDeviceAuthorization: async () => { state.started += 1; return authorizationStart(); },
    pollDeviceAuthorization: async () => {
      const next = state.polls.shift();
      if (next === "pending" || next === undefined) throw new ApiError("pending", { status: 400, code: "AUTHORIZATION_PENDING", details: {} });
      if (next === "expired") throw new ApiError("expired", { status: 400, code: "EXPIRED_TOKEN" });
      if (next === "denied") throw new ApiError("denied", { status: 400, code: "ACCESS_DENIED" });
      return { accessToken: TOKEN, credential: { id: "key_0123456789ab", clientName: "Studio", prefix: "relo_ssss", scopes: SCOPES } };
    },
  };
  const deps = { env: { RELO_API_URL: "http://192.168.1.10:8180", ...loginKeyStoreEnv(), ...env }, configPath: () => path, clientFactory: () => client,
    computerName: () => "Studio", now: () => state.now, sleep: async (ms) => { state.now += ms; },
    openBrowser: (url) => state.opened.push(url), stderr: () => {},
    writeConfig: async (_path, value) => { state.written.push(value); } };
  return { dir, path, state, deps, pending: join(dir, "login-pending.json") };
}

test("auth login --no-wait stores the pending sign-in privately and prints the link, never a token", async () => {
  const box = await loginBox();
  const out = await cli(["auth", "login", "--no-wait"], box.deps);
  assert.equal(out.exitCode, EXIT.OK);
  assert.deepEqual(out.line, { ok: true, state: "pending", url: "http://192.168.1.10:8180/cli/authorize?code=ABCD-EFGH",
    code: "ABCD-EFGH", qr: qrText("http://192.168.1.10:8180/cli/authorize?code=ABCD-EFGH"), next: "relo auth login --wait" });
  if (process.platform !== "win32") assert.equal((await stat(box.pending)).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(out.line).includes(DEVICE_CODE), false);
  assert.equal(box.state.opened.length, 0);
  assert.equal(box.state.polls.length, 0);
  const opened = await loginBox();
  await cli(["auth", "login", "--no-wait", "--open"], opened.deps);
  assert.equal(opened.state.opened.length, 1);
});

test("in an agent context plain auth login does not block and says so; --timeout opts back in", async () => {
  for (const env of [{ GEMINI_CLI: "1" }, { RELO_SESSION: "s" }, { CLAUDECODE: "1" }]) {
    const box = await loginBox({ env });
    const out = await cli(["auth", "login"], box.deps);
    assert.equal(out.exitCode, EXIT.OK);
    assert.equal(out.line.state, "pending");
    assert.match(out.line.note, /Not waiting/u);
    assert.equal(existsSync(box.pending), true);
  }
  const blocking = await loginBox({ env: { RELO_SESSION: "s" }, polls: ["pending", "ok"] });
  const out = await cli(["auth", "login", "--timeout", "60s"], blocking.deps);
  assert.equal(out.line.signedIn, true);
});

test("auth login --wait resumes the stored sign-in and stores the credential", async () => {
  const box = await loginBox({ polls: ["ok"] });
  await cli(["auth", "login", "--no-wait"], box.deps);
  assert.equal(box.state.polls.length, 1);
  const out = await cli(["auth", "login", "--wait"], box.deps);
  assert.equal(out.exitCode, EXIT.OK);
  assert.equal(out.line.signedIn, true);
  assert.equal(JSON.stringify(out.line).includes(TOKEN), false);
  assert.equal(box.state.written[0].token, TOKEN);
  assert.equal(box.state.written[0].apiUrl, "http://192.168.1.10:8180");
  assert.equal(existsSync(box.pending), false, "the pending sign-in is deleted once used");
  assert.equal(box.state.started, 1, "--wait never starts a second authorization");
});

test("auth login --wait still pending: exit 4, state pending, run it again; the sign-in is kept", async () => {
  const box = await loginBox({ env: { RELO_SESSION: "s" } });
  await cli(["auth", "login"], box.deps);
  const before = box.state.now;
  const out = await cli(["auth", "login", "--wait"], box.deps);
  assert.equal(out.exitCode, EXIT.TERMINAL);
  assert.equal(out.line.ok, false);
  assert.equal(out.line.error.details.state, "pending");
  assert.match(out.line.error.hint, /relo auth login --wait/u);
  assert.ok(box.state.now - before <= 100_000 && box.state.now - before >= 95_000, "an agent context waits at most 100s");
  assert.equal(existsSync(box.pending), true);
  const quick = await cli(["auth", "login", "--wait", "--timeout", "10s"], box.deps);
  assert.equal(quick.exitCode, EXIT.TERMINAL);
});

test("auth login --wait with an expired, missing, or denied sign-in says what to do", async () => {
  const none = await loginBox();
  const missing = await cli(["auth", "login", "--wait"], none.deps);
  assert.equal(missing.exitCode, EXIT.USAGE);
  assert.match(missing.line.error.hint, /--no-wait/u);

  const late = await loginBox();
  await cli(["auth", "login", "--no-wait"], late.deps);
  late.state.now += 601_000;
  const expired = await cli(["auth", "login", "--wait"], late.deps);
  assert.equal(expired.exitCode, EXIT.CLOSED);
  assert.equal(expired.line.error.code, "AUTHORIZATION_EXPIRED");
  assert.match(expired.line.error.hint, /Start over: relo auth login --no-wait/u);
  assert.equal(existsSync(late.pending), false);

  const server = await loginBox({ polls: ["expired"] });
  await cli(["auth", "login", "--no-wait"], server.deps);
  const serverExpired = await cli(["auth", "login", "--wait"], server.deps);
  assert.equal(serverExpired.line.error.code, "AUTHORIZATION_EXPIRED");
  assert.equal(existsSync(server.pending), false);

  const denied = await loginBox({ polls: ["denied"] });
  await cli(["auth", "login", "--no-wait"], denied.deps);
  assert.equal((await cli(["auth", "login", "--wait"], denied.deps)).exitCode, EXIT.NEGATIVE);
  assert.equal(existsSync(denied.pending), false);
  assert.equal((await cli(["auth", "login", "--wait", "--no-wait"], denied.deps)).exitCode, EXIT.USAGE);
});

// ---- relo test ---------------------------------------------------------------------------------

test("relo test: yes verifies the phone once and records it; later runs ask nothing", async () => {
  const box = testSetup({ answer: "yes" });
  const out = await cli(["test"], box.deps);
  assert.equal(out.exitCode, EXIT.OK);
  assert.deepEqual(out.line, { ok: true, verified: true });
  const ask = box.calls.find((call) => ["ask", "question"].includes(call.op));
  assert.equal(ask.body.type, "yes_no");
  assert.equal(ask.body.prompt, "Can you see this card on your iPhone?");
  assert.match(box.calls.find((call) => call.op === "start").body.title, /Relo test/u);
  assert.equal(box.calls.at(-1).op, "end", "the card is ended");
  const saved = box.memory.state.config;
  assert.equal(saved.phoneTest.deviceId, PHONE);
  assert.match(saved.phoneTest.verifiedAt, /^\d{4}-\d\d-\d\dT/u);
  assert.equal(saved.pendingTest, undefined);

  const before = box.calls.length;
  const again = await cli(["test"], box.deps);
  assert.deepEqual(again.line, { ok: true, verified: true, already: true });
  assert.equal(box.calls.length, before, "an already verified phone is never re-asked");
  const forced = await cli(["test", "--again"], box.deps);
  assert.equal(forced.line.verified, true);
  assert.ok(box.calls.length > before);
});

test("relo test: a confirmed test is not repeated when the phone re-registers; --again repeats it", async () => {
  const box = testSetup({ devices: [authorized(SPARE)], config: { phoneTest: { verifiedAt: "2026-01-01T00:00:00Z", deviceId: PHONE } } });
  const out = await cli(["test"], box.deps);
  assert.equal(out.line.already, true);
  const again = testSetup({ devices: [authorized(SPARE)], config: { phoneTest: { verifiedAt: "2026-01-01T00:00:00Z", deviceId: PHONE } } });
  const rerun = await cli(["test", "--again"], again.deps);
  assert.equal(rerun.line.already, undefined);
  assert.equal(again.memory.state.config.phoneTest.deviceId, SPARE);
});

test("relo test: no explains the checks, exit 5, and verifies nothing", async () => {
  const box = testSetup({ answer: "no" });
  const out = await cli(["test"], box.deps);
  assert.equal(out.exitCode, EXIT.NEGATIVE);
  assert.equal(out.line.error.code, "PHONE_TEST_NO");
  assert.match(out.line.error.hint, /Live Activities/u);
  assert.match(out.line.error.hint, /relo devices list/u);
  assert.equal(box.memory.state.config.phoneTest, undefined);
  assert.equal(box.memory.state.config.pendingTest, undefined);
});

test("relo test: no answer in an agent context waits 100s, exits 4 and resumes the same question", async () => {
  const box = testSetup({ answerAfterPolls: 5, env: { GEMINI_CLI: "1" } });
  const first = await cli(["test"], box.deps);
  assert.equal(first.exitCode, EXIT.TERMINAL);
  assert.equal(first.line.error.details.state, "timeout");
  assert.equal(box.clock.polls[0], 90);
  const pending = box.memory.state.config.pendingTest;
  assert.match(pending.interactionId, /^int_/u);
  const asks = () => box.calls.filter((call) => ["ask", "question"].includes(call.op)).length;
  assert.equal(asks(), 1);
  const second = await cli(["test"], box.deps);
  assert.equal(second.exitCode, EXIT.TERMINAL, "still unanswered after another poll");
  const third = await cli(["test"], box.deps);
  assert.equal(third.exitCode, EXIT.OK);
  assert.equal(asks(), 1, "resuming never asks a second question");
  assert.equal(box.memory.state.config.phoneTest.deviceId, PHONE);
  assert.equal(box.memory.state.config.pendingTest, undefined);
});

test("relo test: a stale remembered question is replaced by a fresh one", async () => {
  const box = testSetup({ answer: "yes", config: { pendingTest: { interactionId: "int_gone", cardId: "act_gone", startedAt: "2026-01-01T00:00:00Z" } } });
  const base = box.client.waitForInteraction;
  box.client.waitForInteraction = async (id, seconds) => {
    if (id === "int_gone") return { interaction: { id, state: "expired" } };
    return base(id, seconds);
  };
  const out = await cli(["test"], box.deps);
  assert.equal(out.exitCode, EXIT.OK);
  assert.equal(box.calls.filter((call) => ["ask", "question"].includes(call.op)).length, 1);
});

test("relo test: no phone with Live Activities fails before sending anything", async () => {
  for (const devices of [[], [{ deviceId: PHONE, liveActivityAuthorization: "denied" }]]) {
    const box = testSetup({ devices });
    const out = await cli(["test"], box.deps);
    assert.equal(out.exitCode, EXIT.NO_DELIVERY);
    assert.equal(out.line.error.code, "NO_PHONE");
    assert.match(out.line.error.hint, /Live Activities/u);
    assert.equal(box.calls.length, 0);
  }
  const box = testSetup();
  assert.equal((await cli(["test", "--wait"], box.deps)).exitCode, EXIT.USAGE);
  assert.equal(box.calls.length, 0);
});

// ---- relo doctor: the first unmet step ---------------------------------------------------------

function doctorBox({ devices = [authorized()], config = {}, skill = true, pending, ready, authenticated = true, keys } = {}) {
  const calls = [];
  const client = {
    ready: async () => ready ?? ({ ready: true }),
    authStatus: async () => ({ authenticated, credential: { id: "c", clientName: "Studio", prefix: "p", expiresAt: "2027-01-01T00:00:00Z", scopes: SCOPES.slice(0, 6) } }),
    doctor: async () => ({ version: 1, ok: true }),
    listDevices: async () => { calls.push("devices"); return devicePage(devices); },
    ...(keys ? { listDeviceKeys: async () => ({ devices: keys }) } : {}),
    startActivity: async () => assert.fail("doctor never pings a phone"),
    sendNotification: async () => assert.fail("doctor never pings a phone"),
  };
  const memory = memoryConfig(config);
  const build = async () => {
    const home = await fakeHome({ skillVersion: skill ? VERSION : undefined });
    return { ...cardDependencies(client), ...memory.deps, home,
      pendingLogin: { read: async () => pending ?? null, write: async () => assert.fail("no writes"), clear: async () => assert.fail("no writes") } };
  };
  return { build, memory, calls };
}

const verified = { phoneTest: { verifiedAt: "2026-01-01T00:00:00Z", deviceId: PHONE } };

test("doctor names the first unmet step, in order, and costs no writes", async () => {
  const loginless = { ...cardDependencies({}), home: await fakeHome(), pendingLogin: { read: async () => null },
    loadConfig: async () => { throw new AuthError("missing", { code: "CONFIG_NOT_FOUND" }); } };
  const login = await cli(["doctor"], loginless);
  assert.equal(login.exitCode, EXIT.AUTH);
  assert.equal(login.line.ok, false);
  assert.equal(login.line.ready, false);
  assert.deepEqual(login.line.next, { step: "login", run: "relo auth login --no-wait --api-url https://YOUR-RELO-SERVER",
    why: "Relo is not signed in on this computer." });

  const waiting = await cli(["doctor"], { ...loginless, pendingLogin: { read: async () => ({ expiresAtMs: Date.now() + 60_000 }) } });
  assert.equal(waiting.line.next.run, "relo auth login --wait");

  const noPhone = doctorBox({ devices: [], config: verified });
  const phone = await cli(["doctor"], await noPhone.build());
  assert.equal(phone.exitCode, EXIT.OK, "healthy but not ready is exit 0");
  assert.equal(phone.line.ok, true);
  assert.equal(phone.line.ready, false);
  assert.equal(phone.line.next.step, "phone");
  assert.equal(phone.line.next.run, "relo devices list");

  const off = doctorBox({ devices: [{ deviceId: PHONE, liveActivityAuthorization: "denied" }] });
  assert.equal((await cli(["doctor"], await off.build())).line.next.step, "phone");

  const untested = doctorBox();
  const test = await cli(["doctor"], await untested.build());
  assert.deepEqual(test.line.next, { step: "test", run: "relo test", why: "Confirm once that the owner's iPhone shows a Relo card." });
  assert.equal(test.line.ready, false);
  assert.equal(untested.memory.state.writes.length, 0);

  const gone = doctorBox({ devices: [authorized(SPARE)], config: verified });
  assert.notEqual((await cli(["doctor"], await gone.build())).line.next?.step, "test", "a re-registered phone keeps the confirmed test");

  const done = doctorBox({ config: verified });
  assert.deepEqual((await cli(["doctor"], await done.build())).line, { ok: true, ready: true });
  assert.equal(done.memory.state.writes.length, 0);
});

test("doctor is ready with only Relo for Mac signed in, and not with a Mac whose key is old", async () => {
  const MAC = "dev_macmacmacmac";
  const mac = (createdAt) => ({ deviceId: MAC, name: "Mac", model: "Mac16,1", capabilities: ["owner_overview"], prekey: { prekeyId: "pk_1", createdAt } });
  const now = new Date().toISOString();
  for (const devices of [[], [{ deviceId: MAC }]]) {
    const out = await cli(["doctor"], await doctorBox({ devices, keys: [mac(now)] }).build());
    assert.equal(out.line.ready, true, JSON.stringify(out.line));
    assert.deepEqual(out.line.receives, { device: "Mac", model: "Mac16,1" });
  }
  const old = await cli(["doctor"], await doctorBox({ devices: [], keys: [mac("2020-01-01T00:00:00Z")] }).build());
  assert.equal(old.line.ready, false);
  assert.equal(old.line.next.step, "phone");
  // An iPhone that exists without Live Activities keeps the phone step, Mac or not.
  const off = await cli(["doctor"], await doctorBox({ devices: [{ deviceId: PHONE, liveActivityAuthorization: "denied" }], keys: [mac(now)] }).build());
  assert.equal(off.line.next.step, "phone");
});

test("a stale skill is a warning step only after the real steps are met; ready stays true", async () => {
  const box = doctorBox({ config: verified, skill: false });
  const out = await cli(["doctor"], await box.build());
  assert.equal(out.exitCode, EXIT.OK);
  assert.equal(out.line.ready, true);
  assert.equal(out.line.next.step, "skill");
  assert.equal(out.line.warnings, undefined, "the skill is reported once, as next");
  const early = doctorBox({ skill: false });
  const first = await cli(["doctor"], await early.build());
  assert.equal(first.line.next.step, "test", "a real step beats the skill warning");
  assert.equal(first.line.warnings.skill.state, "missing");
});

test("environment credentials have no config file, so the test step does not apply", async () => {
  const box = doctorBox();
  const deps = await box.build();
  deps.loadConfig = async () => ({ apiUrl: "https://relo.example", token: "x".repeat(44), source: "environment", path: null });
  assert.equal((await cli(["doctor"], deps)).line.ready, true);
});

test("a rejected sign-in is a login step with exit 3", async () => {
  const box = doctorBox({ authenticated: false });
  const out = await cli(["doctor"], await box.build());
  assert.equal(out.exitCode, EXIT.AUTH);
  assert.equal(out.line.next.step, "login");
  assert.equal(out.line.next.run, "relo auth login --no-wait");
});

test("help and schema state the plan and count rule and the any-harness wording", () => {
  assert.match(GUIDE, /Steps are milestones in order\. Parallel work \(subagents, several jobs\) is one step with a count/u);
  // The plan belongs to the goal: deliver means this request is done; an owner check mid-plan is an ask or --waiting.
  assert.match(GUIDE, /deliver = this request is done/u);
  assert.match(GUIDE, /the owner must act mid-plan: ask or --waiting/u);
  assert.match(GUIDE, /deliver is refused while top-level steps\nare open \(--drop-rest skips them/u);
  assert.doesNotMatch(GUIDE, /More to come or the owner must act/u);
  const reporting = readFileSync(new URL("../src/install/blocks/reporting.md", import.meta.url), "utf8");
  assert.match(reporting, /A new request from the owner opens a round[^\n]*an answer, a check or "go on" continues the plan/u);
  assert.doesNotMatch(reporting, /The owner's next message/u);
  const planning = readFileSync(new URL("../src/install/blocks/planning.md", import.meta.url), "utf8");
  assert.match(planning, /what the owner must do is an `ask` or `--waiting`, never a `deliver` \(refused while steps are open; `--drop-rest` skips them\)/u);
  assert.match(planning, /--after s3/u);
  assert.match(GUIDE, /relo state/u);
  assert.match(HELP, /RELO_SESSION/u);
  assert.match(OPTIONS.progress.description, /done\/total/u);
  assert.match(OPTIONS.progress.description, /one step with a count/u);
  assert.ok(COMMANDS.find((command) => command.name === "test"));
  assert.match(GUIDE, /Gemini CLI/u);
});
