import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { ReloApiClient } from "../src/shared/api-client.mjs";
import { detectCaller } from "../src/caller.mjs";
import { ApiError, EXIT } from "../src/shared/errors.mjs";
import { run } from "../src/cli.mjs";

const IDENTITY = ["--topic", "Release 0.7.57"];

/** Every way to reach the network or the disk throws: a dry run must touch none of them. */
function offline(extra = {}) {
  const calls = [];
  const refuse = (what) => () => { calls.push(what); throw new Error(`${what} must not run in a dry run`); };
  return { calls, deps: {
    loadConfig: refuse("loadConfig"),
    clientFactory: refuse("clientFactory"),
    fetchImpl: refuse("fetch"),
    captureActivityCommand: refuse("captureActivityCommand"),
    prepareNotificationCommand: refuse("prepareNotificationCommand"),
    identityDefaults: () => ({ providerName: "Claude Code", project: "relo" }),
    readStdinJson: async () => ({}),
    readTextFile: async () => "callback-token-0123456789",
    env: {},
    sleep: async () => {},
    generateIdempotencyKey: () => "fixed-key",
    ...extra,
  } };
}

async function cli(argv, dependencies) {
  const stdout = [];
  const exitCode = await run(argv, { stdout: (line) => stdout.push(line), stderr: () => {}, stdoutIsTTY: false }, dependencies);
  return { exitCode, line: stdout[0] ? JSON.parse(stdout[0]) : undefined };
}

test("activity end --dry-run prints the body with no login and no request", async () => {
  const box = offline();
  const end = await cli(["activity", "end", "--status", "Live on production", "--name", "deploy-card", "--dry-run"], box.deps);
  assert.equal(end.line.would.command, "activity end");
  assert.equal(end.line.would.body.status, "Live on production");
  assert.equal(end.line.would.body.symbol, "success");
  assert.deepEqual(box.calls, []);
});

