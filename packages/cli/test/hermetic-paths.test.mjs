// Tests never reach the developer's real state folder (a skill recipe test once queued declared writes in
// the real outbox; the installed CLI then dropped them as "queued for another server").
import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { configPath } from "../src/shared/config.mjs";
import { outboxDirectory } from "../src/outbox/index.mjs";
import { stateRoot } from "../src/work/state-file.mjs";

const realHome = userInfo().homedir;
const under = (path, root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
// On Windows the temp folder lives inside the real profile (C:\Users\me\AppData\Local\Temp), so "under the real home" excludes it.
const underRealHome = (path) => under(path, realHome) && !under(path, tmpdir());

test("every default state path in a test process is a temp folder, never under the real home", () => {
  assert.ok(!underRealHome(homedir()), `homedir() is ${homedir()}`);
  const paths = {
    "stateRoot()": stateRoot(),
    "stateRoot({})": stateRoot({}),
    "outboxDirectory()": outboxDirectory(),
    "outboxDirectory({ env: {} })": outboxDirectory({ env: {} }),
    "configPath()": configPath(),
  };
  for (const [name, path] of Object.entries(paths)) {
    assert.ok(!underRealHome(path), `${name} resolves under the real home: ${path}`);
    assert.ok(under(path, tmpdir()) || path.startsWith(`/private${tmpdir()}`), `${name} is not a temp folder: ${path}`);
  }
});

test("the outbox follows the state folder: RELO_STATE_DIR, then XDG_STATE_HOME, then the home", () => {
  assert.equal(outboxDirectory({ env: { RELO_STATE_DIR: "/s/relo", XDG_STATE_HOME: "/x" }, home: "/h" }), join("/s/relo", "outbox"));
  assert.equal(outboxDirectory({ env: { XDG_STATE_HOME: "/x" }, home: "/h" }), join("/x", "relo", "outbox"));
});

test("an injected env without a state folder keeps the state under the injected home, even in a non-hermetic process", async (t) => {
  // A process like the skill recipe test: the real HOME (here a stand-in), no XDG_STATE_HOME or RELO_STATE_DIR.
  const fakeRealHome = mkdtempSync(join(tmpdir(), "relo-test-real-home-"));
  const sandbox = mkdtempSync(join(tmpdir(), "relo-test-sandbox-"));
  t.after(() => { rmSync(fakeRealHome, { recursive: true, force: true }); rmSync(sandbox, { recursive: true, force: true }); });
  const cli = pathToFileURL(join(import.meta.dirname, "..", "src", "cli.mjs")).href;
  const apiClient = pathToFileURL(join(import.meta.dirname, "..", "src", "shared", "api-client.mjs")).href;
  const script = `
    const { execute } = await import(${JSON.stringify(cli)});
    const { ReloApiClient } = await import(${JSON.stringify(apiClient)});
    const sandbox = process.argv[1];
    const offline = async () => { throw new TypeError("fetch failed"); };
    await execute(["work", "start", "--goal", "Tidy the release notes", "--plan", "Collect changes,Write notes"], {
      env: { CLAUDE_CODE_SESSION_ID: "hermetic-paths" },
      home: sandbox, cwd: sandbox, configPath: () => sandbox + "/config.json",
      loadConfig: async () => ({ apiUrl: "https://relo.example.test", token: "x".repeat(44) }),
      clientFactory: (config) => new ReloApiClient({ apiUrl: config.apiUrl, token: config.token, fetchImpl: offline }),
      identityDefaults: () => ({ providerName: "Claude Code", project: "relo" }),
    }).catch(() => {});
  `;
  const env = { PATH: process.env.PATH, HOME: fakeRealHome, RELO_NO_BACKGROUND_FLUSH: "1", RELO_NO_UPDATE_CHECK: "1",
    RELO_KEY_STORE_PATH: join(sandbox, "e2ee.json"), RELO_HARNESS_CREDENTIAL_PATH: join(sandbox, "harness-credential") };
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, sandbox], { env, cwd: sandbox });
  const queued = join(sandbox, ...(process.platform === "win32" ? ["AppData", "Local", "Relo", "state"] : [".local", "state", "relo"]), "outbox", "declared");
  assert.ok(existsSync(queued) && readdirSync(queued).length > 0, "the offline start was queued under the injected home");
  assert.deepEqual(readdirSync(fakeRealHome), [], "nothing was written under the process's home");
});
