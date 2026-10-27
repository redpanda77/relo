// `relo usage` and the status line's plan-limit recording: local reads only.
import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as zlib from "node:zlib";
import { runStatusline } from "../src/harness/entry.mjs";
import { claudeConfigFolder, claudeUsagePath, usageKey, windowsOf } from "../src/harness/adapters/claude-code/usage-record.mjs";
import { emailOfIdToken, lastRateLimits } from "../src/owner/usage/codex.mjs";
import { planLabel } from "../src/owner/usage/claude.mjs";
import { SESSION_ID, cli, hookBox } from "./hook-fixture.mjs";

const NOW = 1_800_000_000_000;
const SECONDS = NOW / 1000;
const usageFiles = (state) => { try { return readdirSync(join(state, "usage")); } catch { return []; } };

async function statusline(box, input, env = {}) {
  await runStatusline({ ...box.deps(), env: { RELO_STATE_DIR: box.state, ...env }, readStdinRaw: async () => Buffer.from(typeof input === "string" ? input : JSON.stringify(input)), write: () => {} });
}
const limits = (five = 40, seven = 10) => ({ five_hour: { used_percentage: five, resets_at: SECONDS + 3600 }, seven_day: { used_percentage: seven, resets_at: SECONDS + 86_400 } });

test("the status line records Claude's limits, skips an unchanged reading, rewrites a changed one or an old one", async () => {
  const box = await hookBox();
  await statusline(box, { session_id: SESSION_ID, rate_limits: limits() });
  const [name] = usageFiles(box.state);
  assert.match(name, /^claude-.+\.json$/u);
  assert.equal((await import("node:fs")).statSync(join(box.state, "usage")).mode & 0o777, 0o700);
  const path = join(box.state, "usage", name);
  const first = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(first.windows, { five_hour: { usedPercent: 40, resetsAt: SECONDS + 3600 }, seven_day: { usedPercent: 10, resetsAt: SECONDS + 86_400 } });
  assert.equal(first.readAt, NOW);
  assert.equal(first.configDir, claudeConfigFolder({}, box.state));
  box.clock += 30_000;
  await statusline(box, { rate_limits: limits() });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).readAt, NOW, "unchanged and young: not rewritten");
  await statusline(box, { rate_limits: limits(41) });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).windows.five_hour.usedPercent, 41, "changed");
  box.clock += 61_000;
  await statusline(box, { rate_limits: limits(41) });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).readAt, box.clock, "old: rewritten");
});

test("missing, odd or partial rate_limits record nothing or only the valid window", async () => {
  const box = await hookBox();
  for (const input of [{ session_id: SESSION_ID }, { rate_limits: null }, { rate_limits: "x" }, { rate_limits: [] }, { rate_limits: { five_hour: { used_percentage: "a", resets_at: 1 } } },
    { rate_limits: { five_hour: { used_percentage: null, resets_at: null } } }, "not json"]) await statusline(box, input);
  assert.deepEqual(usageFiles(box.state), []);
  await statusline(box, { rate_limits: { seven_day: { used_percentage: 12.34, resets_at: SECONDS + 5 }, five_hour: {} } });
  const [name] = usageFiles(box.state);
  assert.deepEqual(JSON.parse(readFileSync(join(box.state, "usage", name), "utf8")).windows, { seven_day: { usedPercent: 12.3, resetsAt: SECONDS + 5 } });
  assert.deepEqual(windowsOf({ five_hour: { used_percentage: 150, resets_at: 9 } }), { five_hour: { usedPercent: 100, resetsAt: 9 } });
});

test("readings are keyed by the Claude config folder", async () => {
  const box = await hookBox();
  await statusline(box, { rate_limits: limits() });
  await statusline(box, { rate_limits: limits() }, { CLAUDE_CONFIG_DIR: " ~/.claude-work " });
  await statusline(box, { rate_limits: limits() }, { CLAUDE_CONFIG_DIR: join(box.state, ".claude-work") });
  assert.equal(usageFiles(box.state).length, 2, "~ and the absolute spelling share one file");
  const work = join(box.state, ".claude-work");
  assert.equal(claudeConfigFolder({ CLAUDE_CONFIG_DIR: " ~/.claude-work " }, box.state), work);
  assert.ok(usageFiles(box.state).includes(`claude-${usageKey(work)}.json`));
  assert.match(usageKey(work), /^claude-work-[0-9a-f]{8}$/u);
});

