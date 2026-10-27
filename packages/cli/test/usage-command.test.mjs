// Claude Code's own /usage as a second source for `relo usage`: parser, zone conversion, cache throttling.
import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { claudeUsageWindows, parseReset, parseUsage, zonedSeconds } from "../src/harness/adapters/claude-code/usage-command.mjs";
import { claudeAccount } from "../src/owner/usage/claude.mjs";
import { claudeUsagePath } from "../src/harness/adapters/claude-code/usage-record.mjs";

const SAMPLE = `You are currently using your subscription to power your Claude Code usage

Current session: 33% used · resets Oct 27 at 9:10pm (Asia/Dubai)
Current week (all models): 68% used · resets Oct 28 at 1pm (Asia/Dubai)
Current week (Fable): 0% used · resets Oct 28 at 1pm (Asia/Dubai)

What's contributing to your limits usage?
`;
const NOW = Date.UTC(2026, 9, 27, 12, 0); // 27 Oct 2026 12:00 UTC = 16:00 Dubai

test("zones convert wall time to Unix seconds", () => {
  assert.equal(zonedSeconds(2026, 9, 27, 21, 10, "Asia/Dubai"), Date.UTC(2026, 9, 27, 17, 10) / 1000);
  assert.equal(zonedSeconds(2026, 9, 28, 13, 0, "America/New_York"), Date.UTC(2026, 9, 28, 17, 0) / 1000, "EDT");
  assert.equal(zonedSeconds(2026, 10, 3, 9, 0, "America/New_York"), Date.UTC(2026, 10, 3, 14, 0) / 1000, "EST after the change");
  assert.equal(zonedSeconds(2026, 9, 27, 9, 0, "Not/AZone"), undefined);
});

test("parseUsage reads the session and the all-models week, ignoring per-model lines", () => {
  assert.deepEqual(parseUsage(SAMPLE, NOW), {
    five_hour: { usedPercent: 33, resetsAt: Date.UTC(2026, 9, 27, 17, 10) / 1000 },
    seven_day: { usedPercent: 68, resetsAt: Date.UTC(2026, 9, 28, 9, 0) / 1000 },
  });
});

test("reset text variants: minutes, 12am and 12pm, year rollover; odd text is skipped", () => {
  const at = (text, now = NOW) => parseReset(text, now);
  assert.equal(at("Oct 28 at 1pm (UTC)"), Date.UTC(2026, 9, 28, 13) / 1000);
  assert.equal(at("Oct 28 at 12am (UTC)"), Date.UTC(2026, 9, 28, 0) / 1000);
  assert.equal(at("Oct 28 at 12pm (UTC)"), Date.UTC(2026, 9, 28, 12) / 1000);
  assert.equal(at("Oct 28 at 12:30pm (UTC)"), Date.UTC(2026, 9, 28, 12, 30) / 1000);
  assert.equal(at("Jan 2 at 8am (UTC)", Date.UTC(2026, 11, 31, 12)), Date.UTC(2027, 0, 2, 8) / 1000, "next year");
  for (const bad of ["", undefined, "Oct 27 at 9pm", "tomorrow at 9pm (UTC)", "Oct 27 at 13pm (UTC)", "Oct 27 at 9pm (Not/AZone)", "Nov 20 at 9pm (UTC)", "Oct 20 at 9pm (UTC)"]) assert.equal(at(bad), undefined, String(bad));
});

test("parseUsage is defensive: missing week, 100%, no reset, garbage, API-key output", () => {
  assert.deepEqual(Object.keys(parseUsage("Current session: 10% used · resets Oct 27 at 11pm (UTC)\n", NOW)), ["five_hour"]);
  assert.equal(parseUsage("Current session: 100% used · resets Oct 27 at 11pm (UTC)", NOW).five_hour.usedPercent, 100);
  assert.deepEqual(parseUsage("Current session: 10% used", NOW), {});
  assert.deepEqual(parseUsage("Current session: lots · resets Oct 27 at 11pm (UTC)", NOW), {});
  assert.deepEqual(parseUsage("You are currently using an API key.\n\x00garbage", NOW), {});
  assert.deepEqual(parseUsage(undefined, NOW), {});
});

