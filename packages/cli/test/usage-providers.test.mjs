// `relo usage` for Codex's account endpoint, Antigravity's language server and OpenCode's Go plan: parsing, mapping,
// error hints, caching and throttling. Fixtures with fake fetchers, runners and servers: no real network or process.
import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { codexEndpointReading, tokenExpired, windowsOf } from "../src/harness/adapters/codex/usage-endpoint.mjs";
import { cadenceOf, findServers, parsePorts, parseQuota } from "../src/harness/adapters/antigravity/usage-bridge.mjs";
import { credentialOf, goWindows } from "../src/harness/adapters/opencode/usage-go.mjs";
import { retryAfterMs, windowLabel } from "../src/shared/usage-cache.mjs";
import { cli, hookBox } from "./hook-fixture.mjs";

const NOW = 1_800_000_000_000;
const S = NOW / 1000;
const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const TOKEN = jwt({ exp: S + 86_400 });

/** Runs `relo usage --json` in a fake home at `clock()` with fake I/O. */
async function usage(home, io, clock = () => NOW, box) {
  box ??= await hookBox();
  const out = await cli(["usage", "--json"], { ...box.deps(), home, now: clock, env: { RELO_STATE_DIR: box.state }, usageIo: io });
  assert.equal(out.exitCode, 0);
  return { box, accounts: out.line.accounts, raw: JSON.stringify(out.line), byId: (id) => out.line.accounts.find((account) => account.id === id) };
}
const home = () => mkdtempSync(join(tmpdir(), "relo-usage-providers-"));
const files = (box) => { try { return readdirSync(join(box.state, "usage")); } catch { return []; } };

// ---------- Codex endpoint ----------

function codexHome(access = TOKEN) {
  const root = home();
  mkdirSync(join(root, ".codex"));
  writeFileSync(join(root, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: access, account_id: "acct-1", id_token: jwt({ email: "c@example.test" }) } }));
  return root;
}
const WHAM = { plan_type: "plus", rate_limit: {
  primary_window: { used_percent: 12.5, limit_window_seconds: 18_000, reset_after_seconds: 600 },
  secondary_window: { used_percent: 40, limit_window_seconds: 604_800, reset_at: S + 86_400 } } };
const answer = (status, json, retryAfter = null) => ({ status, retryAfter, json });
function fakeFetch(...replies) {
  const calls = [];
  const fetcher = async (url, options) => { calls.push({ url, headers: options.headers, timeoutMs: options.timeoutMs }); return replies[Math.min(calls.length - 1, replies.length - 1)]; };
  fetcher.calls = calls;
  return fetcher;
}

test("Codex with no live log window asks the account endpoint and maps both windows; read-only, cached 5 minutes", async () => {
  const root = codexHome();
  const fetcher = fakeFetch(answer(200, WHAM));
  const first = await usage(root, { fetch: fetcher });
  const codex = first.byId("codex");
  assert.deepEqual(codex.windows, [
    { kind: "primary", minutes: 300, label: "5-hour", usedPercent: 12.5, resetsAt: S + 600 },
    { kind: "secondary", minutes: 10_080, label: "Week", usedPercent: 40, resetsAt: S + 86_400 }]);
  assert.equal(codex.planName, "plus");
  assert.equal(codex.source, "endpoint");
  assert.equal(codex.displayName, "Codex");
  assert.equal(codex.hint, null);
  assert.equal(codex.readAt, NOW);
  assert.deepEqual(fetcher.calls.map((call) => [call.url, call.headers.Authorization, call.headers["ChatGPT-Account-Id"], call.timeoutMs]),
    [["https://chatgpt.com/backend-api/wham/usage", `Bearer ${TOKEN}`, "acct-1", 15_000]]);
  assert.equal(first.raw.includes(TOKEN), false, "the token never leaves");
  assert.equal(readFileSync(join(root, ".codex", "auth.json"), "utf8").includes("acct-1"), true, "auth.json is not rewritten");
  assert.equal(JSON.stringify(files(first.box)).includes("codex-endpoint"), true);
  for (const name of files(first.box)) assert.equal(readFileSync(join(first.box.state, "usage", name), "utf8").includes(TOKEN), false, "no token in the cache");
  await usage(root, { fetch: fetcher }, () => NOW + 4 * 60_000, first.box);
  assert.equal(fetcher.calls.length, 1, "young: from the cache");
  const later = await usage(root, { fetch: fetcher }, () => NOW + 5 * 60_000 + 1, first.box);
  assert.equal(fetcher.calls.length, 2, "old: asks again");
  assert.equal(later.byId("codex").windows.length, 2);
});