/** A home with a default Claude profile, a work profile, a plugin folder and two Codex homes. */
function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), "relo-usage-home-"));
  const account = { oauthAccount: { emailAddress: "a@example.test", userRateLimitTier: "default_claude_max_5x" } };
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude.json"), JSON.stringify(account));
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "relo statusline" } }));
  mkdirSync(join(home, ".claude-work"));
  writeFileSync(join(home, ".claude-work", ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "w@example.test", organizationType: "claude_team" } }));
  mkdirSync(join(home, ".claude-mem", "cache"), { recursive: true });
  mkdirSync(join(home, ".claude-bare", "projects"), { recursive: true });
  return home;
}
const idToken = (email) => `h.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.s`;
function addCodex(home, name, { email, lines, zst }) {
  const folder = join(home, name);
  const day = join(folder, "sessions", "2026", "10", "26");
  mkdirSync(day, { recursive: true });
  writeFileSync(join(folder, "auth.json"), JSON.stringify({ tokens: { id_token: idToken(email), access_token: "SECRET" } }));
  const body = lines.join("\n");
  if (zst) writeFileSync(join(day, "rollout-b.jsonl.zst"), zlib.zstdCompressSync(Buffer.from(body)));
  else writeFileSync(join(day, "rollout-a.jsonl"), body);
}
const event = (rate_limits) => JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits } });
const run = async (home, env = {}) => {
  const box = await hookBox();
  const out = await cli(["usage", "--json"], { ...box.deps(), home, now: () => Date.now(), env: { RELO_STATE_DIR: box.state, ...env } });
  return { box, out, accounts: out.line.accounts };
};

test("usage lists Claude profiles that look real, with email, plan, status line and recorded windows", async () => {
  const home = fakeHome();
  const { box, accounts, out } = await run(home);
  assert.equal(out.exitCode, 0);
  assert.deepEqual(accounts.map((account) => account.id), ["claude", "claude-bare", "claude-work"]);
  const [main, , work] = accounts;
  assert.equal(main.email, "a@example.test");
  assert.equal(main.planName, "Max 5x");
  assert.equal(main.connected, true);
  assert.equal(main.hint, null);
  assert.equal(work.email, "w@example.test");
  assert.equal(work.planName, "Team");
  assert.equal(work.profile, "work");
  assert.equal(work.connected, false);
  assert.equal(work.hint, `CLAUDE_CONFIG_DIR=${join(home, ".claude-work")} relo setup --level optimize --statusline on`);
  assert.deepEqual(main.windows, []);
  // a recording appears, and an expired window is dropped
  const dir = join(box.state, "usage");
  mkdirSync(dir, { recursive: true });
  const now = Math.floor(Date.now() / 1000);
  writeFileSync(claudeUsagePath(box.state, join(home, ".claude")), JSON.stringify({ readAt: 5, windows: {
    five_hour: { usedPercent: 73, resetsAt: now + 600 }, seven_day: { usedPercent: 90, resetsAt: now - 10 } } }));
  const again = await cli(["usage", "--json"], { ...box.deps(), home, now: () => Date.now(), env: { RELO_STATE_DIR: box.state } });
  assert.deepEqual(again.line.accounts[0].windows, [{ kind: "five_hour", minutes: 300, label: "5-hour", usedPercent: 73, resetsAt: now + 600 }]);
  assert.equal(again.line.accounts[0].readAt, 5);
});

test("usage reads Codex limits from the newest rollout, plain or zstd, and drops expired windows", async () => {
  const home = fakeHome();
  const future = Math.floor(Date.now() / 1000) + 3600;
  addCodex(home, ".codex", { email: "c@example.test", lines: ["{}", event({ primary: { used_percent: 1, window_minutes: 300, resets_at: future }, secondary: null, plan_type: "plus" }),
    event({ limit_id: "codex", primary: { used_percent: 98, window_minutes: 10_080, resets_at: future }, secondary: { used_percent: 5, window_minutes: 300, resets_at: 5 }, plan_type: "pro" }), "{cut"] });
  addCodex(home, ".codex-two", { email: "d@example.test", zst: true, lines: [event({ primary: { used_percent: 20.5, window_minutes: 300, resets_at: future }, secondary: { used_percent: 3, window_minutes: 10_080, resets_at: future + 1 }, plan_type: "plus" })] });
  const { accounts } = await run(home);
  const codex = accounts.filter((account) => account.plan === "codex");
  assert.deepEqual(codex.map((account) => account.id), ["codex", "codex-two"]);
  assert.equal(codex[0].email, "c@example.test");
  assert.equal(codex[0].planName, "pro");
  assert.deepEqual(codex[0].windows, [{ kind: "primary", minutes: 10_080, label: "Week", usedPercent: 98, resetsAt: future }], "last line wins; the expired secondary is dropped");
  assert.deepEqual(codex[1].windows.map((window) => [window.kind, window.minutes, window.usedPercent]), [["primary", 300, 20.5], ["secondary", 10_080, 3]]);
  assert.equal(JSON.stringify(accounts).includes("SECRET"), false, "no token leaves");
  assert.deepEqual(Object.keys(codex[0]).sort(), ["configDir", "connected", "displayName", "email", "hint", "id", "plan", "planName", "profile", "readAt", "source", "windows"]);
});

test("usage with nothing on the computer lists no accounts and exits 0; helpers are defensive", async () => {
  const { out, accounts } = await run(mkdtempSync(join(tmpdir(), "relo-usage-empty-")));
  assert.equal(out.exitCode, 0);
  assert.deepEqual(accounts, []);
  assert.equal(emailOfIdToken("garbage"), null);
  assert.equal(lastRateLimits("no limits here"), undefined);
  assert.equal(planLabel({}), null);
  assert.equal(planLabel({ organizationRateLimitTier: "default_claude_max_20x" }), "Max 20x");
});
