import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { EXIT } from "../src/shared/errors.mjs";
import { testContext, execute, run, overrides, TARGET_DEVICE, DELIVERY } from "./cli-fixtures.mjs";

test("normalizes yes-no to the API enum", async () => {
  const { fakeCards, cardDependencies } = await import("./fake-cards.mjs");
  const fake = fakeCards({ answer: "yes" });
  await execute(["ask", "Continue?", "--type", "yes-no", "--topic", "Release"], cardDependencies(fake.client));
  assert.equal(fake.calls.find((call) => ["ask", "question"].includes(call.op)).body.type, "yes_no");
});

test("merges notification stdin with explicit flags taking precedence", async () => {
  let seen;
  await execute(
    ["notify", "send", "Flag body", "--title", "Flag title", "--stdin"],
    {
      ...overrides({
        sendNotification: async (body) => {
          seen = body;
          return DELIVERY;
        },
      }),
      readStdinJson: async () => ({
        body: "stdin body",
        title: "stdin title",
        imageUrl: "https://example.test/image.png",
        url: "https://example.test/details",
        context: {
          providerName: "Codex",producerKind: "agent",computer: "Mac",project: "Workspace abc",
          providerThreadId: "task-42",providerWorkItemId: "turn-7",
          threadName: "Lifecycle audit",taskTitle: "Safe task",
          threadNameSource: "provider",taskTitleSource: "prompt_summary",
        },
        origin: {
          sourceInstance: "codex-install",project: "Workspace abc",
          thread: "opaque-task",channel: "task-progress",
        },
      }),
    },
  );
  assert.deepEqual(seen, {
    body: "Flag body",
    title: "Flag title",
    sourceName: "Codex",
    imageUrl: "https://example.test/image.png",
    destinationUrl: "https://example.test/details",
    context: {
      providerName: "Codex",producerKind: "agent",computer: "Mac",project: "Workspace abc",
      providerThreadId: "task-42",providerWorkItemId: "turn-7",
      threadName: "Lifecycle audit",taskTitle: "Safe task",
      threadNameSource: "provider",taskTitleSource: "prompt_summary",
    },
  });
});

test("sends byte-bounded long content metadata and withdraws an exact notification", async () => {
  let sent;
  let withdrawn;
  const client = {
    sendNotification: async (body) => { sent=body; return DELIVERY; },
    withdrawNotification: async (id,key) => {
      withdrawn={ id,key };
      return { eventId:id,state:"withdrawn",replayed:false };
    },
  };
  await execute([
    "notify","send","# Release", "--summary","Release notes", "--format","markdown",
  ],overrides(client));
  assert.equal(sent.summary,"Release notes");
  assert.equal(sent.bodyFormat,"markdown");
  await execute([
    "notify","withdraw","ntf_00000000-0000-4000-8000-000000000001",
    "--idempotency-key","withdraw-one",
  ],overrides(client));
  assert.deepEqual(withdrawn,{
    id:"ntf_00000000-0000-4000-8000-000000000001",key:"withdraw-one",
  });
  await assert.rejects(
    execute(["notify","send","界".repeat(21_846)],overrides(client)),
    /65,536 UTF-8 bytes/,
  );
});

test("supports the direct notify alias, multi-token text, and validates stdin context like flags", async () => {
  const sent = [];
  const client = {
    sendNotification: async (body) => { sent.push(body); return DELIVERY; },
  };
  await execute(["notify", "Build", "finished", "successfully"], overrides(client));
  await execute(["notify", "send", "Review", "the", "result"], overrides(client));
  await execute(["notify", "--", "ask"], overrides(client));
  assert.deepEqual(sent.map((body) => body.body), [
    "Build finished successfully",
    "Review the result",
    "ask",
  ]);
  await assert.rejects(
    execute(["notify", "send", "Done", "--stdin"], {
      ...overrides(client),
      readStdinJson: async () => ({ context: { computer: "x".repeat(121) } }),
    }),
    /at most 120 characters/,
  );
});

test("bounds JSON stdin before parsing for every stdin-enabled command", async () => {
  const oversized = {
    async *[Symbol.asyncIterator]() {
      yield Buffer.alloc(1024 * 1024 + 1, 0x20);
    },
  };
  await assert.rejects(
    execute(["notify", "send", "--stdin"], {
      ...overrides({ sendNotification: async () => DELIVERY }),
      stdinStream: oversized,
    }),
    /stdin JSON is too large/,
  );
});

test("activity names and bounded list limits route to canonical client methods", async () => {
  const seen = [];
  const client = {
    getActivity: async (key) => { seen.push(["get", key]); return { activity: { id: "act_1" } }; },
    endActivity: async (key) => { seen.push(["end", key]); return DELIVERY; },
    listActivities: async (limit) => { seen.push(["list", limit]); return { activities: [] }; },
  };
  await execute(["activity", "get", "--name", "build-main"], overrides(client));
  await execute(["activity", "end", "--name", "build-main"], overrides(client));
  await execute(["activity", "list", "--limit", "100"], overrides(client));
  assert.deepEqual(seen, [
    ["get", "build-main"], ["end", "build-main"], ["list", 100],
  ]);
  await assert.rejects(execute(["activity", "list", "--limit", "0"], overrides(client)), /at least 1/);
  await assert.rejects(execute(["activity", "get", "act_1", "--name", "other"], overrides(client)), /Usage:/);
  await assert.rejects(execute(["activity", "get", "--key", "retired"], overrides(client)), /Unknown option: --key/);
});