test("Codex endpoint: 401 hints codex login and is cached; a failure keeps the last reading", async () => {
  const root = codexHome();
  const fetcher = fakeFetch(answer(401), answer(200, WHAM), answer(403));
  const failed = await usage(root, { fetch: fetcher });
  assert.deepEqual(failed.byId("codex").windows, []);
  assert.match(failed.byId("codex").hint, /codex login/u);
  await usage(root, { fetch: fetcher }, () => NOW + 60_000, failed.box);
  assert.equal(fetcher.calls.length, 1, "a failed attempt is cached too");
  await usage(root, { fetch: fetcher }, () => NOW + 6 * 60_000, failed.box);
  const kept = await usage(root, { fetch: fetcher }, () => NOW + 12 * 60_000, failed.box);
  assert.equal(fetcher.calls.length, 3);
  assert.match(kept.byId("codex").hint, /codex login/u);
  assert.equal(kept.byId("codex").windows.length, 2, "the last reading stays");
  assert.equal(kept.byId("codex").readAt, NOW + 6 * 60_000);
});

test("Codex endpoint: 429 backs off for Retry-After, then doubles; other errors and odd bodies only hint", async () => {
  const root = codexHome();
  const fetcher = fakeFetch(answer(429, undefined, "900"), answer(429), answer(200, WHAM));
  const first = await usage(root, { fetch: fetcher });
  assert.match(first.byId("codex").hint, /slow down/u);
  await usage(root, { fetch: fetcher }, () => NOW + 14 * 60_000, first.box);
  assert.equal(fetcher.calls.length, 1, "Retry-After 900 s holds past the 5 minute interval");
  await usage(root, { fetch: fetcher }, () => NOW + 15 * 60_000 + 1, first.box);
  assert.equal(fetcher.calls.length, 2);
  await usage(root, { fetch: fetcher }, () => NOW + 15 * 60_000 + 1 + 100_000, first.box);
  assert.equal(fetcher.calls.length, 2, "second hit: backs off at least 2 minutes");
  const done = await usage(root, { fetch: fetcher }, () => NOW + 15 * 60_000 + 1 + 5 * 60_000 + 1, first.box);
  assert.equal(fetcher.calls.length, 3);
  assert.equal(done.byId("codex").windows.length, 2);
  for (const reply of [answer(500), answer(0), answer(200, { rate_limit: {} }), answer(200, "nonsense")]) {
    const bad = await usage(codexHome(), { fetch: fakeFetch(reply) });
    assert.deepEqual(bad.byId("codex").windows, []);
    assert.equal(typeof bad.byId("codex").hint, "string");
  }
});

test("Codex endpoint: no credential or an expired token never asks; a live log window never asks", async () => {
  const fetcher = fakeFetch(answer(200, WHAM));
  const expired = await usage(codexHome(jwt({ exp: S - 5 })), { fetch: fetcher });
  assert.match(expired.byId("codex").hint, /expired.*codex login/u);
  const bare = home();
  mkdirSync(join(bare, ".codex"));
  writeFileSync(join(bare, ".codex", "auth.json"), JSON.stringify({ tokens: { id_token: jwt({}) } }));
  assert.match((await usage(bare, { fetch: fetcher })).byId("codex").hint, /codex login/u);
  const live = codexHome();
  const day = join(live, ".codex", "sessions", "2026", "10", "26");
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, "rollout-a.jsonl"), JSON.stringify({ rate_limits: { primary: { used_percent: 3, window_minutes: 300, resets_at: S + 100 } } }));
  const fromLog = await usage(live, { fetch: fetcher });
  assert.equal(fromLog.byId("codex").source, "rollout");
  assert.equal(fromLog.byId("codex").windows[0].label, "5-hour");
  assert.equal(fetcher.calls.length, 0);
  assert.equal(tokenExpired("garbage", NOW), false);
  assert.deepEqual(windowsOf({ rate_limit: { primary_window: { used_percent: null, reset_at: 1 }, secondary_window: { used_percent: "7", limit_window_seconds: 2_592_000, reset_at: S + 9 } } }, NOW),
    [{ kind: "secondary", minutes: 43_200, label: "Month", usedPercent: 7, resetsAt: S + 9 }], "one unreadable window never drops its sibling");
  assert.equal((await codexEndpointReading({ folder: "x", folderKey: "x", auth: undefined, stateDirectory: "/nonexistent", now: NOW })).windows.length, 0);
});

test("helpers: window labels and Retry-After", () => {
  assert.deepEqual([45, 300, 1440, 10_080, 43_200, 4320, 0, null].map(windowLabel), ["45-minute", "5-hour", "1-day", "Week", "Month", "3-day", null, null]);
  assert.equal(retryAfterMs("120", NOW), 120_000);
  assert.equal(retryAfterMs(new Date(NOW + 30_000).toUTCString(), NOW), 30_000);
  assert.equal(retryAfterMs("soon", NOW), 0);
  assert.equal(retryAfterMs(null, NOW), 0);
});