test("ask --dry-run validates the question and never prints the callback token", async () => {
  const box = offline();
  const out = await cli(["ask", "Deploy 0.7.57 to production?", "--approval", ...IDENTITY, "--callback-url", "https://hooks.example.com/answer",
    "--callback-token-file", "token.txt", "--dry-run"], box.deps);
  assert.equal(out.exitCode, EXIT.OK);
  assert.equal(out.line.would.command, "ask");
  assert.equal(out.line.would.body.type, "approval");
  assert.equal(out.line.would.body.prompt, "Deploy 0.7.57 to production?");
  assert.deepEqual(out.line.would.body.callback, { url: "https://hooks.example.com/answer" });
  assert.equal(JSON.stringify(out.line).includes("callback-token-0123456789"), false);
  assert.equal((await cli(["ask", "Deploy?", ...IDENTITY, "--dry-run"], box.deps)).exitCode, EXIT.USAGE, "an answer type is required");
  assert.equal((await cli(["ask", "Q".repeat(300), "--yes-no", ...IDENTITY, "--dry-run"], box.deps)).exitCode, EXIT.USAGE, "questions are never shortened");
  const session = await cli(["ask", "Deploy?", "--yes-no", "--dry-run"], { ...box.deps, env: { RELO_SESSION: "s-1" } });
  assert.equal(session.exitCode, EXIT.OK);
  assert.match(session.line.note, /read from the session's card/u);
  // Commands act on the typed caller they are given, not on harness variables of their own.
  const typed = await cli(["ask", "Deploy?", "--yes-no", "--dry-run"], { ...box.deps, env: {}, caller: detectCaller({ CLAUDE_CODE_SESSION_ID: "c-1" }) });
  assert.equal(typed.exitCode, EXIT.OK, "an agent session needs no --topic");
  const nested = await cli(["ask", "Deploy?", "--yes-no", "--dry-run"], { ...box.deps,
    env: { CLAUDE_CODE_SESSION_ID: "c-1", CODEX_THREAD_ID: "t-1" } });
  assert.equal(nested.exitCode, EXIT.USAGE, "an unidentified caller has no session card to read the topic from");
  assert.deepEqual(box.calls, []);
});

test("notify --dry-run validates the notification and sends nothing", async () => {
  const box = offline();
  const out = await cli(["notify", "0.7.57 is live", "--title", "Deployed", ...IDENTITY, "--dry-run"], box.deps);
  assert.equal(out.exitCode, EXIT.OK);
  assert.equal(out.line.would.command, "notify send");
  assert.equal(out.line.would.body.body, "0.7.57 is live");
  assert.equal(out.line.would.body.title, "Deployed");
  assert.equal(out.line.would.body.context.threadName, "Release 0.7.57");
  assert.equal((await cli(["notify", "--dry-run", ...IDENTITY], box.deps)).exitCode, EXIT.USAGE, "a body is required");
  assert.equal((await cli(["notify", "Hi", "--url", "http://insecure.example", ...IDENTITY, "--dry-run"], box.deps)).exitCode, EXIT.USAGE);
  const session = await cli(["notify", "Done", "--dry-run"], { ...box.deps, env: { RELO_SESSION: "s-1" } });
  assert.equal(session.exitCode, EXIT.OK);
  assert.deepEqual(box.calls, []);
});

test("--dry-run exists only where it can be honored", async () => {
  const box = offline({ loadConfig: async () => ({ apiUrl: "https://relo.example", token: "x".repeat(44) }),
    clientFactory: () => new Proxy({}, { get: () => async () => { throw new Error("no request expected"); } }) });
  for (const argv of [["notify", "withdraw", "ntf_x", "--dry-run"], ["activity", "status", "--dry-run"], ["activity", "list", "--dry-run"],
    ["interaction", "get", "int_x", "--dry-run"], ["sessions", "--dry-run"]]) {
    const out = await cli(argv, box.deps);
    assert.equal(out.exitCode, EXIT.USAGE, argv.join(" "));
    assert.match(out.line.error.message, /--dry-run is not valid/u);
  }
});

// ---- automatic retry on 429 ------------------------------------------------------------------------

function limited(responses) {
  const state = { requests: [], sleeps: [] };
  const client = new ReloApiClient({ apiUrl: "https://relo.example", token: "x".repeat(44),
    sleep: async (milliseconds) => { state.sleeps.push(milliseconds); },
    fetchImpl: async (url, init) => {
      state.requests.push({ url: String(url), key: init.headers["idempotency-key"] });
      const next = responses.shift();
      return next === "ok" ? Response.json({ ok: true }) : Response.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": String(next) } });
    } });
  return { state, client };
}

test("a write that gets a short 429 is retried once, after the wait, with the same idempotency key", async () => {
  const { state, client } = limited([4, "ok"]);
  assert.deepEqual(await client.sendNotification({ body: "x" }, "key-1"), { ok: true });
  assert.deepEqual(state.sleeps, [4_000]);
  assert.deepEqual(state.requests.map((request) => request.key), ["key-1", "key-1"]);
});

test("no retry for a long wait, a second 429, a request without an idempotency key, or a long-poll wait", async () => {
  const long = limited([11, "ok"]);
  await assert.rejects(long.client.sendNotification({ body: "x" }, "key-1"), (error) => error instanceof ApiError && error.status === 429 && error.details.retryAfterSeconds === 11);
  assert.equal(long.state.requests.length, 1);
  const twice = limited([1, 1, "ok"]);
  await assert.rejects(twice.client.sendNotification({ body: "x" }, "key-1"), (error) => error.status === 429);
  assert.equal(twice.state.requests.length, 2, "once, not forever");
  const bare = limited([1, "ok"]);
  await assert.rejects(bare.client.getActivity("act_1"), (error) => error.status === 429);
  assert.equal(bare.state.requests.length, 1);
  const waiting = limited([1, "ok"]);
  await assert.rejects(waiting.client.waitForInteraction("int_1", 30), (error) => error.status === 429);
  assert.equal(waiting.state.requests.length, 1);
  const boundary = limited([10, "ok"]);
  await boundary.client.endActivity("act_1", { status: "x" }, "k");
  assert.deepEqual(boundary.state.sleeps, [10_000]);
});

test("the CLI wires the client's retry sleep to its own clock", async () => {
  const slept = [];
  let count = 0;
  const out = await cli(["notify", "Done", "--title", "T", ...IDENTITY], {
    loadConfig: async () => ({ apiUrl: "https://relo.example", token: "x".repeat(44) }),
    identityDefaults: () => ({ providerName: "Claude Code", project: "relo" }),
    prepareNotificationCommand: async ({ body }) => body,
    readStdinJson: async () => ({}),
    env: {},
    sleep: async (milliseconds) => { slept.push(milliseconds); },
    fetchImpl: async (url) => (/\/api\/(clients|devices)\//.test(String(url))
      ? Response.json({ error: "not_found" }, { status: 404 })
      : count++ === 0
        ? Response.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": "2" } })
        : Response.json({ eventId: "ntf_1", delivery: { eligibleDevices: 1, durableCommands: 1, apnsJobs: 1 } })),
  });
  assert.equal(out.exitCode, EXIT.OK);
  assert.deepEqual(slept, [2_000]);
  assert.equal(out.line.id, "ntf_1");
});
