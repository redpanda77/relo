import "./hermetic-env.mjs";
// The machine report (plan 11 phase 4): built from what is installed here, stripped of every name, path and
// variable value, sent only when it changed, and never from a hook.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDependencies } from "../src/deps.mjs";
import { execute } from "../src/cli.mjs";
import { buildReport, machineKind, recordDoctor, reportHash, sendReportIfChanged } from "../src/owner/machine-report.mjs";
import { COMPUTER_ICONS } from "../src/shared/computers.generated.mjs";
import { FACTS } from "../src/shared/facts.generated.mjs";
import { VERSION } from "../src/version.mjs";
import { fakeHome } from "./fake-cards.mjs";

const contractsUrl = new URL("../../contracts/dist/src/computers.js", import.meta.url);
const HOUR = 3600_000;

/** A throwaway computer: a home with Claude Code and Codex folders, its own state folder, and a client that records PUTs. */
async function computer(extra = {}) {
  const home = await fakeHome();
  const cwd = await mkdtemp(join(tmpdir(), "relo-report-cwd-"));
  const state = join(home, "state");
  await mkdir(state, { recursive: true });
  const sent = [];
  const control = { failing: Boolean(extra.failing) };
  let clock = Date.UTC(2026, 9, 16, 9, 0, 0);
  const env = { RELO_STATE_DIR: state, ...extra.env };
  const stored = { apiUrl: "https://relo.example.test", activeProfile: "default", profiles: ["default", "work"], computerName: "Studio Mac" };
  const dependencies = createDependencies({
    env, home, cwd, version: VERSION, now: () => clock,
    configPath: () => join(home, "config.json"),
    loadConfig: async () => ({ apiUrl: stored.apiUrl, token: "x".repeat(44), source: "config" }),
    loadStoredConfig: async () => stored,
    computerName: () => "Studio Mac",
    clientFactory: () => ({ putComputerReport: async (report, key) => {
      if (control.failing) throw new Error("offline");
      sent.push({ report, key });
    } }),
    sendMachineReport: async () => ({ sent: false }),
    nodePath: "/usr/bin/node", entrypoint: join(home, "relo.mjs"),
    ...extra.overrides,
  });
  const probes = { platform: "darwin", hwModel: () => "MacBookPro18,3", release: () => "25.0.0" };
  return { home, cwd, dependencies, sent, probes, control, advance: (ms) => { clock += ms; }, cleanup: () => Promise.all([rm(home, { recursive: true, force: true }), rm(cwd, { recursive: true, force: true })]) };
}

test("the report describes what setup installed per tool, and a tool that is here but empty", async () => {
  const box = await computer();
  await execute(["setup", "--level", "guide"], box.dependencies);
  const report = await buildReport(box.dependencies, box.probes);
  const claude = report.harnesses.find((harness) => harness.id === "claude-code");
  assert.deepEqual(claude, { id: "claude-code", detected: true, instructions: "set", skill: "current", level: "guide", modules: ["reporting", "planning", "continuity"], hooks: "presence", hooksOutdated: false, mcp: "none" });
  const codex = report.harnesses.find((harness) => harness.id === "codex");
  assert.equal(codex.detected, true);
  assert.equal(codex.instructions, "set");
  assert.equal(codex.hooks, "off");
  assert.deepEqual([codex.level, codex.modules], ["guide", ["reporting", "planning", "continuity"]]);
  const cursor = report.harnesses.find((harness) => harness.id === "cursor");
  assert.equal(cursor?.detected ?? false, false);
  assert.deepEqual(report.cli, { version: VERSION, latest: null, update: "unknown" });
  assert.deepEqual(report.os, { platform: "darwin", release: "25.0.0" });
  assert.equal(report.machineKind, "laptop");
  assert.deepEqual(report.profiles, { count: 2, active: "default" });
  assert.equal(report.doctor, null);
  assert.deepEqual(report.outbox, { pending: 0 });
  await box.cleanup();
});

