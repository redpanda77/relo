import "./hermetic-env.mjs";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireUpdateLock, ASK_MS, launcherManaged, maybeStartAutoUpdate, recordAutoUpdate, RETRY_MS, setUpdateMode, updateMode } from "../src/owner/auto-update.mjs";
import { askToUpdate } from "../src/owner/update.mjs";
import { EventEmitter } from "node:events";
import { compareVersions } from "../src/owner/releases.mjs";
import { ReloApiClient, latestCliSeen } from "../src/shared/api-client.mjs";
import { dataRoot } from "../src/work/state-file.mjs";

const NOW = Date.parse("2026-10-17T10:00:00Z");

function box() {
  const home = mkdtempSync(join(tmpdir(), "relo-auto-"));
  const entrypoint = join(dataRoot(home), "cli", "0.17.40", "bin", "relo.mjs");
  const spawned = [];
  const spawnImpl = (command, args, options) => { spawned.push({ command, args, options }); return { unref() {} }; };
  const start = (overrides = {}) => maybeStartAutoUpdate({ latest: "0.17.41", version: "0.17.40", home, entrypoint, now: NOW, compare: compareVersions, spawnImpl, ...overrides });
  return { home, entrypoint, spawned, start };
}

test("a newer server CLI starts one detached update for an install-script CLI", () => {
  const b = box();
  assert.equal(b.start(), true);
  assert.deepEqual(b.spawned.map(({ args, options }) => ({ args, detached: options.detached, stdio: options.stdio })), [{ args: [b.entrypoint, "update", "--auto"], detached: true, stdio: "ignore" }]);
  assert.deepEqual(JSON.parse(readFileSync(join(dataRoot(b.home), "auto-update.json"), "utf8")), { target: "0.17.41", from: "0.17.40", at: new Date(NOW).toISOString() });
});

test("no hammering: the same version is tried once an hour, and never while an updater holds the lock", () => {
  const b = box();
  assert.equal(b.start(), true);
  assert.equal(b.start(), false, "the next command within the hour");
  assert.equal(b.start({ now: NOW + RETRY_MS + 1 }), true, "an hour later");
  assert.equal(b.start({ latest: "0.17.42", now: NOW + RETRY_MS + 2 }), true, "a newer version");
  // The lock's age is the file's own time, so this part runs on the real clock.
  const c = box();
  const release = acquireUpdateLock(c.home);
  assert.ok(release);
  assert.equal(c.start({ now: Date.now() }), false, "an updater is running");
  assert.equal(acquireUpdateLock(c.home), undefined, "one updater at a time");
  release();
  assert.ok(acquireUpdateLock(c.home), "free again");
});

test("a lock left by a crashed updater expires after ten minutes", () => {
  const b = box();
  assert.ok(acquireUpdateLock(b.home));
  const lock = join(dataRoot(b.home), "auto-update.lock");
  const old = (Date.now() - 11 * 60_000) / 1000;
  utimesSync(lock, old, old);
  assert.ok(acquireUpdateLock(b.home));
});

test("nothing starts for the same or an older version, an npm install, or RELO_NO_UPDATE_CHECK=1", () => {
  const b = box();
  assert.equal(b.start({ latest: "0.17.40" }), false);
  assert.equal(b.start({ latest: "0.17.39" }), false);
  assert.equal(b.start({ entrypoint: "/usr/local/lib/node_modules/@relo/cli/bin/relo.mjs" }), false);
  assert.equal(b.start({ env: { RELO_NO_UPDATE_CHECK: "1" } }), false);
  assert.equal(b.spawned.length, 0);
  assert.equal(launcherManaged({ home: b.home, entrypoint: b.entrypoint }), true);
});

test("recordAutoUpdate keeps the target and adds how it ended", () => {
  const b = box();
  b.start();
  recordAutoUpdate(b.home, { ok: false, error: "UPDATE_INSTALL_FAILED" }, NOW + 5_000);
  const state = JSON.parse(readFileSync(join(dataRoot(b.home), "auto-update.json"), "utf8"));
  assert.equal(state.target, "0.17.41");
  assert.equal(state.ok, false);
});