test("activity diagnose resolves the current activity and reports the exact failed boundary",async () => {
  const calls = [];
  const diagnosis = {
    version: 1,
    activity: { id: "act_current",operation: "start",generation: 1,sequence: 0 },
    assessment: {
      status: "unconfirmed",lastConfirmedStage: "apns",problemStage: "phone",
      code: "PHONE_CREATION_UNCONFIRMED",
      message: "APNs accepted the start, but phone creation is unconfirmed.",
      nextAction: "Run again with --wait 30s.",
    },
    devices: [],
  };
  const output = await execute(["activity","diagnose"],{
    ...overrides({
      resolveActivity: async (resolver) => {
        calls.push(["resolve",resolver]);
        return { found: true,activity: { id: "act_current" } };
      },
      diagnoseActivity: async (id) => { calls.push(["diagnose",id]); return diagnosis; },
    }),
    now: () => 0,
  });
  assert.equal(output.command,"activity.diagnose");
  assert.deepEqual(output.data.assessment,diagnosis.assessment);
  assert.deepEqual(output.data.wait,{
    requested: false,timeoutSeconds: 0,elapsedMs: 0,polls: 1,timedOut: false,
  });
  assert.match(output.message,/PHONE_CREATION_UNCONFIRMED/);
  assert.deepEqual(calls,[["resolve",{ current: true }],["diagnose","act_current"]]);
});

test("activity diagnose polls until the phone confirms the exact command",async () => {
  let now = 0;
  let polls = 0;
  const statuses = [
    { status: "waiting",code: "AWAITING_APNS" },
    { status: "unconfirmed",code: "PHONE_APPLICATION_UNCONFIRMED" },
    { status: "healthy",code: "PHONE_COMMAND_APPLIED" },
  ];
  const output = await execute([
    "activity","diagnose","release-build","--wait","--timeout","10s",
  ],{
    ...overrides({
      getActivity: async (target) => ({ activity: { id: `act_${target}` } }),
      diagnoseActivity: async () => {
        const current = statuses[Math.min(polls,statuses.length-1)];
        polls += 1;
        return { assessment: { ...current,message: current.code,nextAction: "none" } };
      },
    }),
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
  });
  assert.equal(polls,3);
  assert.equal(output.data.assessment.code,"PHONE_COMMAND_APPLIED");
  assert.deepEqual(output.data.wait,{
    requested: true,timeoutSeconds: 10,elapsedMs: 4_000,polls: 3,timedOut: false,
  });
});

test("activity diagnose returns actionable unconfirmed data when its bounded wait expires",async () => {
  let now = 0;
  const output = await execute(["activity","diagnose","--name","release-build","--wait","--timeout","3s"],{
    ...overrides({
      getActivity: async () => ({ activity: { id: "act_named" } }),
      diagnoseActivity: async () => ({ assessment: {
        status: "unconfirmed",code: "PHONE_CREATION_UNCONFIRMED",
        message: "Phone creation is unconfirmed.",nextAction: "Open Relo and retry.",
      } }),
    }),
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
  });
  assert.equal(output.exitCode,EXIT.OK);
  assert.equal(output.data.wait.timedOut,true);
  assert.equal(output.data.wait.elapsedMs,3_000);
  assert.equal(output.data.assessment.code,"PHONE_CREATION_UNCONFIRMED");
  await assert.rejects(
    execute(["activity","diagnose","--timeout","5s"],overrides({})),
    /--timeout requires --wait/,
  );
});

test("gets pending interaction state without treating it as a wait timeout", async () => {
  const data = {
    interaction: {
      id: "int_123456789012",
      eventId: "ntf_123456789012",
      type: "approval",
      prompt: "Continue?",
      state: "pending",
      response: null,
      expiresAt: "2026-08-07T01:00:00.000Z",
      respondedAt: null,
      createdAt: "2026-08-07T00:00:00.000Z",
    },
  };
  const output = await execute(
    ["interaction", "get", "int_123456789012"],
    overrides({ getInteraction: async () => data }),
  );
  assert.deepEqual(output.data, data);
});

