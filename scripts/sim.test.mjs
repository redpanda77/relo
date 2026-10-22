import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { booted, elapsedMs, heldLeases, toReap } from "./sim.mjs";

test("ps elapsed time reads days, hours, minutes and seconds", () => {
  assert.equal(elapsedMs("05:21"), (5 * 60 + 21) * 1000);
  assert.equal(elapsedMs("05:21:24"), ((5 * 60 + 21) * 60 + 24) * 1000);
  assert.equal(elapsedMs("2-01:00:00"), 49 * 3600 * 1000);
});

test("booted devices carry their up time from their launchd_sim", () => {
  const devices = booted({
    list: () => ({ devices: { "iOS 27.0": [{ udid: "A", name: "iPhone Air", state: "Booted" }, { udid: "B", name: "iPhone 17", state: "Shutdown" }] } }),
    ps: () => "  05:21:24 launchd_sim /Users/x/Library/Developer/CoreSimulator/Devices/A/data/var/run/launchd_bootstrap.plist\n  00:10 node x",
  });
  assert.deepEqual(devices, [{ udid: "A", name: "iPhone Air", upMs: 19_284_000 }]);
});

test("a lease held by a live process keeps its device; a dead holder's lease is dropped", () => {
  const dir = mkdtempSync(join(tmpdir(), "relo-sim-"));
  writeFileSync(join(dir, "A.1.json"), JSON.stringify({ udid: "A", pid: process.pid }));
  writeFileSync(join(dir, "B.2.json"), JSON.stringify({ udid: "B", pid: 999_999_999 }));
  assert.deepEqual([...heldLeases(dir)], ["A"]);
  assert.deepEqual(readdirSync(dir), ["A.1.json"]);
});

test("the reaper takes only unleased devices up longer than the idle limit", () => {
  const devices = [{ udid: "A", upMs: 3_600_000 }, { udid: "B", upMs: 3_600_000 }, { udid: "C", upMs: 60_000 }];
  assert.deepEqual(toReap(devices, new Set(["A"]), 15 * 60_000).map((device) => device.udid), ["B"]);
});