// ---------- Antigravity ----------

const PS = `  PID COMMAND
  101 /usr/sbin/cfprefsd agent
  202 /Applications/Antigravity.app/Contents/Resources/bin/language_server --standalone --csrf_token tok-ide-1 --https_server_port 0
  303 /Users/owner/.local/bin/agy chat
  404 /usr/bin/magyar --csrf_token nope
`;
const LSOF = `COMMAND     PID  USER   FD   TYPE DEVICE SIZE/OFF NODE NAME
language_  202 owner   10u  IPv4 0x1      0t0  TCP 127.0.0.1:50123 (LISTEN)
language_  202 owner   11u  IPv6 0x2      0t0  TCP *:50124 (LISTEN)
`;
const GROUPS = { response: { groups: [
  { displayName: "Claude and GPT models", buckets: [
    { bucketId: "claude-weekly", displayName: "Weekly Limit", remainingFraction: 0.25, resetTime: "2026-10-30T00:00:00.000Z" },
    { bucketId: "claude-5h", displayName: "5-hour Limit", remainingFraction: 0.9, resetTime: "2026-10-27T18:00:00Z" }] },
  { displayName: "Gemini Models", buckets: [
    { bucketId: "gemini-5h", displayName: "Five Hour Limit Remaining", remaining: { case: "remainingFraction", value: 0.6 }, resetTime: "2026-10-27T17:00:00Z" },
    { bucketId: "gemini-weekly", displayName: "Weekly Limit", remainingFraction: 1, resetTime: "2026-11-01T00:00:00Z", disabled: true }] }] } };
const QUOTA_NOW = Date.parse("2026-10-27T12:00:00Z");
const at = (iso) => Math.round(Date.parse(iso) / 1000);

test("Antigravity process listing and ports: the IDE's server first, the agy executable by name, loopback ports from lsof", () => {
  assert.deepEqual(findServers(PS), [{ pid: 202, token: "tok-ide-1" }, { pid: 303, token: null }]);
  assert.deepEqual(findServers("  1 /bin/zsh\n"), []);
  assert.deepEqual(findServers(undefined), []);
  assert.deepEqual(parsePorts(LSOF), [50123, 50124]);
  assert.deepEqual(parsePorts("COMMAND PID\n"), []);
});

test("Antigravity quota groups become windows per model family, hourly then weekly, used from remainingFraction", () => {
  assert.deepEqual(parseQuota(GROUPS, QUOTA_NOW), [
    { kind: "gemini-hourly", minutes: 300, label: "Gemini 5-hour", usedPercent: 40, resetsAt: at("2026-10-27T17:00:00Z") },
    { kind: "other-hourly", minutes: 300, label: "Other models 5-hour", usedPercent: 10, resetsAt: at("2026-10-27T18:00:00Z") },
    { kind: "other-weekly", minutes: 10_080, label: "Other models week", usedPercent: 75, resetsAt: at("2026-10-30T00:00:00Z") }]);
});

test("Antigravity flat model buckets keep the tightest per family and cadence; legacy limit/used; junk is empty", () => {
  const flat = { buckets: [
    { modelId: "gemini-3-pro", remainingFraction: 0.8, resetTime: "2026-10-27T15:00:00Z" },
    { modelId: "gemini-3-flash", remainingFraction: 0.5, resetTime: "2026-10-27T14:00:00Z" },
    { modelId: "gemini-3-pro-weekly", remainingFraction: 0.7, resetTime: "2026-11-02T00:00:00Z" },
    { modelId: "claude-sonnet", remainingFraction: 0.3, resetTime: "2026-10-27T16:00:00Z" },
    { modelId: "chat_internal", remainingFraction: 0.1 }, { modelId: "gemini-x", remainingFraction: 7 }] };
  assert.deepEqual(parseQuota(flat, QUOTA_NOW).map((window) => [window.kind, window.label, window.usedPercent]), [
    ["gemini-hourly", "Gemini 5-hour", 50], ["gemini-weekly", "Gemini week", 30], ["other-hourly", "Other models 5-hour", 70]]);
  assert.deepEqual(parseQuota({ buckets: [{ bucketId: "requests", displayName: "Requests", limit: 200, used: 50, resetTime: "2026-10-28T00:00:00Z" }, { limit: 0, used: 1 }] }, QUOTA_NOW),
    [{ kind: "requests", minutes: null, label: "Requests", usedPercent: 25, resetsAt: at("2026-10-28T00:00:00Z") }]);
  for (const junk of [undefined, null, {}, { groups: [] }, { buckets: [] }, "x", { groups: [{ buckets: "no" }] }]) assert.deepEqual(parseQuota(junk, QUOTA_NOW), []);
  assert.equal(cadenceOf({ window: "WEEKLY" }), "weekly");
  assert.equal(cadenceOf({ bucketId: "gemini-hourly" }), "hourly");
  assert.equal(cadenceOf({ displayName: "Models" }), undefined);
});