test("sends notification fields and preserves an idempotency key", async () => {
  let seen;
  const output = await execute(
    [
      "notify",
      "send",
      "Build passed",
      "--title",
      "CI",
      "--device",
      TARGET_DEVICE,
      "--computer",
      "MacBook",
      "--project",
      "Relo notifications",
      "--task-title",
      "Finish notification lifecycle",
      "--idempotency-key",
      "build-12345678",
    ],
    overrides({
      listDevices: async () => ({
        devices: [{ deviceId: TARGET_DEVICE }], cursor: null, hasMore: false,
      }),
      sendNotification: async (body, idempotencyKey) => {
        seen = { body, idempotencyKey };
        return { event: { id: "evt_1" }, delivery: DELIVERY };
      },
    }),
  );
  assert.equal(output.exitCode, EXIT.OK);
  assert.equal(seen.idempotencyKey, "build-12345678");
  assert.deepEqual(seen.body.deviceIds, [TARGET_DEVICE]);
  assert.equal(seen.body.sourceName, "Test source");
  assert.equal(seen.body.title, "CI");
  assert.deepEqual(seen.body.context, testContext({
    computer: "MacBook",
    project: "Relo notifications",
    taskTitle: "Finish notification lifecycle",
  }));
});

test("accepts 1-200 supplied idempotency characters and rejects larger or unsafe keys", async () => {
  const seen = [];
  const client = {
    sendNotification: async (_body, idempotencyKey) => {
      seen.push(idempotencyKey);
      return DELIVERY;
    },
  };
  await execute(["notify", "send", "Done", "--idempotency-key", "a"], overrides(client));
  await execute([
    "notify", "send", "Done", "--idempotency-key", "a".repeat(200),
  ], overrides(client));
  await assert.rejects(
    execute([
      "notify", "send", "Done", "--idempotency-key", "a".repeat(201),
    ], overrides(client)),
    /1-200 safe characters/,
  );
  await assert.rejects(
    execute(["notify", "send", "Done", "--idempotency-key", "unsafe key"], overrides(client)),
    /1-200 safe characters/,
  );
  assert.deepEqual(seen, ["a", "a".repeat(200)]);
  const help = await execute(["help", "all"]);
  assert.match(help.data.help, /Supplied idempotency keys use 1-200 characters/);
});

test("interaction cancel returns the canonical canceled record as a successful mutation", async () => {
  const calls = [];
  const client = {
    cancelInteraction: async (id) => {
      calls.push(id);
      return { interaction: { id, state: "canceled", action: null, response: null } };
    },
  };
  const output = await execute(["interaction", "cancel", "int_123456789012"], overrides(client));
  assert.equal(output.command, "interaction.cancel");
  assert.deepEqual(calls, ["int_123456789012"]);
  assert.equal(output.data.interaction.state, "canceled");
  assert.equal(output.exitCode, EXIT.OK);

  const stdout = [];
  const stderr = [];
  const exitCode = await run(
    ["interaction", "cancel", "int_123456789012", "--json"],
    { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    overrides(client),
  );
  assert.equal(exitCode, EXIT.OK);
  assert.deepEqual(stderr, []);
  assert.deepEqual(stdout, [
    '{"ok":true,"id":"int_123456789012","state":"canceled"}',
  ]);
});

test("backs off after a pending poll returns one millisecond early", async () => {
  let now = 0;
  let polls = 0;
  const sleeps = [];
  const output = await execute(["interaction", "wait", "int_1", "--timeout", "2s"], {
    ...overrides({
      waitForInteraction: async () => {
        polls += 1;
        now += 1;
        return { interaction: { id: "int_1", state: polls === 1 ? "pending" : "approved" } };
      },
    }),
    now: () => now,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
  });
  assert.equal(output.data.interaction.state, "approved");
  assert.equal(polls, 2);
  assert.deepEqual(sleeps, [250]);
});

test("generates a safe idempotency key when the caller omits one", async () => {
  let idempotencyKey;
  await execute(["notify", "send", "Done"], {
    ...overrides({
      sendNotification: async (_body, key) => {
        idempotencyKey = key;
        return DELIVERY;
      },
    }),
    generateIdempotencyKey: () => "12345678-1234-1234-1234-123456789abc",
  });
  assert.equal(idempotencyKey, "relo-cli:12345678-1234-1234-1234-123456789abc");
});

test("a question waits 5 minutes by default and longer when asked, while the CLI blocks at most 5 minutes", async () => {
  const { fakeCards, cardDependencies } = await import("./fake-cards.mjs");
  const fake = fakeCards({ answer: "approved" });
  await execute(["ask", "Continue?", "--approval", "--topic", "Release"], cardDependencies(fake.client));
  assert.equal(fake.calls.find((call) => ["ask", "question"].includes(call.op)).body.expiresInSeconds, 300);
  const long = fakeCards({ answer: "approved" });
  await execute(["ask", "Continue?", "--approval", "--expires-in", "2d", "--topic", "Release"], cardDependencies(long.client));
  assert.equal(long.calls.find((call) => ["ask", "question"].includes(call.op)).body.expiresInSeconds, 172_800);
  for (const flags of [["--expires-in", "31d"], ["--timeout", "10m"], ["--expires-in", "1h", "--timeout", "2h"]]) {
    await assert.rejects(
      execute(["ask", "Continue?", "--approval", ...flags, "--topic", "Release"], cardDependencies(fakeCards().client)),
      (error) => error.exitCode === 2 && /--(expires-in|timeout) must be between/.test(error.message),
      flags.join(" "),
    );
  }
});
