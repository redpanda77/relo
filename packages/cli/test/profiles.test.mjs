import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EXIT, run } from "../src/cli.mjs";
import { loadConfig, switchProfile, writeConfig } from "../src/config.mjs";

const HOME_TOKEN = `relo_${"h".repeat(43)}`;
const WORK_TOKEN = `relo_${"w".repeat(43)}`;
const ENV_TOKEN = `relo_${"e".repeat(43)}`;
const SCOPES = ["activities:read", "activities:write", "devices:read", "interactions:create", "interactions:read",
  "notifications:send", "services:read", "services:write", "sessions:write"];
const PHONE = { verifiedAt: "2026-10-13T10:00:00Z", deviceId: "dev_abcdefghijkl" };

async function cli(argv, dependencies) {
  const stdout = [];
  const exitCode = await run(argv, { stdout: (line) => stdout.push(line), stderr: () => {}, stdoutIsTTY: false }, dependencies);
  return { exitCode, line: stdout[0] ? JSON.parse(stdout[0]) : undefined };
}

/** The real config code on a temp file; the "server" records which token each command used. */
async function box({ legacy = true, env = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "relo-profiles-"));
  const path = join(dir, "config.json");
  if (legacy) {
    await writeFile(path, JSON.stringify({ version: 1, apiUrl: "https://home.example", token: HOME_TOKEN, phoneTest: PHONE, accounts: { "/x/.claude": "me" } }), { mode: 0o600 });
  }
  const state = { tokens: [], started: [] };
  const client = (config) => ({
    startDeviceAuthorization: async (body) => { state.started.push(config.apiUrl); return { deviceCode: "d".repeat(43), userCode: "ABCD-EFGH",
      verificationUri: `${config.apiUrl}/cli/authorize`, verificationUriComplete: `${config.apiUrl}/cli/authorize?code=ABCD-EFGH`, expiresInSeconds: 600, intervalSeconds: 5, body }; },
    pollDeviceAuthorization: async () => ({ accessToken: WORK_TOKEN, credential: { id: "key_0123456789ab", clientName: state.clientName, prefix: "relo_wwww", scopes: SCOPES } }),
    authStatus: async () => { state.tokens.push(config.token); return { authenticated: true, credential: { id: "k", clientName: "Studio", prefix: "p", scopes: SCOPES, expiresAt: "2027-01-01T00:00:00Z" } }; },
    revokeAuth: async () => { state.tokens.push(`revoked:${config.token}`); return { revoked: true }; },
  });
  state.clientName = "Studio";
  const deps = { env: { RELO_CONFIG_PATH: path, ...env }, clientFactory: client, computerName: () => "Studio", openBrowser: () => {}, stderr: () => {},
    sleep: async () => {}, now: () => 1_000_000 };
  return { dir, path, state, deps, read: async () => JSON.parse(await readFile(path, "utf8")), run: (argv, extra = {}) => cli(argv, { ...deps, ...extra, env: { ...deps.env, ...(extra.env ?? {}) } }) };
}

test("a single-login config reads as the profile default and migrates on the next write", async () => {
  const b = await box();
  const loaded = await loadConfig(b.path);
  assert.equal(loaded.profile, "default");
  assert.deepEqual(loaded.profiles, ["default"]);
  assert.equal(loaded.token, HOME_TOKEN);
  assert.deepEqual(loaded.phoneTest, PHONE);
  assert.equal((await b.read()).profiles, undefined, "reading does not rewrite");
  await writeConfig(b.path, { ...loaded, computerName: "Studio" }, { expectedRevision: loaded.revision });
  const migrated = await b.read();
  assert.deepEqual(Object.keys(migrated), ["version", "activeProfile", "profiles", "accounts", "computerName"]);
  assert.equal(migrated.activeProfile, "default");
  assert.equal(migrated.profiles.default.token, HOME_TOKEN);
  assert.deepEqual(migrated.profiles.default.phoneTest, PHONE);
  assert.equal(migrated.token, undefined);
  assert.deepEqual(migrated.accounts, { "/x/.claude": "me" });
});

test("auth status shows the profile; commands use the active profile's token", async () => {
  const b = await box();
  const out = await b.run(["auth", "status"]);
  assert.equal(out.exitCode, EXIT.OK);
  assert.equal(out.line.profile, "default");
  assert.deepEqual(b.state.tokens, [HOME_TOKEN]);
});

test("login --profile stores a second sign-in without touching the first, and does not switch to it", async () => {
  const b = await box();
  b.state.clientName = "Studio";
  const out = await b.run(["auth", "login", "--profile", "work", "--timeout", "60s"]);
  assert.equal(out.exitCode, EXIT.OK, JSON.stringify(out.line));
  assert.equal(out.line.profile, "work");
  assert.deepEqual(b.state.started, ["https://home.example"], "a new profile signs in to the active profile's server by default");
  const file = await b.read();
  assert.deepEqual(Object.keys(file.profiles), ["default", "work"]);
  assert.equal(file.activeProfile, "default");
  assert.equal(file.profiles.default.token, HOME_TOKEN);
  assert.deepEqual(file.profiles.default.phoneTest, PHONE, "the phone test stays with its profile");
  assert.equal(file.profiles.work.token, WORK_TOKEN);
  assert.equal(file.profiles.work.phoneTest, undefined, "verification is per profile");
  assert.deepEqual(file.accounts, { "/x/.claude": "me" }, "account nicknames are shared");
  await b.run(["auth", "status"]);
  assert.equal(b.state.tokens.at(-1), HOME_TOKEN);
});