function antigravityHome() {
  const root = home();
  mkdirSync(join(root, ".gemini", "antigravity"), { recursive: true });
  writeFileSync(join(root, ".gemini", "google_accounts.json"), JSON.stringify({ active: "g@example.test", old: [] }));
  return root;
}
function fakeProcesses({ ps = PS, quota = { 50124: { status: 200, json: GROUPS } } } = {}) {
  const runs = [];
  const posts = [];
  const state = { ps };
  return {
    state, runs, posts,
    io: {
      // Only the fake home is real: this computer's own /Applications must not count.
      exists: async (path) => path.startsWith(tmpdir()) && existsSync(path),
      sleep: async () => {},
      spawnDetached: async () => { throw new Error("nothing should be started"); },
      run: async (file, args) => { runs.push([file, ...args]); return file.endsWith("ps") ? state.ps : file.endsWith("lsof") ? LSOF : ""; },
      post: async (request) => {
        posts.push({ port: request.port, token: request.headers["x-codeium-csrf-token"] ?? null });
        assert.equal(request.path, "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary");
        assert.deepEqual(JSON.parse(request.body), { forceRefresh: true });
        return quota[request.port] ?? { status: 404, json: undefined };
      },
    },
  };
}

test("Antigravity asks the running language server on each port with the CSRF token, and caches 2 minutes", async () => {
  const root = antigravityHome();
  const fake = fakeProcesses();
  const clock = QUOTA_NOW;
  const first = await usage(root, fake.io, () => clock);
  const account = first.byId("antigravity");
  const runs = fake.runs.map((run) => run.join(" "));
  assert.equal(runs.length, 2);
  assert.equal(runs[0], "/bin/ps -Ao pid,command");
  assert.match(runs[1], /(?:^|\/)lsof -nP -a -p 202 -iTCP -sTCP:LISTEN$/u);
  assert.deepEqual(fake.posts, [{ port: 50123, token: "tok-ide-1" }, { port: 50124, token: "tok-ide-1" }], "the first port refused, the second served it");
  assert.equal(account.plan, "antigravity");
  assert.equal(account.displayName, "Antigravity");
  assert.equal(account.email, "g@example.test");
  assert.equal(account.source, "language-server");
  assert.equal(account.connected, true);
  assert.equal(account.hint, null);
  assert.deepEqual(account.windows.map((window) => window.label), ["Gemini 5-hour", "Other models 5-hour", "Other models week"]);
  assert.equal(first.raw.includes("tok-ide-1"), false, "the token never leaves");
  for (const name of files(first.box)) assert.equal(readFileSync(join(first.box.state, "usage", name), "utf8").includes("tok-ide-1"), false, "nor is it cached");
  await usage(root, fake.io, () => clock + 119_000, first.box);
  assert.equal(fake.runs.length, 2, "young: from the cache");
  await usage(root, fake.io, () => clock + 121_000, first.box);
  assert.equal(fake.runs.length, 4, "old: asks again");
});

test("Antigravity not running keeps the last reading with the hint; with no reading yet it only hints; absent means no account", async () => {
  const root = antigravityHome();
  const fake = fakeProcesses();
  const first = await usage(root, fake.io, () => QUOTA_NOW);
  fake.state.ps = "  PID COMMAND\n  1 /sbin/launchd\n";
  const later = await usage(root, fake.io, () => QUOTA_NOW + 3 * 60_000, first.box);
  assert.equal(later.byId("antigravity").hint, "Reads while Antigravity or agy runs.");
  assert.equal(later.byId("antigravity").windows.length, 3, "the last reading stays");
  assert.equal(later.byId("antigravity").readAt, QUOTA_NOW);
  const never = await usage(antigravityHome(), fakeProcesses({ ps: "" }).io, () => QUOTA_NOW);
  assert.deepEqual(never.byId("antigravity").windows, []);
  assert.equal(never.byId("antigravity").hint, "Reads while Antigravity or agy runs.");
  assert.equal(never.byId("antigravity").connected, false);
  assert.equal((await usage(home(), fakeProcesses().io)).byId("antigravity"), undefined);
  const refusing = await usage(antigravityHome(), fakeProcesses({ quota: {} }).io, () => QUOTA_NOW);
  assert.match(refusing.byId("antigravity").hint, /running but gave no quota/u);
});

