import "./hermetic-env.mjs";
import { loginKeyStoreEnv } from "./cli-fixtures.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "../src/shared/errors.mjs";
import { execute, run } from "../src/cli.mjs";
import { detectAccount } from "../src/shared/identity.mjs";
import { detectComputerName } from "../src/shared/computer.mjs";
import { cardDependencies, fakeCards } from "./fake-cards.mjs";

const HOME = "/Users/test";
const darwin = { platform: "darwin", home: HOME };

test("the computer name comes from RELO_COMPUTER, then scutil, then the hostname without its domain", () => {
  assert.equal(detectComputerName({ RELO_COMPUTER: "  Build box " }, { ...darwin, scutil: () => "ignored" }), "Build box");
  assert.equal(detectComputerName({}, { ...darwin, scutil: () => "Studio MacBook Pro\n" }), "Studio MacBook Pro");
  assert.equal(detectComputerName({}, { ...darwin, scutil: () => { throw new Error("no scutil"); }, hostname: () => "mac-mini.local" }), "mac-mini");
  assert.equal(detectComputerName({}, { ...darwin, scutil: () => "  ", hostname: () => "box.example.com" }), "box");
  assert.equal(detectComputerName({}, { platform: "linux", scutil: () => assert.fail("macOS only"), hostname: () => "ci-7.internal" }), "ci-7");
  assert.equal(detectComputerName({ RELO_COMPUTER: "x".repeat(300) }, darwin).length, 120);
  assert.equal(detectComputerName({}, { platform: "linux", hostname: () => { throw new Error("none"); } }), undefined);
});

test("the account is RELO_ACCOUNT, a stored nickname, or the name of a custom agent config folder", () => {
  const claude = { CLAUDECODE: "1" };
  assert.deepEqual(detectAccount({ ...claude, RELO_ACCOUNT: "work" }, { home: HOME }).account, "work");
  assert.equal(detectAccount(claude, { home: HOME }).account, undefined);
  assert.equal(detectAccount(claude, { home: HOME }).configDirectory, `${HOME}/.claude`);
  assert.equal(detectAccount(claude, { home: HOME, accounts: () => ({ [`${HOME}/.claude`]: "personal" }) }).account, "personal");
  for (const [directory, expected] of [
    [`${HOME}/.claude-work`, "work"], [`${HOME}/.claude_side`, "side"], [`${HOME}/accounts/acme`, "acme"],
    [`${HOME}/other/.claude`, undefined], [`${HOME}/x/claude`, undefined],
  ]) assert.equal(detectAccount({ ...claude, CLAUDE_CONFIG_DIR: directory }, { home: HOME }).account, expected, directory);
  assert.equal(detectAccount({ CODEX_THREAD_ID: "t", CODEX_HOME: `${HOME}/.codex-lab` }, { home: HOME }).account, "lab");
  // A nickname beats the folder name; another agent's variable is ignored; no agent, no account.
  assert.equal(detectAccount({ ...claude, CLAUDE_CONFIG_DIR: `${HOME}/.claude-work` },
    { home: HOME, accounts: () => ({ [`${HOME}/.claude-work`]: "Acme" }) }).account, "Acme");
  assert.equal(detectAccount({ ...claude, CODEX_HOME: `${HOME}/.codex-lab` }, { home: HOME }).account, undefined);
  assert.equal(detectAccount({ CLAUDE_CONFIG_DIR: `${HOME}/.claude-work` }, { home: HOME }).account, undefined);
});

test("notices carry the computer and account; flags override", async () => {
  const sent = [];
  const { client } = fakeCards();
  client.sendNotification = async (body) => { sent.push(body); return { eventId: "ntf_1", delivery: { eligibleDevices: 1, durableCommands: 1, apnsJobs: 1 } }; };
  const deps = { ...cardDependencies(client), originDefaults: () => ({ computer: "Studio", account: "work" }) };
  await execute(["notify", "Export finished", "--topic", "Nightly release"], deps);
  assert.deepEqual([sent[0].context.computer, sent[0].context.account], ["Studio", "work"]);
  await execute(["notify", "Export finished", "--topic", "Nightly release", "--computer", "Laptop", "--account", "  home "], deps);
  assert.deepEqual([sent[1].context.computer, sent[1].context.account], ["Laptop", "home"]);
  await assert.rejects(execute(["notify", "Export finished", "--topic", "Nightly release", "--account", "x".repeat(41)], deps), /at most 40/);
  // Without any account, the field is simply absent.
  await execute(["notify", "Export finished", "--topic", "Nightly release"], { ...cardDependencies(client), originDefaults: () => ({ computer: "Studio" }) });
  assert.equal("account" in sent[2].context, false);
});

