import assert from "node:assert/strict";
import test from "node:test";
import { EXIT, execute, run } from "../src/cli.mjs";
import { ApiError } from "../src/errors.mjs";
import { detectAccount, detectComputerName } from "../src/identity.mjs";
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

test("cards start with the computer and account; flags override", async () => {
  const { client, calls } = fakeCards();
  const deps = { ...cardDependencies(client), originDefaults: () => ({ computer: "Studio", account: "work" }) };
  await execute(["activity", "start", "--title", "T", "--status", "S", "--topic", "Release"], deps);
  const start = calls.find((call) => call.op === "start");
  assert.equal(start.body.context.computer, "Studio");
  assert.equal(start.body.context.account, "work");
  const second = fakeCards();
  await execute(["activity", "start", "--title", "T", "--status", "S", "--topic", "Release", "--computer", "Laptop", "--account", "  home "],
    { ...cardDependencies(second.client), originDefaults: () => ({ computer: "Studio", account: "work" }) });
  const secondStart = second.calls.find((call) => call.op === "start");
  assert.equal(secondStart.body.context.computer, "Laptop");
  assert.equal(secondStart.body.context.account, "home");
  await assert.rejects(execute(["activity", "start", "--title", "T", "--status", "S", "--topic", "Release", "--account", "x".repeat(41)], deps), /at most 40/);
  // Without any account, the field is simply absent.
  const third = fakeCards();
  await execute(["activity", "start", "--title", "T", "--status", "S", "--topic", "Release"],
    { ...cardDependencies(third.client), originDefaults: () => ({ computer: "Studio" }) });
  assert.equal("account" in third.calls.find((call) => call.op === "start").body.context, false);
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
    env: { RELO_API_URL: "http://192.168.1.10:8180" }, configPath: () => "/cfg/c.json", configRevision: async () => null,
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

test("activity commands print one compact line; --full prints the envelope", async () => {
  const { client } = fakeCards();
  const deps = cardDependencies(client, { env: { CLAUDE_CODE_SESSION_ID: "s1" } });
  const started = await cli(["activity", "start", "--title", "T", "--status", "S", "--topic", "Release", "--steps", "Plan, Build ,Ship"], deps);
  assert.equal(started.stderr.length, 0);
  const line = JSON.parse(started.stdout[0]);
  assert.match(line.id, /^act_/u);
  assert.deepEqual({ ...line, id: undefined }, { ok: true, id: undefined, state: "active", sequence: 0 });
  const updated = await cli(["activity", "update", "--status", "Next", "--progress", "0.4"], deps);
  assert.equal(JSON.parse(updated.stdout[0]).sequence, 1);
  assert.ok(updated.stdout[0].length < 120, updated.stdout[0]);
  const full = JSON.parse((await cli(["activity", "update", "--status", "More", "--full"], deps)).stdout[0]);
  assert.equal(full.command, "activity.update");
  assert.equal(full.data.delivery.durableCommands, 1);
  const again = await cli(["activity", "start", "--title", "T", "--status", "S", "--topic", "Release"], deps);
  assert.equal(again.exitCode, EXIT.OK ?? 0, "a repeat start continues the running card");
  const continued = JSON.parse(again.stdout[0]);
  assert.equal(continued.ok, true);
  assert.equal(continued.disposition, "continuing");
  assert.match(continued.id, /^act_/u);
  assert.match(continued.next, /relo activity update/u);
  const ended = JSON.parse((await cli(["activity", "end", "--status", "Done"], deps)).stdout[0]);
  assert.equal(ended.state, "ended");
});

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

test("an ended card says so in plain English, once, with the next command", async () => {
  const deps = cardDependencies({
    getActivity: async () => ({ activity: { id: "act_1", state: "active", sequence: 2 } }),
    updateActivity: async () => { throw new ApiError("activity_terminal", { status: 409, code: "ACTIVITY_TERMINAL" }); },
  }, { env: { CLAUDE_CODE_SESSION_ID: "s3" } });
  const failed = await cli(["activity", "update", "--status", "x"], deps);
  assert.equal(failed.exitCode, EXIT.API);
  assert.deepEqual(failed.stderr, []);
  const { error } = JSON.parse(failed.stdout[0]);
  assert.equal(error.message, "This card already ended.");
  assert.match(error.hint, /relo activity start --title/u);
  const human = await cli(["activity", "update", "--status", "x"], deps, { stdoutIsTTY: true });
  assert.deepEqual(human.stdout, []);
  assert.match(human.stderr[0], /This card already ended\.\nhint: Start a new one/u);
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

function stepCard({ current = 1, labels = ["Plan", "Build", "Ship"] } = {}) {
  return { id: "act_1", state: "active", sequence: 4, presentation: { components: [{ type: "steps",
    items: labels.map((label, index) => ({ label, state: index + 1 < current ? "complete" : index + 1 === current ? "current" : "pending" })) }] } };
}
function stepDeps(card) {
  const sent = [];
  return { sent, deps: cardDependencies({
    getActivity: async () => ({ activity: card }),
    updateActivity: async (_id, body) => { sent.push(body); return { activity: card, delivery: { eligibleDevices: 1, durableCommands: 1, apnsJobs: 1 } }; },
  }, { env: { CLAUDE_CODE_SESSION_ID: "s4" } }) };
}

test("steps accept a comma list, and the current step by number or name", async () => {
  const { client, calls } = fakeCards();
  const deps = cardDependencies(client, { env: { CLAUDE_CODE_SESSION_ID: "s5" } });
  await execute(["activity", "start", "--title", "T", "--status", "S", "--topic", "X", "--steps", "Plan,Build,Ship", "--step-current", "build"], deps);
  assert.deepEqual(calls.find((call) => call.op === "start").body.steps, { labels: ["Plan", "Build", "Ship"], current: 2 });
  const sent = [];
  const update = (card, args) => {
    const { deps: d } = stepDeps(card);
    return execute(["activity", "update", ...args], { ...d, clientFactory: () => ({ getActivity: async () => ({ activity: card }),
      updateActivity: async (_id, body) => { sent.push(body); return { activity: card, delivery: { eligibleDevices: 1, durableCommands: 1, apnsJobs: 1 } }; } }) });
  };
  await update(stepCard({ current: 1 }), ["--step-current", "SHIP"]);
  assert.deepEqual(sent.at(-1).steps, { labels: ["Plan", "Build", "Ship"], current: 3 });
  await update(stepCard({ current: 1 }), ["--next-step", "--status", "Building"]);
  assert.deepEqual(sent.at(-1).steps, { labels: ["Plan", "Build", "Ship"], current: 2 });
  await update(stepCard({ current: 2 }), ["--next-step"]);
  assert.equal(sent.at(-1).steps.current, 3);
  await assert.rejects(update(stepCard({ current: 3 }), ["--next-step"]), /last step/);
  await assert.rejects(update(stepCard({ current: 1 }), ["--step-current", "0"]), /numbered from 1/);
  await assert.rejects(update(stepCard({ current: 1 }), ["--step-current", "Deploy"]), /not one of the steps/);
  await assert.rejects(update(stepCard({ current: 1 }), ["--step-current", "9"]), /at most 3/);
  await assert.rejects(update(stepCard({ current: 1 }), ["--next-step", "--step-current", "2"]), /cannot be combined/);
  await assert.rejects(update({ id: "act_1", state: "active", sequence: 1 }, ["--next-step"]), /no steps/);
  await assert.rejects(execute(["activity", "start", "--title", "T", "--status", "S", "--topic", "X", "--steps", "A,B", "--step", "C"], deps), /not both/);
  await assert.rejects(execute(["activity", "start", "--title", "T", "--status", "S", "--topic", "X", "--steps", "1,2,3,4,5,6,7,8,9"], deps), /At most 8/);
});