function box() {
  const state = mkdtempSync(join(tmpdir(), "relo-usage-cmd-"));
  const bin = join(state, "bin");
  mkdirSync(bin);
  const program = join(bin, "claude");
  writeFileSync(program, "#!/bin/sh\n");
  chmodSync(program, 0o755);
  const calls = [];
  const out = { text: SAMPLE };
  const run = async (call) => { calls.push(call); return out.text; };
  return { state, home: state, env: { PATH: bin }, calls, out, run, folder: join(state, ".claude-x") };
}
const read = (b, now) => claudeUsageWindows({ folder: b.folder, env: b.env, home: b.home, stateDirectory: b.state, now, run: b.run });

test("/usage runs once per five minutes per profile, failures included, and the cache stays fast", async () => {
  const b = box();
  const first = await read(b, NOW);
  assert.equal(b.calls.length, 1);
  assert.equal(b.calls[0].folder, b.folder);
  assert.equal(b.calls[0].cwd, b.state);
  assert.equal(first.windows.five_hour.usedPercent, 33);
  await read(b, NOW + 60_000);
  assert.equal(b.calls.length, 1, "young cache: no run");
  const other = await claudeUsageWindows({ folder: join(b.state, ".claude-y"), env: b.env, home: b.home, stateDirectory: b.state, now: NOW, run: b.run });
  assert.ok(other && b.calls.length === 2, "another profile has its own cache");
  b.out.text = "nothing useful";
  assert.equal(await read(b, NOW + 301_000), undefined, "old reading is not served after a failed run");
  assert.equal(b.calls.length, 3);
  await read(b, NOW + 400_000);
  assert.equal(b.calls.length, 3, "the failure is cached for five minutes");
  await read(b, NOW + 602_000);
  assert.equal(b.calls.length, 4);
});

test("no claude binary, a throwing runner or an unwritable state folder never throws", async () => {
  const b = box();
  assert.equal(await claudeUsageWindows({ folder: b.folder, env: { PATH: "/nonexistent" }, home: b.home, stateDirectory: b.state, now: NOW, run: b.run }), undefined);
  assert.equal(b.calls.length, 0);
  assert.equal(await claudeUsageWindows({ folder: b.folder, env: b.env, home: b.home, stateDirectory: b.state, now: NOW, run: async () => { throw new Error("x"); } }), undefined);
  assert.equal(await claudeUsageWindows({ folder: b.folder, env: b.env, home: b.home, stateDirectory: join(process.env.RELO_TEST_UNWRITABLE, "s"), now: NOW, run: b.run }) !== null, true);
});

test("an account prefers a fresh status-line recording, else /usage, and says which", async () => {
  const b = box();
  const account = { id: "claude-x", profile: "x", folder: b.folder };
  const deps = { home: b.home, stateDirectory: b.state, env: b.env, run: b.run };
  const recording = (readAt) => {
    mkdirSync(join(b.state, "usage"), { recursive: true });
    writeFileSync(claudeUsagePath(b.state, b.folder), JSON.stringify({ readAt, windows: { five_hour: { usedPercent: 7, resetsAt: NOW / 1000 + 3600 } } }));
  };
  recording(NOW - 60_000);
  let row = await claudeAccount(account, { ...deps, now: NOW });
  assert.equal(row.source, "status-line");
  assert.equal(row.windows[0].usedPercent, 7);
  assert.equal(b.calls.length, 0, "a fresh recording never runs /usage");
  recording(NOW - 600_000);
  row = await claudeAccount(account, { ...deps, now: NOW });
  assert.equal(row.source, "claude-usage");
  assert.deepEqual(row.windows.map((window) => [window.kind, window.usedPercent]), [["five_hour", 33], ["seven_day", 68]]);
  assert.equal(row.readAt, NOW);
  b.out.text = "";
  row = await claudeAccount(account, { ...deps, now: NOW + 900_000 });
  assert.equal(row.source, "status-line", "a failed run leaves the old recording");
  assert.equal(readdirSync(join(b.state, "usage")).length, 2);
});