function accountDeps(initial = {}) {
  const state = { accounts: initial, written: [] };
  return { state, deps: {
    env: { CLAUDECODE: "1", CLAUDE_CONFIG_DIR: `${HOME}/.claude-work` }, home: HOME, configPath: () => "/cfg/config.json",
    loadAccounts: () => state.accounts,
    loadStoredConfig: async () => ({ apiUrl: "https://relo.example", token: "x".repeat(44), accounts: state.accounts, revision: "r1", path: "/cfg/config.json" }),
    writeConfig: async (path, config, options) => { state.written.push({ path, config, options }); state.accounts = config.accounts; },
  } };
}

test("relo account shows, stores and clears the nickname for this agent config directory", async () => {
  const { state, deps } = accountDeps();
  const shown = await execute(["account"], deps);
  assert.deepEqual(shown.data, { account: "work", via: "directory", agent: "Claude Code", configDir: `${HOME}/.claude-work` });
  const saved = await execute(["account", "Acme"], deps);
  assert.equal(saved.data.account, "Acme");
  assert.equal(saved.data.saved, true);
  assert.deepEqual(state.written[0].config.accounts, { [`${HOME}/.claude-work`]: "Acme" });
  assert.equal(state.written[0].options.expectedRevision, "r1");
  const cleared = await execute(["account", "--clear"], deps);
  assert.equal(cleared.data.account, "work");
  assert.equal(cleared.data.cleared, true);
  assert.deepEqual(state.written[1].config.accounts, {});
  await assert.rejects(execute(["account", "A", "--clear"], deps), /Usage: relo account/);
  await assert.rejects(execute(["account", "x".repeat(41)], deps), /at most 40/);
  await assert.rejects(execute(["account", "Acme"], { ...deps, env: {} }), /No agent harness detected/);
});

test("login names the credential after this computer unless told otherwise", async () => {
  const names = [];
  const deps = (extra) => ({
    env: { RELO_API_URL: "http://192.168.1.10:8180", ...loginKeyStoreEnv() }, configPath: () => "/cfg/c.json", configRevision: async () => null,
    clientFactory: () => ({ startDeviceAuthorization: async (body) => { names.push(body.clientName); throw new ApiError("stop", { status: 500 }); } }),
    ...extra,
  });
  await assert.rejects(execute(["auth", "login", "--no-open"], deps({ computerName: () => "Studio" })));
  await assert.rejects(execute(["auth", "login", "--no-open"], deps({ computerName: () => undefined })));
  await assert.rejects(execute(["auth", "login", "--no-open", "--client-name", "Mine"], deps({ computerName: () => "Studio" })));
  assert.deepEqual(names, ["Studio", "Relo CLI", "Mine"]);
});

async function cli(argv, dependencies, io = {}) {
  const stdout = [];
  const stderr = [];
  const exitCode = await run(argv, { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line), stdoutIsTTY: false, ...io }, dependencies);
  return { exitCode, stdout, stderr };
}

test("ask, interaction and notify print compact lines", async () => {
  const { client } = fakeCards({ answer: "approved" });
  const deps = { ...cardDependencies(client, { env: { CLAUDE_CODE_SESSION_ID: "s2" } }),
    sendNotification: undefined };
  const asked = JSON.parse((await cli(["ask", "Go?", "--approval", "--topic", "T"], deps)).stdout[0]);
  // No card is running in this session, so the question went out as a notification with buttons.
  assert.deepEqual({ ...asked, id: undefined, note: undefined }, { ok: true, id: undefined, state: "approved", fallback: "notification", note: undefined });
  assert.match(asked.note, /no card is running/iu);
  assert.match(asked.id, /^int_/u);
  const notified = JSON.parse((await cli(["notify", "Done", "--topic", "T"], {
    ...deps, clientFactory: () => ({ sendNotification: async () => ({ eventId: "ntf_1", delivery: { eligibleDevices: 2, durableCommands: 2, apnsJobs: 2 }, queued: 2, replayed: false }) }),
  })).stdout[0]);
  assert.deepEqual(notified, { ok: true, id: "ntf_1", devices: 2 });
});

test("rate limits and missing cards read plainly", async () => {
  const limited = await cli(["activity", "get", "x"], cardDependencies({
    getActivity: async () => { throw new ApiError("rate_limited", { status: 429, code: "RATE_LIMITED", details: { retryAfterSeconds: 12 } }); },
  }));
  const { error } = JSON.parse(limited.stdout[0]);
  assert.match(error.message, /Too many/u);
  assert.match(error.hint, /Wait 12s/u);
  const missing = JSON.parse((await cli(["activity", "get", "x"], cardDependencies({
    getActivity: async () => { throw new ApiError("not_found", { status: 404, code: "NOT_FOUND" }); },
  }))).stdout[0]);
  assert.equal(missing.error.message, "No such card.");
});

