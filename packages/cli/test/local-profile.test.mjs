import "./hermetic-env.mjs";
import { loginKeyStoreEnv } from "./cli-fixtures.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EXIT } from "../src/shared/errors.mjs";
import { run } from "../src/cli.mjs";
import { loadConfig } from "../src/shared/config.mjs";

const CODE = `rci_${"a".repeat(32)}`;
const LOCAL_TOKEN = `relo_${"l".repeat(43)}`;
const REMOTE_TOKEN = `relo_${"r".repeat(43)}`;
const NEW_TOKEN = `relo_${"n".repeat(43)}`;
const SCOPES = ["activities:read", "activities:write", "devices:read", "interactions:create", "interactions:read",
  "notifications:send", "services:read", "services:write"];

async function cli(argv, dependencies) {
  const stdout = [];
  const exitCode = await run(argv, { stdout: (line) => stdout.push(line), stderr: () => {}, stdoutIsTTY: false }, dependencies);
  return { exitCode, line: stdout[0] ? JSON.parse(stdout[0]) : undefined };
}

async function box(file) {
  const dir = await mkdtemp(join(tmpdir(), "relo-local-profile-"));
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify(file), { mode: 0o600 });
  const revoked = [];
  const client = (config) => ({
    putComputerSelf: async () => ({}),
    redeemComputerInvite: async (body) => ({ accessToken: NEW_TOKEN, setup: { level: "track", approvals: false },
      credential: { id: "key_0123456789ab", clientName: body.clientName, prefix: "relo_nnnn", scopes: body.scopes } }),
    revokeAuth: async () => { revoked.push(config.token); return { revoked: true }; },
  });
  const deps = { env: { RELO_CONFIG_PATH: path, RELO_LOCAL_SERVER_CONFIG: join(dir, "server-config.json"), ...loginKeyStoreEnv() },
    clientFactory: client, computerName: () => "Studio", stderr: () => {} };
  return { dir, path, revoked, deps, read: async () => JSON.parse(await readFile(path, "utf8")),
    run: (argv) => cli(argv, deps) };
}

const localProfile = { version: 1, apiUrl: "http://127.0.0.1:7777", token: LOCAL_TOKEN, local: true };
const remoteProfile = { version: 1, apiUrl: "https://home.example", token: REMOTE_TOKEN };

test("join without --profile never writes over the local profile", async () => {
  const b = await box({ version: 1, activeProfile: "default", profiles: { default: localProfile }, projects: { "/work/x": "X" } });
  const out = await b.run(["auth", "join", CODE, "--api-url", "https://remote.example", "--no-setup"]);
  assert.equal(out.exitCode, EXIT.OK, JSON.stringify(out.line));
  const file = await b.read();
  assert.equal(file.profiles.default.token, LOCAL_TOKEN, "the local profile is intact");
  assert.equal(file.profiles.default.local, true);
  assert.deepEqual(Object.keys(file.profiles).sort(), ["default", "remote-example"]);
  assert.equal(file.profiles["remote-example"].token, NEW_TOKEN);
  assert.equal(file.profiles["remote-example"].local, undefined);
  assert.equal(file.activeProfile, "remote-example");
  assert.deepEqual(file.projects, { "/work/x": "X" });
});

test("join without --profile writes `default` when another profile is the local one", async () => {
  const b = await box({ version: 1, activeProfile: "local", profiles: { local: localProfile } });
  const out = await b.run(["auth", "join", CODE, "--api-url", "https://remote.example", "--no-setup"]);
  assert.equal(out.exitCode, EXIT.OK, JSON.stringify(out.line));
  const file = await b.read();
  assert.equal(file.profiles.local.token, LOCAL_TOKEN);
  assert.equal(file.profiles.default.token, NEW_TOKEN);
  assert.equal(file.activeProfile, "default");
});

test("logout --only-local skips a remote profile and removes a local one", async () => {
  const b = await box({ version: 1, activeProfile: "default", profiles: { default: remoteProfile, local: localProfile } });
  const skipped = await b.run(["auth", "logout", "--profile", "default", "--only-local"]);
  assert.equal(skipped.exitCode, EXIT.OK, JSON.stringify(skipped.line));
  assert.equal(skipped.line.credentialsRemoved, false);
  assert.match(skipped.line.note, /Skipped/u);
  assert.deepEqual(b.revoked, [], "nothing was revoked");
  assert.deepEqual(Object.keys((await b.read()).profiles).sort(), ["default", "local"]);
  const removed = await b.run(["auth", "logout", "--profile", "local", "--only-local"]);
  assert.equal(removed.exitCode, EXIT.OK, JSON.stringify(removed.line));
  assert.equal(removed.line.credentialsRemoved, true);
  assert.deepEqual(b.revoked, [LOCAL_TOKEN]);
  assert.deepEqual(Object.keys((await b.read()).profiles), ["default"]);
});

test("a local profile follows the port in the server's own config", async () => {
  const b = await box({ version: 1, activeProfile: "default", profiles: { default: localProfile, remote: { ...remoteProfile, apiUrl: "https://home.example" } } });
  const env = { RELO_LOCAL_SERVER_CONFIG: join(b.dir, "server-config.json") };
  assert.equal((await loadConfig(b.path, { env })).apiUrl, "http://127.0.0.1:7777", "no server config: the stored URL");
  await writeFile(env.RELO_LOCAL_SERVER_CONFIG, JSON.stringify({ port: 8123 }));
  assert.equal((await loadConfig(b.path, { env })).apiUrl, "http://127.0.0.1:8123");
  assert.equal((await loadConfig(b.path, { env, profile: "remote" })).apiUrl, "https://home.example", "a remote profile never follows it");
  await writeFile(env.RELO_LOCAL_SERVER_CONFIG, "not json");
  assert.equal((await loadConfig(b.path, { env })).apiUrl, "http://127.0.0.1:7777");
});

test("logging out of the last profile keeps the file's other fields and reads as not signed in", async () => {
  const other = { projects: { "/work/x": "X" }, voices: { "*": "brief" }, computerName: "Studio", accounts: { "/x/.claude": "me" } };
  const b = await box({ version: 1, activeProfile: "local", profiles: { local: localProfile }, ...other });
  const out = await b.run(["auth", "logout", "--profile", "local", "--only-local"]);
  assert.equal(out.exitCode, EXIT.OK, JSON.stringify(out.line));
  const file = await b.read();
  assert.deepEqual(file.profiles, {});
  for (const [key, value] of Object.entries(other)) assert.deepEqual(file[key], value);
  const status = await b.run(["auth", "status"]);
  assert.notEqual(status.exitCode, EXIT.OK);
  assert.match(JSON.stringify(status.line), /CONFIG_NOT_FOUND|not signed in|No Relo credential/iu);
  const again = await b.run(["auth", "logout"]);
  assert.equal(again.exitCode, EXIT.OK);
  assert.equal(again.line.alreadyLoggedOut, true);
});