test("the API client reads the server's newest CLI from any reply, without a request of its own", async () => {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(String(url)); return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "x-relo-cli-latest": "9.9.9", "content-type": "application/json" } }); };
  await new ReloApiClient({ apiUrl: "https://relo.example.test", token: "t", fetchImpl }).request("GET", "/api/v1/state");
  assert.equal(latestCliSeen(), "9.9.9");
  assert.equal(calls.length, 1);
});

test("the update mode: RELO_NO_UPDATE_CHECK, then RELO_UPDATES, then relo update --mode, else auto", () => {
  const b = box();
  assert.equal(updateMode({ home: b.home }), "auto");
  setUpdateMode(b.home, "ask");
  assert.equal(updateMode({ home: b.home }), "ask");
  assert.equal(updateMode({ home: b.home, env: { RELO_UPDATES: "auto" } }), "auto");
  assert.equal(updateMode({ home: b.home, env: { RELO_UPDATES: "nonsense" } }), "ask");
  assert.equal(updateMode({ home: b.home, env: { RELO_UPDATES: "auto", RELO_NO_UPDATE_CHECK: "1" } }), "off");
  setUpdateMode(b.home, "off");
  assert.equal(b.start(), false, "off starts nothing");
});

test("auto undoes managed (and ask) cleanly: the stored choice and the old version's state are gone, the next update starts", () => {
  const b = box();
  setUpdateMode(b.home, "managed");
  assert.equal(updateMode({ home: b.home }), "managed");
  assert.equal(b.start({ env: { RELO_UPDATES: "managed" } }), false, "managed starts nothing");
  assert.equal(b.start({ now: NOW + 1 }), true, "a CLI outside the app (the install script's) is not managed by the stored mode");
  rmSync(join(dataRoot(b.home), "auto-update.json"), { force: true });
  recordAutoUpdate(b.home, { declined: true, asking: false, target: "0.17.41" });
  setUpdateMode(b.home, "auto");
  assert.equal(updateMode({ home: b.home }), "auto");
  assert.equal(existsSync(join(dataRoot(b.home), "updates.json")), false, "auto is the default: nothing stored");
  assert.equal(existsSync(join(dataRoot(b.home), "auto-update.json")), false, "no stale declined version");
  assert.equal(b.start(), true, "the version the owner declined under ask starts now");
  setUpdateMode(b.home, "auto"); // again: nothing to remove, no error
  assert.equal(updateMode({ home: b.home }), "auto");
});

test("ask mode asks once per version: no second question while the phone may answer, none after a no", () => {
  const b = box();
  setUpdateMode(b.home, "ask");
  assert.equal(b.start(), true);
  assert.equal(JSON.parse(readFileSync(join(dataRoot(b.home), "auto-update.json"), "utf8")).asking, true);
  assert.equal(b.start({ now: NOW + RETRY_MS + 1 }), false, "an hour is not enough while asking");
  assert.equal(b.start({ now: NOW + ASK_MS + 1 }), true, "after the question expired");
  recordAutoUpdate(b.home, { declined: true, asking: false });
  assert.equal(b.start({ now: NOW + 3 * ASK_MS }), false, "the owner said no to this version");
  assert.equal(b.start({ latest: "0.17.42", now: NOW + 3 * ASK_MS }), true, "a newer version asks again");
});

test("the update question goes through relo ask with no agent session, and its exit code is the answer", async () => {
  const runs = [];
  const answer = (code) => askToUpdate({ dependencies: { entrypoint: "/x/relo.mjs", env: { HOME: "/h", PATH: "/bin", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "s" } },
    target: "0.17.52", computer: "build-box", spawnImpl: (command, args, options) => {
      runs.push({ args, env: options.env });
      const child = new EventEmitter();
      setImmediate(() => child.emit("exit", code));
      return child;
    } });
  assert.equal(await answer(0), "approved");
  assert.equal(await answer(5), "declined");
  assert.equal(await answer(8), "unanswered");
  assert.equal(runs[0].args[1], "ask");
  assert.equal(runs[0].args[2], "Update the Relo CLI on build-box to 0.17.52?");
  assert.ok(runs[0].args.includes("--notification-only"));
  assert.equal(runs[0].env.CLAUDECODE, undefined, "no agent session rides along");
  assert.equal(runs[0].env.HOME, "/h");
});
