import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execute, overrides, CONFIG, issuedCredential } from "./cli-fixtures.mjs";
import { saveKeyStore } from "../src/crypto/keystore.mjs";
import { hookDependencies, terminationSignals } from "../src/hook-deps.mjs";
import { maybeStartAutoUpdate } from "../src/owner/auto-update.mjs";
import { openMacApp } from "../src/owner/auth.mjs";
import { readLocalFacts } from "../src/owner/local-doctor.mjs";
import {
  ACL_MARKER, ensurePrivateDirectory, inspectConfigAcl, otherPrincipals, restrictArguments, restrictToCurrentUser,
} from "../src/shared/private-dir.mjs";
import { dataRoot, writeStateFile } from "../src/work/state-file.mjs";

const winEnv = () => {
  const root = mkdtempSync(join(tmpdir(), "relo-win-"));
  return { root, env: { APPDATA: join(root, "Roaming"), LOCALAPPDATA: join(root, "Local"), USERNAME: "ana", USERDOMAIN: "PC" } };
};
const recorder = (ok = true) => { const calls = []; return { calls, run: async (file, args) => { calls.push({ file, args }); return { ok, stdout: "" }; } }; };

// C6 -----------------------------------------------------------------------------------------------
test("the detached auto-update spawn hides its console window", () => {
  const spawned = [];
  const home = mkdtempSync(join(tmpdir(), "relo-au-"));
  maybeStartAutoUpdate({ latest: "9.9.9", version: "1.0.0", home, entrypoint: join(dataRoot(home), "cli", "1.0.0", "bin", "relo.mjs"), env: {}, now: Date.now(), compare: () => 1,
    spawnImpl: (...args) => { spawned.push(args); return { unref() {}, on() {} }; } });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0][2].windowsHide, true);
  assert.equal(spawned[0][2].detached, true);
});

// C7 -----------------------------------------------------------------------------------------------
test("termination signals: win32 gets only what Node delivers there", () => {
  assert.deepEqual(terminationSignals("win32"), ["SIGINT", "SIGBREAK", "SIGHUP"]);
  assert.deepEqual(terminationSignals("linux"), ["SIGTERM", "SIGINT", "SIGHUP"]);
  assert.deepEqual(terminationSignals("darwin"), ["SIGTERM", "SIGINT", "SIGHUP"]);
});

test("onTerminate registers the platform's signals and release removes them", () => {
  for (const [platform, signal, absent] of [["win32", "SIGBREAK", "SIGTERM"], ["linux", "SIGTERM", "SIGBREAK"]]) {
    const deps = hookDependencies({ platform, home: tmpdir() });
    const before = [process.listenerCount(signal), process.listenerCount(absent)];
    const release = deps.onTerminate(() => {});
    assert.equal(process.listenerCount(signal), before[0] + 1);
    assert.equal(process.listenerCount(absent), before[1]);
    release();
    assert.equal(process.listenerCount(signal), before[0]);
  }
});

// C8 -----------------------------------------------------------------------------------------------
test("restrictToCurrentUser: icacls once on the config folder, then the marker stops it", async () => {
  const { root, env } = winEnv();
  const { calls, run } = recorder();
  const dir = join(env.APPDATA, "relo");
  assert.equal(await ensurePrivateDirectory(dir, { platform: "win32", env, run }), "restricted");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [dir, "/inheritance:r", "/grant:r", "PC\\ana:(OI)(CI)F"]);
  assert.deepEqual(calls[0].args, restrictArguments(dir, "PC\\ana"));
  assert.ok(existsSync(join(dir, ACL_MARKER)));
  assert.equal(await ensurePrivateDirectory(dir, { platform: "win32", env, run }), "done");
  assert.equal(calls.length, 1);
  assert.ok(root);
});

test("restrictToCurrentUser: a failed icacls is remembered too and never throws", async () => {
  const { env } = winEnv();
  const { calls, run } = recorder(false);
  const dir = join(env.APPDATA, "relo");
  assert.equal(await ensurePrivateDirectory(dir, { platform: "win32", env, run }), "failed");
  assert.equal(readFileSync(join(dir, ACL_MARKER), "utf8").trim(), "failed");
  assert.equal(await ensurePrivateDirectory(dir, { platform: "win32", env, run }), "done");
  assert.equal(calls.length, 1);
  assert.equal(await restrictToCurrentUser(dir, { platform: "win32", env, run: async () => { throw new Error("boom"); }, force: true }), "failed");
});

test("restrictToCurrentUser: not on POSIX, and not on a folder the owner chose", async () => {
  const { root, env } = winEnv();
  const { calls, run } = recorder();
  assert.equal(await ensurePrivateDirectory(join(env.APPDATA, "relo"), { platform: "linux", env, run }), "skipped");
  assert.equal(await ensurePrivateDirectory(join(root, "elsewhere"), { platform: "win32", env, run }), "skipped");
  assert.equal(calls.length, 0);
});

