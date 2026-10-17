import "./hermetic-env.mjs";
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireUpdateLock, launcherManaged, maybeStartAutoUpdate, recordAutoUpdate, RETRY_MS } from "../src/owner/auto-update.mjs";
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
