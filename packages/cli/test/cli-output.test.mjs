import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { EXIT, NetworkError } from "../src/shared/errors.mjs";
import { testContext, execute, run, CONFIG, overrides, TARGET_DEVICE, DELIVERY, CONTRACT_FIXTURE } from "./cli-fixtures.mjs";

test("public CLI help and command routing omit rejected phone pairing", async () => {
  const help = await execute(["help", "all"]);
  assert.equal(help.data.help.includes("pair ios"), false);
  for (const text of [
    "relo notify BODY...",
    "--project NAME",
    "--topic NAME",
    "--name NAME",
    "--limit 1..100",
    "relo ask QUESTION",
    "[--option LABEL]",
    "relo activity end [CARD]",
    "--api-url URL",
    "relo interaction cancel ID",
  ]) assert.equal(help.data.help.includes(text), true, text);
  assert.equal(help.data.help.includes("relo activity start"), false, "relo activity start is gone");
  await assert.rejects(execute(["pair", "ios"], overrides({})), /Unknown command/);
});

test("reports the package version without requiring credentials", async () => {
  const stdout = [];
  assert.equal(await run(["--version"], { stdout: (line) => stdout.push(line) }), EXIT.OK);
  assert.deepEqual(stdout, [JSON.parse(readFileSync(new URL("../package.json",import.meta.url),"utf8")).version]);
});

test("emits exact machine output and usage errors", async () => {
  const successStdout = [];
  const successStderr = [];
  const successExit = await run(
    ["services", "list", "--json"],
    { stdout: (line) => successStdout.push(line), stderr: (line) => successStderr.push(line) },
    overrides({ listServices: async () => ({ services: [] }) }),
  );
  assert.equal(successExit, EXIT.OK);
  assert.deepEqual(successStdout, ['{"ok":true,"services":[]}']);
  assert.deepEqual(successStderr, []);

  const errorStdout = [];
  const errorStderr = [];
  const errorExit = await run(
    ["ask", "Continue?", "--approval", "--no-wait", "--timeout", "1m", "--json"],
    { stdout: (line) => errorStdout.push(line), stderr: (line) => errorStderr.push(line) },
    overrides({}),
  );
  assert.equal(errorExit, EXIT.USAGE);
  assert.deepEqual(errorStdout, [
    '{"ok":false,"error":{"code":"USAGE_ERROR","message":"--timeout cannot be combined with --no-wait"}}',
  ]);
  assert.deepEqual(errorStderr, []);

  // At a terminal a person gets the plain text on stderr and no JSON.
  const ttyStdout = [];
  const ttyStderr = [];
  const ttyExit = await run(
    ["ask", "Continue?", "--approval", "--no-wait", "--timeout", "1m"],
    { stdout: (line) => ttyStdout.push(line), stderr: (line) => ttyStderr.push(line), stdoutIsTTY: true },
    overrides({}),
  );
  assert.equal(ttyExit, EXIT.USAGE);
  assert.deepEqual(ttyStdout, []);
  assert.deepEqual(ttyStderr, ["--timeout cannot be combined with --no-wait"]);
});

test("rejects known options when they do not belong to the selected command", async () => {
  await assert.rejects(execute(["auth", "status", "--title", "Ignored"], overrides({})), /not valid/);
});

test("maps every approval, yes/no, and text terminal state to stable exit codes", async () => {
  const stateCase = async (state, expected) => {
    const stdout = [];
    const stderr = [];
    const exitCode = await run(
      ["interaction", "wait", "int_1", "--json"],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      {
        ...overrides({
          waitForInteraction: async (_id, timeoutSeconds) => {
            now += timeoutSeconds * 1_000;
            return { interaction: { id: "int_1", state } };
          },
        }),
        now: () => now,
      },
    );
    assert.equal(exitCode, expected);
    assert.equal(JSON.parse(stdout[0]).ok, expected === EXIT.OK);
    assert.equal(stderr.length, 0);
  };
  let now = 0;
  await stateCase("approved", EXIT.OK);
  await stateCase("yes", EXIT.OK);
  await stateCase("replied", EXIT.OK);
  await stateCase("denied", EXIT.NEGATIVE);
  await stateCase("no", EXIT.NEGATIVE);
  await stateCase("expired", EXIT.CLOSED);
  await stateCase("canceled", EXIT.CLOSED);
  await stateCase("pending", EXIT.TERMINAL);
});