test("the agy CLI is asked without a token", async () => {
  const fake = fakeProcesses({ ps: "  303 /Users/owner/.local/bin/agy\n", quota: { 50123: { status: 200, json: GROUPS } } });
  await usage(antigravityHome(), fake.io, () => QUOTA_NOW);
  assert.deepEqual(fake.posts[0], { port: 50123, token: null });
});

const APP_BINARY = ["Applications", "Antigravity.app", "Contents", "Resources", "bin", "language_server"];
function installedHome() {
  const root = antigravityHome();
  mkdirSync(join(root, ...APP_BINARY.slice(0, -1)), { recursive: true });
  writeFileSync(join(root, ...APP_BINARY), "");
  return root;
}
/** A fake whose spawn adds the server to the process list; its port opens on the third lsof (it binds after a moment). */
function startableProcesses() {
  const fake = fakeProcesses({ ps: "  PID COMMAND\n  1 /sbin/launchd\n" });
  fake.spawned = [];
  let lsofs = 0;
  const run = fake.io.run;
  fake.io.run = async (file, args) => {
    if (file.endsWith("lsof")) { lsofs += 1; fake.runs.push([file, ...args]); return lsofs < 3 ? "" : LSOF; }
    return run(file, args);
  };
  fake.io.spawnDetached = async (file, args) => {
    fake.spawned.push({ file, args });
    fake.state.ps += `  777 ${file} ${args.join(" ")}\n`;
    return 777;
  };
  return fake;
}

test("Antigravity not running but installed: Relo starts the server once, standalone, and reads the quota from it", async () => {
  const root = installedHome();
  const fake = startableProcesses();
  const first = await usage(root, fake.io, () => QUOTA_NOW);
  assert.equal(fake.spawned.length, 1);
  const { file, args } = fake.spawned[0];
  assert.equal(file, join(root, ...APP_BINARY));
  const flag = (name) => args[args.indexOf(name) + 1];
  assert.ok(args.includes("--standalone"));
  assert.equal(flag("--https_server_port"), "0");
  assert.equal(flag("--app_data_dir"), "relo-usage-bridge", "a name, not a path");
  assert.equal(flag("--cloud_code_endpoint"), "https://daily-cloudcode-pa.googleapis.com");
  assert.match(flag("--csrf_token"), /^[0-9a-f-]{36}$/u);
  const account = first.byId("antigravity");
  assert.equal(account.connected, true);
  assert.equal(account.windows.length, 3);
  assert.deepEqual(fake.posts.at(-1), { port: 50124, token: flag("--csrf_token") }, "asked with the token it was started with");
  const record = JSON.parse(readFileSync(join(first.box.state, "usage", "antigravity-server.json"), "utf8"));
  assert.deepEqual(record, { pid: 777, token: flag("--csrf_token"), startedAt: QUOTA_NOW });
  assert.equal(first.raw.includes(flag("--csrf_token")), false, "the token never leaves");
});

test("Antigravity reuses the server Relo started earlier instead of starting another, even while it still boots", async () => {
  const root = installedHome();
  const fake = startableProcesses();
  const first = await usage(root, fake.io, () => QUOTA_NOW);
  await usage(root, fake.io, () => QUOTA_NOW + 3 * 60_000, first.box);
  assert.equal(fake.spawned.length, 1, "found again in the process list");
  assert.equal(fake.posts.length, 4, "asked again: two ports each run");
  // A server that is recorded but only answers later: the next run waits for it and starts nothing.
  const slow = startableProcesses();
  const token = "tok-recorded";
  slow.state.ps += `  888 ${join(root, ...APP_BINARY)} --standalone --csrf_token ${token} --app_data_dir relo-usage-bridge\n`;
  const box = await hookBox();
  mkdirSync(join(box.state, "usage"), { recursive: true });
  writeFileSync(join(box.state, "usage", "antigravity-server.json"), JSON.stringify({ pid: 888, token, startedAt: QUOTA_NOW - 5000 }));
  const reused = await usage(root, slow.io, () => QUOTA_NOW, box);
  assert.equal(slow.spawned.length, 0);
  assert.equal(reused.byId("antigravity").connected, true);
  assert.equal(slow.posts.at(-1).token, token);
});