test("auth switch makes a profile active; RELO_PROFILE overrides it for one command; RELO_TOKEN overrides both", async () => {
  const b = await box();
  await b.run(["auth", "login", "--profile", "work", "--timeout", "60s"]);
  const switched = await b.run(["auth", "switch", "work"]);
  assert.deepEqual(switched.line, { ok: true, profile: "work", profiles: ["default", "work"] });
  assert.equal((await b.read()).activeProfile, "work");
  assert.equal((await b.read()).profiles.default.token, HOME_TOKEN, "switching never touches a token");
  const status = await b.run(["auth", "status"]);
  assert.equal(status.line.profile, "work");
  assert.equal(b.state.tokens.at(-1), WORK_TOKEN);
  const viaEnv = await b.run(["auth", "status"], { env: { RELO_PROFILE: "default" } });
  assert.equal(viaEnv.line.profile, "default");
  assert.equal(b.state.tokens.at(-1), HOME_TOKEN);
  const viaToken = await b.run(["auth", "status"], { env: { RELO_TOKEN: ENV_TOKEN, RELO_API_URL: "https://ci.example", RELO_PROFILE: "work" } });
  assert.equal(b.state.tokens.at(-1), ENV_TOKEN);
  assert.equal(viaToken.line.source, "RELO_TOKEN");
  assert.equal(viaToken.line.profile, undefined);
  await b.run(["auth", "switch", "default"]);
  assert.equal((await b.read()).activeProfile, "default");
  assert.equal((await b.read()).profiles.work.token, WORK_TOKEN);
});

test("an unknown profile is a clear error with the command to create it; bad names are refused", async () => {
  const b = await box();
  const missing = await b.run(["auth", "status"], { env: { RELO_PROFILE: "nope" } });
  assert.equal(missing.exitCode, EXIT.AUTH);
  assert.match(missing.line.error.hint ?? missing.line.error.message, /relo auth login --profile nope/u);
  const switched = await b.run(["auth", "switch", "nope"]);
  assert.equal(switched.exitCode, EXIT.USAGE);
  assert.match(switched.line.error.hint, /Profiles: default/u);
  assert.equal((await b.run(["auth", "switch", "bad name!"])).exitCode, EXIT.USAGE);
  assert.equal((await b.run(["auth", "login", "--profile", "../x", "--no-wait"])).exitCode, EXIT.USAGE);
  assert.equal((await b.run(["auth", "switch"])).exitCode, EXIT.USAGE);
  assert.equal((await b.run(["activity", "list", "--profile", "work"])).exitCode, EXIT.USAGE);
});

test("logout removes only the active profile and keeps the other", async () => {
  const b = await box();
  await b.run(["auth", "login", "--profile", "work", "--timeout", "60s"]);
  await b.run(["auth", "switch", "work"]);
  const out = await b.run(["auth", "logout"]);
  assert.equal(out.exitCode, EXIT.OK);
  assert.ok(b.state.tokens.includes(`revoked:${WORK_TOKEN}`));
  const file = await b.read();
  assert.deepEqual(Object.keys(file.profiles), ["default"]);
  assert.equal(file.activeProfile, "default");
  assert.equal(file.profiles.default.token, HOME_TOKEN);
  const last = await b.run(["auth", "logout"]);
  assert.equal(last.exitCode, EXIT.OK);
  assert.equal((await b.run(["auth", "status"])).exitCode, EXIT.AUTH, "the file is gone with the last profile");
});

test("a pending --no-wait sign-in remembers its profile for --wait", async () => {
  const b = await box();
  const started = await b.run(["auth", "login", "--profile", "work", "--no-wait"]);
  assert.equal(started.line.state, "pending");
  const waited = await b.run(["auth", "login", "--wait"]);
  assert.equal(waited.exitCode, EXIT.OK, JSON.stringify(waited.line));
  assert.equal(waited.line.profile, "work");
  assert.equal((await b.read()).profiles.work.token, WORK_TOKEN);
});

test("switchProfile and writeConfig keep every other profile byte-equal in meaning", async () => {
  const b = await box({ legacy: false });
  await writeConfig(b.path, { apiUrl: "https://a.example", token: HOME_TOKEN, profile: "a" });
  await writeConfig(b.path, { apiUrl: "https://b.example", token: WORK_TOKEN, profile: "b", phoneTest: PHONE });
  assert.equal((await b.read()).activeProfile, "a", "the first profile stays active");
  await switchProfile(b.path, "b");
  const before = await b.read();
  const loaded = await loadConfig(b.path);
  await writeConfig(b.path, { ...loaded, phoneTest: undefined }, { expectedRevision: loaded.revision });
  const after = await b.read();
  assert.deepEqual(after.profiles.a, before.profiles.a);
  assert.equal(after.profiles.b.phoneTest, undefined);
  assert.equal(after.activeProfile, "b");
});