test("a stale block and hook entries from an older Relo show as stale and outdated", async () => {
  const home = await fakeHome({ block: "stale" });
  const box = await computer({ overrides: { home } });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(home, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "relo hook old-thing --agent claude-code" }] }] } }));
  const report = await buildReport(box.dependencies, box.probes);
  const claude = report.harnesses.find((harness) => harness.id === "claude-code");
  assert.equal(claude.instructions, "stale");
  assert.equal(claude.hooks, "legacy");
  assert.equal(claude.hooksOutdated, true);
  await box.cleanup();
  await rm(home, { recursive: true, force: true });
});

test("the report validates against the contract's schema and its size cap", { skip: !existsSync(contractsUrl) && "build @relo/notification-contracts first" }, async () => {
  const { computerReportSchema } = await import(contractsUrl.href);
  const box = await computer({ env: { RELO_COMPUTER: "Env Mac", RELO_NO_UPDATE_CHECK: "1" } });
  await execute(["setup", "--level", "guide"], box.dependencies);
  await recordDoctor(box.dependencies, { server: { ok: true }, auth: { ok: false, state: "rejected" }, runtime: { ok: false, state: "skipped" } });
  const report = await buildReport(box.dependencies, box.probes);
  assert.equal(computerReportSchema.safeParse(report).success, true, JSON.stringify(computerReportSchema.safeParse(report).error?.issues));
  assert.ok(JSON.stringify(report).length < FACTS.computers.reportMaxBytes);
  assert.deepEqual(report.doctor.failing, ["auth"], "a skipped check is not a failure");
  assert.equal(report.doctor.ok, false);
  await box.cleanup();
});

test("no environment variable value, path or name-setting value is in the report", async () => {
  const secrets = {
    RELO_PROJECT: "Quarterly-Layoffs-Plan", RELO_TOPIC: "Acquire-Rival-Corp", RELO_ACCOUNT: "personal-secret-acct",
    RELO_COMPUTER: "Dad-Laptop-Name", RELO_SOURCE: "Secret Harness", RELO_API_URL: "https://secret-host.internal.example",
    RELO_PROFILE: "profile-secret-name", RELO_CONFIG_PATH: "/Users/someone/secret-config-dir/config.json",
    AWS_SECRET_ACCESS_KEY: "AKIA-not-a-real-secret-0123456789", RELO_TOKEN: "relo_not_a_real_token_value_0123456789012345",
  };
  const box = await computer({ env: secrets });
  const report = await buildReport(box.dependencies, box.probes);
  const text = JSON.stringify(report);
  for (const [name, value] of Object.entries(secrets)) {
    assert.ok(!text.includes(value), `${name}'s value is in the report`);
  }
  for (const piece of ["secret-host", "secret-config-dir", "profile-secret-name", "Quarterly", "Layoffs", "Acquire-Rival"]) {
    assert.ok(!text.includes(piece), `${piece} is in the report`);
  }
  assert.ok(!text.includes("Studio Mac"), "a computer name is in the report");
  assert.ok(!text.includes(box.home), "the home folder path is in the report");
  assert.ok(!text.includes(box.cwd), "the working folder path is in the report");
  for (const key of ["computer", "project", "topic", "account", "source", "stateDir", "configPath"]) {
    const row = report.settings.find((setting) => setting.key === key);
    assert.ok(row, key);
    assert.equal(row.value, undefined, `${key} carries a value`);
  }
  const server = report.settings.find((setting) => setting.key === "server");
  assert.equal(server.source, "env");
  assert.equal(server.value, undefined, "a value a variable set never travels");
  assert.equal(server.env, "RELO_API_URL", "its name does");
  await box.cleanup();
});

test("a value from the config file or the default travels when the setting is neither a name nor a path", async () => {
  const box = await computer();
  const report = await buildReport(box.dependencies, box.probes);
  const value = (key) => report.settings.find((setting) => setting.key === key);
  assert.deepEqual(value("server"), { key: "server", source: "config", env: "RELO_API_URL", value: "https://relo.example.test" });
  assert.deepEqual(value("updateCheck"), { key: "updateCheck", source: "default", env: "RELO_NO_UPDATE_CHECK", value: "on" });
  const optedOut = await computer({ env: { RELO_NO_UPDATE_CHECK: "yes please" } });
  const row = (await buildReport(optedOut.dependencies, optedOut.probes)).settings.find((setting) => setting.key === "updateCheck");
  assert.deepEqual(row, { key: "updateCheck", source: "env", env: "RELO_NO_UPDATE_CHECK", value: "off" }, "on/off is not the variable's text");
  await optedOut.cleanup();
  assert.equal(value("computer").value, undefined);
  await box.cleanup();
});