test("Antigravity starts nothing when its binary is missing, and a server that never answers is a short-cached miss", async () => {
  const bare = startableProcesses();
  const missing = await usage(antigravityHome(), bare.io, () => QUOTA_NOW);
  assert.equal(bare.spawned.length, 0);
  assert.equal(missing.byId("antigravity").hint, "Reads while Antigravity or agy runs.");
  const mute = startableProcesses();
  mute.io.post = async () => ({ status: 503, json: undefined });
  const root = installedHome();
  const first = await usage(root, mute.io, () => QUOTA_NOW);
  assert.match(first.byId("antigravity").hint, /did not answer/u);
  assert.equal(first.byId("antigravity").connected, false);
  const runs = mute.runs.length;
  await usage(root, mute.io, () => QUOTA_NOW + 29_000, first.box);
  assert.equal(mute.runs.length, runs, "a miss is cached for 30 seconds");
  await usage(root, mute.io, () => QUOTA_NOW + 31_000, first.box);
  assert.ok(mute.runs.length > runs);
  assert.equal(mute.spawned.length, 1, "and it is not started again");
});

test("Antigravity buckets of one cadence get distinct kinds, with the bucket's name on the label", () => {
  const windows = parseQuota({ response: { groups: [{ displayName: "Gemini Models", buckets: [
    { bucketId: "gemini_pro_5h", displayName: "Pro 5-hour Limit", remainingFraction: 0.5, resetTime: "2026-10-27T17:00:00Z" },
    { bucketId: "gemini_flash_5h", displayName: "Flash 5-hour Limit", remainingFraction: 0.9, resetTime: "2026-10-27T17:00:00Z" },
    { bucketId: "gemini-weekly", displayName: "Weekly Limit", remainingFraction: 0.1, resetTime: "2026-10-30T00:00:00Z" }] }] } }, QUOTA_NOW);
  assert.deepEqual(windows.map((window) => [window.kind, window.label]), [
    ["gemini-hourly-gemini-pro-5h", "Gemini 5-hour (Pro 5-hour Limit)"], ["gemini-hourly-gemini-flash-5h", "Gemini 5-hour (Flash 5-hour Limit)"], ["gemini-weekly", "Gemini week"]]);
  assert.equal(new Set(windows.map((window) => window.kind)).size, 3);
});

// ---------- OpenCode ----------

function opencodeHome({ auth, database = false } = {}) {
  const root = home();
  const folder = join(root, ".local", "share", "opencode");
  mkdirSync(folder, { recursive: true });
  if (auth) writeFileSync(join(folder, "auth.json"), JSON.stringify(auth));
  if (database) writeFileSync(join(folder, "opencode.db"), "");
  return root;
}
const GO_BODY = { usage: {
  rolling: { status: "ok", percent: 12, resetsAt: "2026-10-27T17:00:00.611Z" },
  weekly: { status: "ok", percent: 3.5, resetsAt: "2026-10-28T00:00:00.611Z" },
  monthly: { status: "ok", percent: 50, resetsAt: "2026-11-03T13:09:45.611Z" } } };
/** A sqlite3 stand-in: answers by what the query asks. */
function fakeSqlite({ credentials = [], tables = ["session_v2", "session_message"], activity = [{ provider: "firepass", today: 120, five: 100, week: 900, month: 3400, cost: 0, costToday: 0, quota: 0, last: 1793100000000 }, { provider: "opencode", today: 5, five: 5, week: 50, month: 80, cost: 0.5, costToday: 0.25, quota: 2, last: 1793110000000 }] } = {}) {
  const queries = [];
  const run = async (file, args) => {
    assert.equal(file, "sqlite3");
    assert.deepEqual(args.slice(0, 2), ["-readonly", "-json"], "read-only");
    const sql = args[3];
    queries.push(sql);
    if (sql.includes("FROM credential")) return JSON.stringify(credentials);
    if (sql.includes("sqlite_master")) return JSON.stringify(tables.map((name) => ({ name })));
    if (sql.includes("GROUP BY provider")) return Array.isArray(activity) ? JSON.stringify(activity) : activity;
    return "[]";
  };
  run.queries = queries;
  return run;
}
const GO_NOW = Date.parse("2026-10-27T12:00:00Z");