test("maps usage, transport, and no-delivery failures to stable exit codes", async () => {
  const runCase = async (argv, client, expected) => {
    const stdout = [];
    const stderr = [];
    const exitCode = await run(
      [...argv, "--json"],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      overrides(client),
    );
    assert.equal(exitCode, expected);
    assert.equal(JSON.parse(stdout[0]).ok, false);
    assert.equal(stdout.length, 1);
    assert.equal(stderr.length, 0);
  };
  await runCase(["unknown"], {}, EXIT.USAGE);
  await runCase(
    ["devices", "list"],
    { listDevices: async () => { throw new NetworkError("offline"); } },
    EXIT.NETWORK,
  );
  await runCase(
    ["notify", "send", "Done"],
    { sendNotification: async () => ({ eventId: "evt_1", ...DELIVERY, durableCommands: 0 }) },
    EXIT.NO_DELIVERY,
  );
  await runCase(
    ["notify", "send", "Done"],
    { sendNotification: async () => ({ eventId: "evt_1", queued: 1, accepted: 1 }) },
    EXIT.API,
  );
});

test("emits the frozen notification and activity-end contract shapes", async () => {
  let notification;
  let end;
  const client = {
    listDevices: async () => ({
      devices: [{ deviceId: TARGET_DEVICE }], cursor: null, hasMore: false,
    }),
    sendNotification: async (body) => {
      notification = body;
      return { ...CONTRACT_FIXTURE.delivery };
    },
    endActivity: async (_id, body) => {
      end = body;
      return { ...CONTRACT_FIXTURE.delivery };
    },
  };
  await execute(
    [
      "notify",
      "send",
      CONTRACT_FIXTURE.notification.body,
      "--title",
      CONTRACT_FIXTURE.notification.title,
      "--device",
      TARGET_DEVICE,
      "--computer",
      "Mac",
      "--project",
      "Relo",
      "--task-title",
      CONTRACT_FIXTURE.notification.context.taskTitle,
    ],
    {
      ...overrides(client),
      loadConfig: async () => ({ ...CONFIG, principal: { ...CONFIG.principal, name: "Codex" } }),
    },
  );
  await execute(
    [
      "activity",
      "end",
      "act_123456789012",
      "--status",
      "Complete",
      "--clear-detail",
      "--progress",
      "1",
      "--symbol",
      "success",
      "--accent-color",
      "#30D158",
      "--dismiss-after",
      "30s",
    ],
    overrides(client),
  );
  assert.deepEqual(notification, { ...CONTRACT_FIXTURE.notification,sourceName: "Test source",
    context: testContext(CONTRACT_FIXTURE.notification.context) });
  assert.deepEqual(end, CONTRACT_FIXTURE.activityEnd);
});

test("plain help is a short agent guide; the full reference is one topic away", async () => {
  for (const argv of [[], ["--help"], ["help"]]) {
    const guide = (await execute(argv)).data.help;
    assert.match(guide, /relo ask/);
    assert.match(guide, /relo work start/);
    assert.match(guide, /relo help all/);
    assert.ok(guide.split("\n").length < 45, "the guide stays short enough to read in one pass");
  }
  assert.match((await execute(["help", "identity"])).data.help, /first non-empty value wins/);
  assert.match((await execute(["help", "all"])).data.help, /relo services create/);
  await assert.rejects(execute(["help", "nope"]), /No help for "nope"/);
  // Help for one command comes from its registry entry: the same options the command accepts.
  for (const argv of [["help", "work", "start"], ["work", "start", "--help"]]) {
    const help = (await execute(argv, { env: { CLAUDE_CODE_SESSION_ID: "help-session" } })).data.help;
    assert.match(help, /^relo work start \[options\]/u);
    assert.match(help, /--goal TEXT/u);
    assert.doesNotMatch(help, /--producer/u, "an agent's help lists only an agent's options");
  }
  assert.match((await execute(["work", "start", "--help"])).data.help, /--producer/u, "a script's help lists a script's");
});

test("every recipe in the guide is a valid command", async () => {
  const { GUIDE } = await import("../src/help.mjs");
  const { UsageError } = await import("../src/shared/errors.mjs");
  const recipes = GUIDE.split("\n").filter((line) => line.startsWith("  relo ")).map((line) => line.replace(/\s{2,}\(.*\)\s*$/u, "")).map((line) =>
    [...line.trim().matchAll(/"([^"]*)"|(\S+)/gu)].map((match) => match[1] ?? match[2]).slice(1));
  assert.ok(recipes.length >= 5);
  const stub = new Proxy({}, { get: () => async () => ({}) });
  for (const argv of recipes) {
    try {
      await execute(argv, {
        loadConfig: async () => ({ apiUrl: "https://relo.example", token: "x".repeat(44) }),
        clientFactory: () => stub, identityDefaults: () => ({ providerName: "Claude Code", project: "relo" }),
        prepareNotificationCommand: async ({ body }) => body,
        captureActivityCommand: async ({ body }) => ({ target: null, ifSequence: body.ifSequence }),
        readStdinJson: async () => ({}), sleep: async () => {}, readTextFile: async () => "callback-token-0123456789",
        env: { CLAUDE_CODE_SESSION_ID: "recipe-session" },
      });
    } catch (error) {
      assert.ok(!(error instanceof UsageError), `${argv.join(" ")}: ${error.message}`);
    }
  }
});