test("it sends when something changed, not when nothing did, and again after a day", async () => {
  const box = await computer();
  assert.deepEqual(await sendReportIfChanged(box.dependencies, { probes: box.probes }), { sent: true, reason: "changed" });
  assert.equal(box.sent.length, 1);
  assert.equal(box.sent[0].key, reportHash(box.sent[0].report), "the idempotency key is the report's hash");
  assert.deepEqual(await sendReportIfChanged(box.dependencies, { probes: box.probes }), { sent: false, reason: "unchanged" });
  assert.equal(box.sent.length, 1);

  await recordDoctor(box.dependencies, { server: { ok: true } });
  assert.equal((await sendReportIfChanged(box.dependencies, { probes: box.probes })).sent, true, "a new doctor result changes the report");
  assert.equal(box.sent.length, 2);
  assert.equal(box.sent[1].report.doctor.ok, true);

  box.advance(23 * HOUR);
  assert.equal((await sendReportIfChanged(box.dependencies, { probes: box.probes })).sent, false);
  box.advance(2 * HOUR);
  assert.equal((await sendReportIfChanged(box.dependencies, { probes: box.probes })).sent, true, "older than a day: sent again");
  assert.equal(box.sent.length, 3);
  await box.cleanup();
});

test("the hash ignores key order; any change moves it", () => {
  assert.equal(reportHash({ a: 1, b: { c: 2, d: [1, { y: 1, x: 2 }] } }), reportHash({ b: { d: [1, { x: 2, y: 1 }], c: 2 }, a: 1 }));
  assert.notEqual(reportHash({ a: 1 }), reportHash({ a: 2 }));
});

test("a failed send is not remembered as sent: the same report goes out once the server answers; it never throws", async () => {
  const box = await computer({ failing: true });
  assert.deepEqual(await sendReportIfChanged(box.dependencies, { probes: box.probes }), { sent: false, reason: "failed" });
  assert.equal(box.sent.length, 0);
  box.control.failing = false;
  assert.deepEqual(await sendReportIfChanged(box.dependencies, { probes: box.probes }), { sent: true, reason: "changed" });
  const broken = await computer({ overrides: { loadConfig: async () => { throw new Error("not signed in") } } });
  assert.deepEqual(await sendReportIfChanged(broken.dependencies, { probes: broken.probes }), { sent: false, reason: "failed" });
  await Promise.all([box.cleanup(), broken.cleanup()]);
});

test("the flusher's asks are throttled to one look every 10 minutes; a command's are not", async () => {
  const box = await computer();
  assert.equal((await sendReportIfChanged(box.dependencies, { background: true, probes: box.probes })).sent, true);
  await recordDoctor(box.dependencies, { server: { ok: true } });
  box.advance(5 * 60_000);
  assert.deepEqual(await sendReportIfChanged(box.dependencies, { background: true, probes: box.probes }), { sent: false, reason: "recent" });
  assert.equal((await sendReportIfChanged(box.dependencies, { probes: box.probes })).sent, true, "a command is never throttled");
  await recordDoctor(box.dependencies, { server: { ok: false } });
  box.advance(11 * 60_000);
  assert.equal((await sendReportIfChanged(box.dependencies, { background: true, probes: box.probes })).sent, true);
  await box.cleanup();
});

test("an environment credential (CI) has no computer and sends nothing", async () => {
  const box = await computer({ overrides: { loadConfig: async () => ({ apiUrl: "https://relo.example.test", token: "t".repeat(44), source: "environment" }) } });
  assert.deepEqual(await sendReportIfChanged(box.dependencies, { probes: box.probes }), { sent: false, reason: "no-computer" });
  assert.equal(box.sent.length, 0);
  await box.cleanup();
});