test("OpenCode Go key in the database asks the Go endpoint and maps 5-hour, weekly and monthly windows", async () => {
  const root = opencodeHome({ database: true, auth: { stale: { type: "api", key: "dead" } } });
  const run = fakeSqlite({ credentials: [{ integration_id: "opencode-go", value: JSON.stringify({ type: "api", key: "oc_sk_SECRET" }) }] });
  const fetcher = fakeFetch(answer(200, GO_BODY));
  const first = await usage(root, { run, fetch: fetcher }, () => GO_NOW);
  const account = first.byId("opencode");
  assert.deepEqual(fetcher.calls.map((call) => [call.url, call.headers.Authorization]), [["https://opencode.ai/zen/go/v1/usage", "Bearer oc_sk_SECRET"]]);
  assert.deepEqual(account.windows, [
    { kind: "five_hour", minutes: 300, label: "5-hour", usedPercent: 12, resetsAt: at("2026-10-27T17:00:00.611Z") },
    { kind: "seven_day", minutes: 10_080, label: "Week", usedPercent: 3.5, resetsAt: at("2026-10-28T00:00:00.611Z") },
    { kind: "monthly", minutes: 44_640, label: "Month", usedPercent: 50, resetsAt: at("2026-11-03T13:09:45.611Z") }]);
  assert.equal(account.planName, "Go");
  assert.equal(account.source, "endpoint");
  assert.equal(account.displayName, "OpenCode");
  assert.equal(account.connected, true);
  assert.equal(account.hint, null);
  assert.equal("activity" in account, false);
  assert.equal(first.raw.includes("oc_sk_SECRET"), false);
  for (const name of files(first.box)) assert.equal(readFileSync(join(first.box.state, "usage", name), "utf8").includes("oc_sk_SECRET"), false);
  await usage(root, { run, fetch: fetcher }, () => GO_NOW + 4 * 60_000, first.box);
  assert.equal(fetcher.calls.length, 1, "cached 5 minutes");
  await usage(root, { run, fetch: fetcher }, () => GO_NOW + 5 * 60_000 + 1, first.box);
  assert.equal(fetcher.calls.length, 2);
});

test("OpenCode Go: auth.json fallback, 401 and 403 hints, 429 backoff, an OAuth sign-in without a plan, last reading kept", async () => {
  const goAuth = { auth: { "opencode-go": { type: "api", key: "k1" } } };
  const fetcher = fakeFetch(answer(200, GO_BODY), answer(401), answer(429, undefined, "600"), answer(200, GO_BODY));
  const root = opencodeHome(goAuth);
  const first = await usage(root, { fetch: fetcher }, () => GO_NOW);
  assert.equal(first.byId("opencode").windows.length, 3, "no database: auth.json serves");
  const denied = await usage(root, { fetch: fetcher }, () => GO_NOW + 6 * 60_000, first.box);
  assert.match(denied.byId("opencode").hint, /opencode auth login/u);
  assert.equal(denied.byId("opencode").windows.length, 3, "the last reading stays");
  await usage(root, { fetch: fetcher }, () => GO_NOW + 12 * 60_000, first.box);
  await usage(root, { fetch: fetcher }, () => GO_NOW + 20 * 60_000, first.box);
  assert.equal(fetcher.calls.length, 3, "429 with Retry-After 600 s holds the next try");
  const ok = await usage(root, { fetch: fetcher }, () => GO_NOW + 23 * 60_000, first.box);
  assert.equal(fetcher.calls.length, 4);
  assert.equal(ok.byId("opencode").hint, null);

  const forbidden = await usage(opencodeHome(goAuth), { fetch: fakeFetch(answer(403)) }, () => GO_NOW);
  assert.equal(forbidden.byId("opencode").hint, "No OpenCode Go subscription on this key.");

  const oauth = { auth: { opencode: { type: "oauth", access: "acc-1", expires: GO_NOW + 1e6, metadata: { server: "https://console.example.test/c/", orgID: "org-9" } } } };
  const probe = fakeFetch(answer(401), answer(200, {}));
  const planless = await usage(opencodeHome(oauth), { fetch: probe }, () => GO_NOW);
  assert.deepEqual(probe.calls.map((call) => [call.url, call.headers["x-opencode-org-id"]]), [["https://opencode.ai/inference/go/v1/usage", "org-9"], ["https://console.example.test/c/api/user", "org-9"]]);
  assert.equal(planless.byId("opencode").hint, "No OpenCode Go subscription on this account.");
  assert.deepEqual(planless.byId("opencode").windows, []);
  const expired = await usage(opencodeHome({ auth: { opencode: { type: "oauth", access: "acc-1", expires: GO_NOW - 1 } } }), { fetch: fakeFetch(answer(401), answer(401)) }, () => GO_NOW);
  assert.match(expired.byId("opencode").hint, /expired.*opencode auth login/u);
});