test("the key store and state files restrict their folder (config: %APPDATA%\\relo; state: %LOCALAPPDATA%\\Relo)", async () => {
  const { env } = winEnv();
  const { calls, run } = recorder();
  await saveKeyStore(join(env.APPDATA, "relo", "e2ee.json"), { version: 1, identity: null, trusted: {} }, { privateDirectory: { platform: "win32", env, run } });
  await writeStateFile(join(env.LOCALAPPDATA, "Relo", "state", "hooks", "a.json"), { v: 1 }, { privateDirectory: { platform: "win32", env, run } });
  await writeStateFile(join(env.LOCALAPPDATA, "Relo", "state", "hooks", "b.json"), { v: 1 }, { privateDirectory: { platform: "win32", env, run } });
  assert.deepEqual(calls.map((call) => call.args[0]), [join(env.APPDATA, "relo"), join(env.LOCALAPPDATA, "Relo")]);
});

const OUTPUT = (dir, ...rest) => `${dir} ${rest[0]}\n${rest.slice(1).map((line) => `${" ".repeat(dir.length + 1)}${line}`).join("\n")}\n\nSuccessfully processed 1 files; Failed processing 0 files\n`;

test("otherPrincipals reads icacls output", () => {
  const dir = "C:\\Users\\ana\\AppData\\Roaming\\relo";
  const private_ = OUTPUT(dir, "PC\\ana:(OI)(CI)(F)", "NT AUTHORITY\\SYSTEM:(OI)(CI)(F)", "BUILTIN\\Administrators:(OI)(CI)(F)");
  assert.deepEqual(otherPrincipals(private_, { dir, user: "PC\\ana" }), []);
  const open = OUTPUT(dir, "PC\\ana:(OI)(CI)(F)", "BUILTIN\\Users:(OI)(CI)(RX)", "Everyone:(OI)(CI)(R)", "PC\\bob:(DENY)(R)");
  assert.deepEqual(otherPrincipals(open, { dir, user: "PC\\ana" }), ["BUILTIN\\Users", "Everyone"]);
});

test("inspectConfigAcl: private is ok, a readable folder warns, POSIX and a failing icacls say nothing", async () => {
  const { env } = winEnv();
  const dir = "C:\\cfg\\relo";
  const say = (stdout, ok = true) => async () => ({ ok, stdout });
  assert.deepEqual(await inspectConfigAcl(dir, { platform: "win32", env, run: say(OUTPUT(dir, "PC\\ana:(OI)(CI)(F)")) }), { ok: true, state: "private" });
  const warn = await inspectConfigAcl(dir, { platform: "win32", env, run: say(OUTPUT(dir, "PC\\ana:(OI)(CI)(F)", "Everyone:(R)")) });
  assert.equal(warn.ok, false);
  assert.match(warn.state, /Everyone/u);
  assert.equal(warn.run, "relo setup");
  assert.equal(await inspectConfigAcl(dir, { platform: "linux", env, run: say("") }), undefined);
  assert.equal(await inspectConfigAcl(dir, { platform: "win32", env, run: say("", false) }), undefined);
});

test("doctor shows the config ACL warning", async () => {
  const client = { ready: async () => ({ status: "ok" }), authStatus: async () => ({ authenticated: true, credential: issuedCredential().credential }), doctor: async () => ({ version: 1, ok: true, checks: {} }) };
  const configAcl = async () => ({ ok: false, state: "readable by Everyone", hint: "Restrict the Relo folder to your account: relo setup", run: "relo setup" });
  const output = await execute(["doctor"], { ...overrides(client), loadConfig: async () => CONFIG, configAcl, env: { RELO_UPDATES: "managed" } });
  assert.equal(output.data.warnings.configAcl.state, "readable by Everyone");
  assert.equal(output.data.ok, true);
});

// C9 -----------------------------------------------------------------------------------------------
test("openMacApp never spawns `open` off a Mac", () => {
  const spawned = [];
  const spawnImpl = (...args) => { spawned.push(args); return { on() {}, unref() {} }; };
  for (const platform of ["win32", "linux"]) assert.throws(() => openMacApp("/Applications/Relo.app", ["--x"], { platform, spawnImpl }));
  assert.equal(spawned.length, 0);
  openMacApp("/Applications/Relo.app", ["--x"], { platform: "darwin", spawnImpl });
  assert.equal(spawned[0][0], "open");
  assert.equal(spawned[0][2].windowsHide, true);
});

test("readLocalFacts on win32 reports health and the platform, and skips the launcher and plutil", async () => {
  const facts = await readLocalFacts({ apiUrl: "http://127.0.0.1:4815", home: mkdtempSync(join(tmpdir(), "relo-lf-")), platform: "win32",
    fetchImpl: async () => ({ ok: true, json: async () => ({ status: "ok", release: "1.2.0+45" }) }) });
  assert.deepEqual(facts, { health: { release: "1.2.0+45" }, app: null, bundledCli: null, platform: "win32" });
});