test("the machine-kind hint: CI builds, MacBooks are laptops, newer Mac names ask the battery, Linux with no display serves", () => {
  const mac = (hwModel, battery = () => "") => machineKind({}, { platform: "darwin", hwModel: () => hwModel, battery });
  assert.equal(machineKind({ CI: "true" }, { platform: "darwin", hwModel: () => "MacBookPro18,3" }), "build");
  assert.equal(mac("MacBookAir10,1"), "laptop");
  assert.equal(mac("iMac21,1"), "desktop");
  assert.equal(mac("Macmini9,1"), "desktop");
  assert.equal(mac("Mac14,2", () => "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t96%"), "laptop");
  assert.equal(mac("Mac14,3", () => "Now drawing from 'AC Power'"), "desktop");
  assert.equal(mac(""), null, "an unreadable model says nothing");
  assert.equal(machineKind({}, { platform: "darwin", hwModel: () => { throw new Error("no sysctl"); } }), null);
  assert.equal(machineKind({}, { platform: "linux" }), "server");
  assert.equal(machineKind({ DISPLAY: ":0" }, { platform: "linux" }), null);
  assert.equal(machineKind({ WAYLAND_DISPLAY: "wayland-0" }, { platform: "linux" }), null);
  assert.equal(machineKind({}, { platform: "win32" }), null);
  for (const kind of [machineKind({ CI: "1" }, {}), mac("MacBookPro1,1"), mac("iMac1,1"), machineKind({}, { platform: "linux" })]) assert.ok(COMPUTER_ICONS.includes(kind), String(kind));
});

test("the commands that change this computer's setup ask for a report; a dry run and a bare listing do not", async () => {
  const box = await computer();
  const asked = [];
  const deps = { ...box.dependencies, sendMachineReport: async (options) => { asked.push(options ?? {}); } };
  await execute(["setup", "--level", "guide", "--dry-run"], deps);
  await execute(["uninstall"], deps);
  assert.deepEqual(asked, [], "nothing was written");
  await execute(["setup", "--level", "guide"], deps);
  assert.equal(asked.length, 1);
  await execute(["uninstall", "--apply"], deps);
  assert.equal(asked.length, 2);
  await box.cleanup();
});

test("relo doctor records its result, then asks for a report; relo outbox flush asks in the background", async () => {
  const box = await computer();
  const order = [];
  const deps = {
    ...box.dependencies,
    loadConfig: async () => { throw new Error("not signed in"); },
    recordDoctor: async (checks) => { order.push(["record", Object.keys(checks)]); },
    sendMachineReport: async (options) => { order.push(["send", options ?? {}]); },
  };
  await execute(["doctor"], deps);
  assert.deepEqual(order, [["record", ["localConfig", "server", "auth", "runtime"]], ["send", {}]]);
  order.length = 0;
  await execute(["outbox", "flush"], { ...deps, loadConfig: async () => { throw new Error("not signed in"); } });
  assert.deepEqual(order, [["send", { background: true }]]);
  await box.cleanup();
});

test("a successful sign-in asks for a report; a pending one does not", async () => {
  const { ACCESS_TOKEN, CONFIG, authorizationStart, issuedCredential, loginKeyStoreEnv } = await import("./cli-fixtures.mjs");
  const asked = [];
  const base = {
    env: loginKeyStoreEnv(), configPath: () => CONFIG.path, loadConfig: async () => CONFIG, now: () => 0, sleep: async () => {},
    writeConfig: async () => {}, openBrowser: () => {}, sendMachineReport: async () => { asked.push(true); },
    clientFactory: () => ({ startDeviceAuthorization: async () => authorizationStart({
      verificationUri: `${CONFIG.apiUrl}/cli/authorize`, verificationUriComplete: `${CONFIG.apiUrl}/cli/authorize?code=ABCD-EFGH` }), pollDeviceAuthorization: async () => issuedCredential() }),
  };
  const args = ["auth", "login", "--no-open", "--client-name", "Mac Codex", "--scope", "notifications:send", "--scope", "interactions:create", "--scope", "interactions:read"];
  const signedIn = await execute(args, base);
  assert.equal(signedIn.data.authenticated, true);
  assert.equal(JSON.stringify(signedIn).includes(ACCESS_TOKEN), false);
  assert.equal(asked.length, 1);
  const pending = await execute([...args, "--no-wait"], { ...base, pendingLogin: { read: async () => null, write: async () => {}, clear: async () => {} } });
  assert.notEqual(pending.data.authenticated, true);
  assert.equal(asked.length, 1, "a pending sign-in is not a computer yet");
});