test("OpenCode signed in only with API keys: no windows, planName API keys, the hint, and token activity from the local database", async () => {
  const fetcher = fakeFetch(answer(200, GO_BODY));
  const run = fakeSqlite({ credentials: [{ integration_id: "firepass", value: null }] });
  const root = opencodeHome({ database: true });
  const first = await usage(root, { run, fetch: fetcher }, () => GO_NOW);
  const account = first.byId("opencode");
  assert.deepEqual(account.windows, []);
  assert.equal(account.planName, "Fireworks Fire Pass via OpenCode");
  assert.match(account.hint, /No plan limit to read.*Fireworks Fire Pass.*Free usage limit reached today/u);
  assert.equal(account.connected, true);
  assert.deepEqual(account.activity, {
    tokensToday: 125, tokens5h: 105, tokensWeek: 950, tokensMonth: 3480, costToday: 0.25, costMonth: 0.5, lastUsedAt: 1793110000,
    providers: [{ id: "firepass", tokensMonth: 3400, costMonth: 0 }, { id: "opencode", tokensMonth: 80, costMonth: 0.5 }] });
  assert.equal(account.source, "local");
  assert.equal(fetcher.calls.length, 0, "an API key is never sent anywhere");
  const sum = run.queries.find((sql) => sql.includes("GROUP BY provider"));
  assert.match(sum, /FROM session_message WHERE type = 'assistant'/u);
  assert.equal(run.queries.some((sql) => /firepass.*value|value.*firepass/u.test(sql)), false);
  const count = run.queries.length;
  await usage(root, { run, fetch: fetcher }, () => GO_NOW + 60_000, first.box);
  assert.equal(run.queries.length, count, "cached");

  const v1 = fakeSqlite({ credentials: [{ integration_id: "firepass", value: null }], tables: ["message"], activity: [] });
  await usage(opencodeHome({ database: true }), { run: v1 }, () => GO_NOW);
  assert.match(v1.queries.find((sql) => sql.includes("GROUP BY provider")), /FROM message WHERE json_extract\(data,'\$\.role'\) = 'assistant'/u);

  const quiet = await usage(opencodeHome({ database: true }), { run: fakeSqlite({ credentials: [{ integration_id: "firepass", value: null }], activity: [] }) }, () => GO_NOW);
  assert.equal(quiet.byId("opencode").hint, "No plan limit: OpenCode is using API keys.", "no rows this month: the API-keys hint");
  assert.equal("activity" in quiet.byId("opencode"), false);
  const broken = await usage(opencodeHome({ database: true }), { run: fakeSqlite({ credentials: [{ integration_id: "firepass", value: null }], activity: "" }) }, () => GO_NOW);
  assert.match(broken.byId("opencode").hint, /could not be read/u, "unreadable is not the same as no rows");
  const claude = await usage(opencodeHome({ database: true }), { run: fakeSqlite({ credentials: [{ integration_id: "anthropic", value: null }], activity: [{ provider: "anthropic", today: 1, five: 1, week: 1, month: 1, cost: 2, costToday: 0, quota: 0, last: 1793100000000 }] }) }, () => GO_NOW);
  assert.equal(claude.byId("opencode").planName, "Anthropic via OpenCode");
  assert.match(claude.byId("opencode").hint, /Claude row/u);

  const fileOnly = await usage(opencodeHome({ auth: { firepass: { type: "key", key: "k" } } }), { fetch: fetcher }, () => GO_NOW);
  assert.equal(fileOnly.byId("opencode").planName, "API keys");
  assert.equal("activity" in fileOnly.byId("opencode"), false, "no database: no activity, no error");
  const empty = await usage(opencodeHome({ auth: {} }), { fetch: fetcher }, () => GO_NOW);
  assert.equal(empty.byId("opencode").connected, false);
  assert.match(empty.byId("opencode").hint, /opencode auth login/u);
  assert.equal((await usage(home(), { fetch: fetcher })).byId("opencode"), undefined, "not installed: no account");
});

test("OpenCode helpers: credential shapes and Go window mapping are defensive", () => {
  assert.deepEqual(credentialOf("bare"), { token: "bare", oauth: false, console: null, org: null, expires: null });
  assert.equal(credentialOf({ type: "api", key: "" }), undefined);
  assert.equal(credentialOf({ type: "oauth" }), undefined);
  assert.equal(credentialOf(7), undefined);
  assert.equal(credentialOf({ type: "api", apiKey: "k" }).token, "k");
  assert.deepEqual(goWindows({ usage: { rolling: { percent: null, resetsAt: "2026-10-27T17:00:00Z" }, weekly: { percent: 5, resetsAt: "nope" } } }), []);
  assert.deepEqual(goWindows(undefined), []);
  assert.equal(goWindows({ usage: { rolling: { percent: 250, resetsAt: "2026-10-27T17:00:00Z" } } })[0].usedPercent, 100);
});

test("every account carries a displayName; profiles append their name", async () => {
  const root = home();
  mkdirSync(join(root, ".claude"));
  mkdirSync(join(root, ".claude-work"));
  writeFileSync(join(root, ".claude-work", "settings.json"), "{}");
  writeFileSync(join(root, ".claude.json"), "{}");
  const { accounts } = await usage(root, {});
  assert.deepEqual(accounts.map((account) => [account.id, account.displayName]), [["claude", "Claude"], ["claude-work", "Claude · work"]]);
});
