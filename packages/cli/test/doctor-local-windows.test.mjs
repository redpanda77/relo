import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execute, overrides, CONFIG, issuedCredential } from "./cli-fixtures.mjs";
import { VERSION } from "../src/version.mjs";
import { evaluateLocal, mismatchWarning, readWindowsAppFacts } from "../src/owner/local-doctor.mjs";

const client = () => ({
  ready: async () => ({ status: "ok" }), authStatus: async () => ({ authenticated: true, credential: issuedCredential().credential }),
  doctor: async () => ({ version: 1, ok: true, checks: {} }),
});
const LOCAL = { ...CONFIG, apiUrl: "http://127.0.0.1:4815", local: true };

function installedApp() {
  const localAppData = mkdtempSync(join(tmpdir(), "relo-doctor-win-"));
  const app = join(localAppData, "Programs", "Relo");
  mkdirSync(join(localAppData, "Relo", "bin"), { recursive: true });
  mkdirSync(join(app, "server", "cli"), { recursive: true });
  writeFileSync(join(localAppData, "Relo", "bin", "relo.cmd"),
    `@echo off\r\nrem Written by Relo for Windows\r\nrem relo launcher: ${app}\\server\\cli\\bin\\relo.mjs\r\n"${app}\\server\\node.exe" "${app}\\server\\cli\\bin\\relo.mjs" %*\r\n`);
  writeFileSync(join(app, "server", "release-identity.txt"), "0.1.0\n");
  writeFileSync(join(app, "server", "cli", "package.json"), JSON.stringify({ version: VERSION }));
  return { localAppData, app };
}

test("on Windows the launcher names the app, release-identity.txt is its version, and the words say Relo for Windows", () => {
  const { localAppData, app } = installedApp();
  const read = readWindowsAppFacts({ health: { release: "0.1.0" }, app: null, bundledCli: null, platform: "win32" }, { env: { LOCALAPPDATA: localAppData } });
  assert.deepEqual(read.app, { path: app, version: "0.1.0" });
  assert.equal(read.bundledCli, VERSION);
  const local = evaluateLocal(read, { version: VERSION, updateMode: "managed" });
  assert.equal(local.versionsMatch, true);
  assert.equal(local.appName, "Relo for Windows");
  assert.equal(evaluateLocal({ ...read, health: null }, { version: VERSION, updateMode: "managed" }).hint, "Open Relo for Windows: it starts its server");
  const old = evaluateLocal({ ...read, health: { release: "0.0.9" } }, { version: VERSION, updateMode: "managed" });
  assert.equal(mismatchWarning(old).hint, "Quit and reopen Relo for Windows to restart its server");
});

test("on Windows without a launcher there are no app facts and nothing throws; the Mac keeps its words", () => {
  const { localAppData } = installedApp();
  assert.equal(readWindowsAppFacts({ app: null }, { env: { LOCALAPPDATA: join(localAppData, "none") } }).app, null);
  assert.equal(readWindowsAppFacts({ app: null }, { env: {} }).app, null);
  const mac = evaluateLocal({ health: null, app: null, bundledCli: null }, { version: VERSION, updateMode: "managed" });
  assert.equal(mac.hint, "Open Relo for Mac: it starts its server");
  assert.equal("appName" in mac, false);
});

test("relo doctor on Windows reports the local section with the Windows app", async () => {
  const facts = { health: { release: "0.1.0" }, app: { path: "C:\\Relo", version: "0.1.0" }, bundledCli: VERSION, platform: "win32" };
  const output = await execute(["doctor"], { ...overrides(client()), loadConfig: async () => LOCAL, localFacts: async () => facts, env: { RELO_UPDATES: "managed" } });
  assert.equal(output.data.checks.local.appName, "Relo for Windows");
  assert.equal(output.data.checks.local.versionsMatch, true);
});
