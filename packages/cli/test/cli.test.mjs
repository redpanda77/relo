import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execute, EXIT, run } from "../src/cli.mjs";
import { ApiError, AuthError, NetworkError } from "../src/errors.mjs";

const CONFIG = {
  apiUrl: "https://server.example.test",
  token: `klb_${"x".repeat(44)}`,
  path: "/private/config.json",
  principal: {
    id: "prn_test",
    scopes: ["notifications:send", "interactions:create", "interactions:read"],
  },
};

function overrides(client) {
  return {
    configPath: () => CONFIG.path,
    loadConfig: async () => CONFIG,
    clientFactory: () => client,
  };
}

const LOGIN_SCOPES = ["interactions:create", "interactions:read", "notifications:send"];
const DEVICE_CODE = "d".repeat(43);
const ACCESS_TOKEN = `relo_${"s".repeat(43)}`;
const TARGET_DEVICE = "dev_123456789012";
const PARENT_ACTIVITY = "act_11111111-1111-4111-8111-111111111111";
const COMPANION_ACTIVITY = "act_22222222-2222-4222-8222-222222222222";
const WAIT_INTERACTION = "int_33333333-3333-4333-8333-333333333333";
const WAIT_EVENT = "ntf_44444444-4444-4444-8444-444444444444";
const DELIVERY_JOB = "job_55555555-5555-4555-8555-555555555555";
const DELIVERY = { eligibleDevices: 1, durableCommands: 1, apnsJobs: 0 };
const CONTRACT_FIXTURE = JSON.parse(
  readFileSync(new URL("../../contracts/fixtures/current-slice.json", import.meta.url), "utf8"),
);
const EVIDENCE_FIXTURE = JSON.parse(
  readFileSync(new URL("../../contracts/fixtures/delivery-evidence-v1.json", import.meta.url), "utf8"),
);

function authorizationStart(overrides = {}) {
  return {
    deviceCode: DEVICE_CODE,
    userCode: "ABCD-EFGH",
    verificationUri: "http://192.168.1.10:8180/cli/authorize",
    verificationUriComplete: "http://192.168.1.10:8180/cli/authorize?code=ABCD-EFGH",
    expiresInSeconds: 600,
    intervalSeconds: 5,
    ...overrides,
  };
}

function issuedCredential(overrides = {}) {
  return {
    accessToken: ACCESS_TOKEN,
    credential: {
      id: "key_0123456789ab",
      clientName: "Mac Codex",
      prefix: "relo_ssss",
      scopes: LOGIN_SCOPES,
      createdAt: "2026-08-06T12:00:00.000Z",
      expiresAt: "2026-11-04T12:00:00.000Z",
      lastUsedAt: null,
      revokedAt: null,
    },
    ...overrides,
  };
}

test("doctor reports missing local login without leaking its path", async () => {
  const output = await execute(["doctor"],{
    configPath: () => "/private/relo/config.json",
    loadConfig: async () => { throw new AuthError("missing",{ code: "CONFIG_NOT_FOUND" }); },
  });
  assert.equal(output.exitCode,EXIT.AUTH);
  assert.equal(output.data.checks.localConfig.state,"CONFIG_NOT_FOUND");
  assert.equal(JSON.stringify(output).includes("/private/relo"),false);
});

test("doctor returns one honest readiness result", async () => {
  const output = await execute(["doctor"],overrides({
    ready: async () => ({ status: "ok" }),
    authStatus: async () => ({ authenticated: true,credential: issuedCredential().credential }),
    doctor: async () => ({
      version: 1,ok: true,releaseIdentity: "0.7.20-test",
      checks: {
        database: { ok: true },worker: { ok: true,state: "ready" },
        apns: { ok: true,state: "configured" },devices: { ok: true,notificationAuthorized: 1 },
      },
    }),
  }));
  assert.equal(output.exitCode,EXIT.OK);
  assert.equal(output.data.ok,true);
  assert.equal(output.data.checks.runtime.releaseIdentity,"0.7.20-test");
});

test("doctor rejects activity credentials that cannot inspect delivery evidence", async () => {
  const output = await execute(["doctor"],overrides({
    ready: async () => ({ status: "ok" }),
    authStatus: async () => ({
      authenticated: true,
      credential: issuedCredential({
        credential: {
          ...issuedCredential().credential,
          scopes: ["activities:read","activities:write"],
        },
      }).credential,
    }),
    doctor: async () => ({ version: 1,ok: true,checks: {} }),
  }));
  assert.equal(output.exitCode,EXIT.AUTH);
  assert.equal(output.data.ok,false);
  assert.equal(output.data.checks.auth.state,"activity_evidence_scope_missing");
  assert.deepEqual(output.data.checks.auth.missingScopes,["devices:read"]);
  assert.equal(output.data.checks.runtime.ok,true);
});

test("doctor smoke never mistakes server acceptance for provider or phone receipt", async () => {
  let request;
  const output = await execute(["doctor","--smoke"],overrides({
    ready: async () => ({ status: "ok" }),
    authStatus: async () => ({ authenticated: true,credential: issuedCredential().credential }),
    doctor: async () => ({ version: 1,ok: true,checks: {} }),
    sendNotification: async (body) => {
      request = body;
      return { eventId: "ntf_smoke",delivery: { durableCommands: 1 } };
    },
  }));
  assert.equal(output.exitCode,EXIT.OK);
  assert.equal(output.data.checks.smoke.serverAccepted,true);
  assert.equal(output.data.checks.smoke.providerAccepted,null);
  assert.equal(output.data.checks.smoke.phoneReceived,null);
  assert.equal(request.sourceName,"Relo doctor");
});

function activityWaitResponse(overrides = {}) {
  const base = {
    parentActivityId: PARENT_ACTIVITY,
    companionActivityId: COMPANION_ACTIVITY,
    interaction: {
      id: WAIT_INTERACTION,
      eventId: WAIT_EVENT,
      type: "approval",
      prompt: "Approve the reviewed release?",
      state: "pending",
      expiresAt: "2026-08-07T12:15:00.000Z",
    },
    eventId: WAIT_EVENT,
    delivery: DELIVERY,
    queued: 1,
    deliveryMode: "durable_inbox_refresh_only",
    replayed: false,
  };
  return {
    ...base,
    ...overrides,
    interaction: { ...base.interaction, ...(overrides.interaction ?? {}) },
  };
}

test("delivery reconciliation exposes only the three server-guarded operator actions", async () => {
  const calls = [];
  const client = {
    reconcileDelivery: async (id,action) => {
      calls.push({ id,action });
      return { deliveryId: id,action,state: action === "mark_accepted" ? "accepted" : action,replayed: false };
    },
  };
  const response = await execute([
    "delivery","reconcile",DELIVERY_JOB,"mark-accepted","--json",
  ],overrides(client));
  assert.equal(response.command,"delivery.reconcile");
  assert.deepEqual(calls,[{ id: DELIVERY_JOB,action: "mark_accepted" }]);
  await assert.rejects(
    execute(["delivery","reconcile",DELIVERY_JOB,"force-retry"],overrides(client)),
    /reconciliation action/,
  );
  await assert.rejects(
    execute(["delivery", "reconcile", DELIVERY_JOB], overrides(client)),
    /Usage: relo delivery reconcile/,
  );
  await assert.rejects(
    execute(["delivery","reconcile","not-a-job","cancel"],overrides(client)),
    /public job_/,
  );
});

test("evidence commands preserve the canonical vocabulary and guarded filters",async () => {
  const calls = [];
  const metrics = {
    version: 1,generatedAt: "2026-08-14T12:01:00.000Z",
    queue: { pendingJobs: 2,oldestAgeMs: 12000 },worker: { lagMs: 4000 },
    delivery: { retryRate1h: 0.25,ambiguousOutcomes1h: 1,invalidatedTokens24h: 0,
      receiptLatencyP95Ms24h: 900 },
  };
  const client = {
    getEvidenceTimeline: async (options) => { calls.push(options); return EVIDENCE_FIXTURE; },
    getEvidenceMetrics: async () => metrics,
  };
  const timeline = await execute([
    "evidence","timeline","--notification",WAIT_EVENT,"--limit","25","--cursor","next-page",
  ],overrides(client));
  assert.equal(timeline.command,"evidence.timeline");
  assert.deepEqual(timeline.data,EVIDENCE_FIXTURE);
  assert.deepEqual(calls,[{ notificationId: WAIT_EVENT,limit: 25,cursor: "next-page" }]);
  assert.deepEqual((await execute(["evidence","metrics"],overrides(client))).data,metrics);
  await assert.rejects(
    execute(["evidence","timeline","--notification","private-project-name"],overrides(client)),
    /public ntf_/,
  );
  await assert.rejects(
    execute(["evidence","timeline","--limit","101"],overrides(client)),
    /at most 100/,
  );
});

test("auth login follows pending and slow-down, opens the frozen URL, and stores safely", async () => {
  let now = 0;
  let polls = 0;
  let opened;
  let written;
  const diagnostics = [];
  const client = {
    startDeviceAuthorization: async (body) => {
      assert.deepEqual(body, {
        clientName: "Mac Codex",
        scopes: LOGIN_SCOPES,
        expiresInSeconds: 7_776_000,
      });
      return authorizationStart();
    },
    pollDeviceAuthorization: async () => {
      polls += 1;
      if (polls === 1) {
        throw new ApiError("authorization_pending", {
          status: 400,
          code: "AUTHORIZATION_PENDING",
          details: { intervalSeconds: 5 },
        });
      }
      if (polls === 2) {
        throw new ApiError("slow_down", {
          status: 400,
          code: "SLOW_DOWN",
          details: { intervalSeconds: 10 },
        });
      }
      return issuedCredential();
    },
  };
  const output = await execute(
    [
      "auth",
      "login",
      "--client-name",
      "Mac Codex",
      "--scope",
      "notifications:send",
      "--scope",
      "interactions:create",
      "--scope",
      "interactions:read",
      "--open",
    ],
    {
      env: { RELO_API_URL: "http://192.168.1.10:8180" },
      configPath: () => CONFIG.path,
      clientFactory: () => client,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      openBrowser: (url) => {
        opened = url;
      },
      stderr: (line) => diagnostics.push(line),
      writeConfig: async (path, value) => {
        written = { path, value };
      },
    },
  );
  assert.equal(output.exitCode, EXIT.OK);
  assert.equal(opened, authorizationStart().verificationUriComplete);
  assert.deepEqual(diagnostics, [
    "Open this link to connect the Relo CLI:",
    "http://192.168.1.10:8180/cli/authorize?code=ABCD-EFGH",
    "Fallback page: http://192.168.1.10:8180/cli/authorize",
    "Fallback code: ABCD-EFGH",
  ]);
  assert.equal(polls, 3);
  assert.equal(written.path, CONFIG.path);
  assert.deepEqual(written.value.principal.scopes, LOGIN_SCOPES);
  assert.equal(written.value.token, ACCESS_TOKEN);
  assert.equal(JSON.stringify(output).includes(ACCESS_TOKEN), false);
  assert.equal(JSON.stringify(output).includes(DEVICE_CODE), false);
});

test("auth login survives transient network and server failures while authorization is pending",async () => {
  let now = 0;
  let polls = 0;
  let written = false;
  const diagnostics = [];
  const output = await execute([
    "auth","login","--no-open",
    "--scope","notifications:send",
    "--scope","interactions:create",
    "--scope","interactions:read",
  ],{
    env: { RELO_API_URL: "http://192.168.1.10:8180" },
    configPath: () => CONFIG.path,
    configRevision: async () => null,
    clientFactory: () => ({
      startDeviceAuthorization: async () => authorizationStart(),
      pollDeviceAuthorization: async () => {
        polls += 1;
        if (polls === 1) throw new NetworkError("temporary network failure");
        if (polls === 2) throw new ApiError("temporary gateway failure",{ status: 502 });
        return issuedCredential({
          credential: { ...issuedCredential().credential,clientName: "Relo CLI" },
        });
      },
    }),
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
    writeConfig: async () => { written = true; },
    stderr: (line) => diagnostics.push(line),
  });
  assert.equal(output.exitCode,EXIT.OK);
  assert.equal(polls,3);
  assert.equal(written,true);
  assert.equal(
    diagnostics.includes(authorizationStart().verificationUriComplete),
    true,
  );
});

test("auth login keeps the complete link visible when browser launch fails", async () => {
  let now = 0;
  const diagnostics = [];
  const output = await execute([
    "auth", "login", "--open",
    "--scope", "notifications:send",
    "--scope", "interactions:create",
    "--scope", "interactions:read",
  ], {
    ...overrides({
      startDeviceAuthorization: async () => authorizationStart(),
      pollDeviceAuthorization: async () => issuedCredential({
        credential: {
          ...issuedCredential().credential,
          clientName: "Relo CLI",
          scopes: LOGIN_SCOPES,
        },
      }),
    }),
    env: { RELO_API_URL: "http://192.168.1.10:8180" },
    now: () => now,
    sleep: async (milliseconds) => { now += milliseconds; },
    openBrowser: () => { throw new Error("browser unavailable"); },
    stderr: (line) => diagnostics.push(line),
    writeConfig: async () => {},
  });
  assert.equal(output.exitCode, EXIT.OK);
  assert.equal(diagnostics[1], authorizationStart().verificationUriComplete);
  assert.equal(
    diagnostics.includes("Could not open browser: browser unavailable"),
    true,
  );
});

test("first login requires an explicit trusted origin while re-login preserves the configured origin", async () => {
  await assert.rejects(
    execute(["auth", "login"], {
      env: {},
      configPath: () => "/missing/config.json",
      loadConfig: async () => { throw new AuthError("missing", { code: "CONFIG_NOT_FOUND" }); },
    }),
    /server origin is required/,
  );
  let usedOrigin;
  await assert.rejects(
    execute(["auth", "login", "--no-open"], {
      ...overrides({
        startDeviceAuthorization: async () => {
          usedOrigin = CONFIG.apiUrl;
          return authorizationStart({
            verificationUri: `${CONFIG.apiUrl}/cli/authorize`,
            verificationUriComplete: `${CONFIG.apiUrl}/cli/authorize?code=ABCD-EFGH`,
          });
        },
        pollDeviceAuthorization: async () => {
          throw new ApiError("denied", { code: "ACCESS_DENIED" });
        },
      }),
      env: {},
      now: (() => { let value = 0; return () => value += 5_000; })(),
      sleep: async () => {},
    }),
    /denied/,
  );
  assert.equal(usedOrigin, CONFIG.apiUrl);
});

test("auth login rejects a foreign authorization URL before browser launch or polling", async () => {
  let opened = false;
  await assert.rejects(
    execute(["auth", "login"], {
      env: { RELO_API_URL: "http://192.168.1.10:8180" },
      configRevision: async () => null,
      clientFactory: () => ({
        startDeviceAuthorization: async () =>
          authorizationStart({
            verificationUriComplete: "https://attacker.example/cli/authorize?code=ABCD-EFGH",
          }),
      }),
      openBrowser: () => {
        opened = true;
      },
    }),
    (error) => error.code === "INVALID_API_RESPONSE",
  );
  assert.equal(opened, false);
});

test("auth login revokes an issued token when secure persistence fails", async () => {
  let now = 0;
  let revoked = 0;
  const clientFactory = (config) =>
    config.token
      ? {
          revokeAuth: async () => {
            assert.equal(config.token, ACCESS_TOKEN);
            revoked += 1;
          },
        }
      : {
          startDeviceAuthorization: async () => authorizationStart(),
          pollDeviceAuthorization: async () => issuedCredential({
            credential: { ...issuedCredential().credential, clientName: "Relo CLI" },
          }),
        };
  await assert.rejects(
    execute(["auth", "login", "--scope", "notifications:send", "--scope", "interactions:create", "--scope", "interactions:read"], {
      env: { RELO_API_URL: "http://192.168.1.10:8180" },
      configRevision: async () => null,
      clientFactory,
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      writeConfig: async () => {
        throw new Error("disk unavailable");
      },
    }),
    (error) => error.message === "disk unavailable" && !error.message.includes(ACCESS_TOKEN),
  );
  assert.equal(revoked, 1);
});

test("auth login maps denial, expiry, and timeout to frozen exit codes", async () => {
  const runCase = async (pollError, expectedExit) => {
    let now = 0;
    const stdout = [];
    const stderr = [];
    const exitCode = await run(
      ["auth", "login", "--timeout", "6s", "--json"],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      {
        env: { RELO_API_URL: "http://192.168.1.10:8180" },
        configRevision: async () => null,
        clientFactory: () => ({
          startDeviceAuthorization: async () => authorizationStart(),
          pollDeviceAuthorization: async () => {
            throw pollError;
          },
        }),
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
      },
    );
    assert.equal(exitCode, expectedExit);
    assert.equal(stdout.length, 1);
    assert.equal(JSON.parse(stdout[0]).ok, false);
    assert.equal(stderr.join("\n").includes(DEVICE_CODE), false);
    assert.equal(stderr.join("\n").includes(ACCESS_TOKEN), false);
  };
  await runCase(
    new ApiError("access_denied", { status: 400, code: "ACCESS_DENIED" }),
    EXIT.NEGATIVE,
  );
  await runCase(
    new ApiError("expired_token", { status: 400, code: "EXPIRED_TOKEN" }),
    EXIT.TERMINAL,
  );
  await runCase(
    new ApiError("authorization_pending", {
      status: 400,
      code: "AUTHORIZATION_PENDING",
      details: { intervalSeconds: 5 },
    }),
    EXIT.TERMINAL,
  );
});

test("public CLI help and command routing omit rejected phone pairing", async () => {
  const help = await execute(["--help"]);
  assert.equal(help.data.help.includes("pair ios"), false);
  for (const text of [
    "relo notify [BODY...]",
    "--computer NAME",
    "--project NAME",
    "--thread-name NAME",
    "--task-title TEXT",
    "--name NAME",
    "--limit 1..100",
    "relo devices list [--page-size 1..100]",
    "relo activity wait ACTIVITY_ID",
    "--api-url URL",
    "relo interaction cancel ID",
  ]) assert.equal(help.data.help.includes(text), true, text);
  assert.equal(help.data.help.includes("standard|ring"), false);
  await assert.rejects(execute(["pair", "ios"], overrides({})), /Unknown command/);
});

test("reports the package version without requiring credentials", async () => {
  const stdout = [];
  assert.equal(await run(["--version"], { stdout: (line) => stdout.push(line) }), EXIT.OK);
  assert.deepEqual(stdout, ["0.7.17"]);
});

test("normalizes yes-no to the API enum and validates activity styles", async () => {
  let interaction;
  await execute(
    ["notify", "ask", "Continue?", "--type", "yes-no"],
    overrides({
      createInteraction: async (body) => {
        interaction = body;
        return { interaction: { id: "int_1" }, delivery: DELIVERY };
      },
    }),
  );
  assert.equal(interaction.type, "yes_no");
  await assert.rejects(
    execute(
      ["activity", "start", "--name", "build-1", "--title", "Build", "--status", "Starting", "--style", "unknown"],
      overrides({}),
    ),
    /--style must be one of/,
  );
  for (const style of ["approval", "shell", "verdict", "signal"]) {
    await assert.rejects(
      execute(
        ["activity", "start", "--name", "build-1", "--title", "Build", "--status", "Starting", "--style", style],
        overrides({}),
      ),
      /reserved for interactive Live Activities/,
    );
  }
});

test("accepts all current task activity styles", async () => {
  const styles = [];
  const client = {
    startActivity: async (body) => {
      styles.push(body.style);
      return DELIVERY;
    },
  };
  for (const style of ["standard", "hero", "terminal", "steps"]) {
    await execute(
      ["activity", "start", "--name", `build-${style}`, "--title", "Build", "--status", "Starting", "--style", style],
      overrides(client),
    );
  }
  assert.deepEqual(styles, ["standard", "hero", "terminal", "steps"]);
  await assert.rejects(
    execute(["activity", "start", "--title", "Build"], overrides(client)),
    /--status is required/,
  );
});

test("forwards explicit presentation overrides while leaving defaults to the server", async () => {
  const calls = [];
  const client = {
    startActivity: async (body) => {
      calls.push(body);
      return DELIVERY;
    },
  };
  await execute([
    "activity","start","--name","build-policy","--title","Build","--status","Starting",
    "--preset","terminal","--theme","dark","--accent-color","#63B3FF",
  ],overrides(client));
  assert.deepEqual(calls,[{
    key: "build-policy",replace: false,title: "Build",status: "Starting",
    preset: "terminal",theme: "dark",accentColor: "#63B3FF",
    expiresInSeconds: 28_800,staleAfterSeconds: 14_400,
  }]);
});

test("keeps the steps preset available on measured activity updates",async () => {
  const calls = [];
  const client = {
    updateActivity: async (id,body) => {
      calls.push({ id,body });
      return DELIVERY;
    },
  };
  await execute([
    "activity","update","act_123456789012","--status","Level 7","--progress","0.0386",
    "--preset","steps",
  ],overrides(client));
  assert.deepEqual(calls,[{
    id: "act_123456789012",
    body: { status: "Level 7",progress: 0.0386,style: "steps" },
  }]);
});

test("sends named step facts and an independent measured progress label",async () => {
  const calls = [];
  const client = {
    startActivity: async (body) => {
      calls.push({ operation: "start",body });
      return DELIVERY;
    },
    updateActivity: async (id,body) => {
      calls.push({ operation: "update",id,body });
      return DELIVERY;
    },
  };
  await execute([
    "activity","start","--name","release","--title","Release","--status","Building",
    "--step","Plan","--step","Build","--step","Verify","--step-current","2",
    "--progress","0.625","--progress-label","5 of 8",
  ],overrides(client));
  await execute([
    "activity","update","release","--status","Verifying",
    "--step","Plan","--step","Build","--step","Verify","--step-current","3",
    "--progress","0.875","--progress-label","7 of 8",
  ],overrides(client));
  assert.deepEqual(calls,[
    {
      operation: "start",
      body: {
        key: "release",replace: false,title: "Release",status: "Building",
        progress: 0.625,progressLabel: "5 of 8",
        steps: { labels: ["Plan","Build","Verify"],current: 2 },
        expiresInSeconds: 28_800,staleAfterSeconds: 14_400,
      },
    },
    {
      operation: "update",id: "release",
      body: {
        status: "Verifying",progress: 0.875,progressLabel: "7 of 8",
        steps: { labels: ["Plan","Build","Verify"],current: 3 },
      },
    },
  ]);
});

test("rejects incomplete semantic step input before any API mutation",async () => {
  await assert.rejects(
    execute([
      "activity","start","--title","Release","--status","Building",
      "--step","Plan","--progress","0.25",
    ],overrides({ startActivity: async () => assert.fail("must not call API") })),
    /--step-current is required/,
  );
  await assert.rejects(
    execute([
      "activity","start","--title","Release","--status","Building",
      "--progress-label","1 of 4",
    ],overrides({ startActivity: async () => assert.fail("must not call API") })),
    /--progress-label requires --progress/,
  );
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
    sourceName: "Relo",
    imageUrl: "https://example.test/image.png",
    destinationUrl: "https://example.test/details",
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

test("ordinary notification asks accept HTTPS image and destination URLs but Live Activities reject them", async () => {
  let created;
  const client = {
    createInteraction: async (body) => { created = body; return { interaction: { id: "int_media", state: "pending" }, delivery: DELIVERY }; },
  };
  await execute([
    "notify", "ask", "Review", "this", "artifact", "--approval",
    "--image", "https://example.test/image.png", "--url", "https://example.test/details",
  ], overrides(client));
  assert.equal(created.prompt, "Review this artifact");
  assert.equal(created.imageUrl, "https://example.test/image.png");
  assert.equal(created.destinationUrl, "https://example.test/details");
  await assert.rejects(
    execute(["notify", "ask", "Deploy?", "--approval", "--live-activity", "--image", "https://example.test/a.png"], overrides(client)),
    /ordinary notification asks/,
  );
  await assert.rejects(
    execute(["notify", "ask", "Review?", "--approval", "--stdin"], {
      ...overrides(client),
      readStdinJson: async () => ({ imageUrl: "https://127.0.0.1/private.png" }),
    }),
    /public HTTPS/,
  );
});

test("activity names and bounded list limits route to canonical client methods", async () => {
  const seen = [];
  const client = {
    getActivity: async (key) => { seen.push(["get", key]); return { activity: { id: "act_1" } }; },
    updateActivity: async (key) => { seen.push(["update", key]); return DELIVERY; },
    endActivity: async (key) => { seen.push(["end", key]); return DELIVERY; },
    listActivities: async (limit) => { seen.push(["list", limit]); return { activities: [] }; },
  };
  await execute(["activity", "get", "--name", "build-main"], overrides(client));
  await execute(["activity", "update", "--name", "build-main", "--status", "Running"], overrides(client));
  await execute(["activity", "end", "--name", "build-main"], overrides(client));
  await execute(["activity", "list", "--limit", "100"], overrides(client));
  assert.deepEqual(seen, [
    ["get", "build-main"], ["update", "build-main"], ["end", "build-main"], ["list", 100],
  ]);
  await assert.rejects(execute(["activity", "list", "--limit", "0"], overrides(client)), /at least 1/);
  await assert.rejects(execute(["activity", "get", "act_1", "--name", "other"], overrides(client)), /Usage:/);
  await assert.rejects(execute(["activity", "get", "--key", "retired"], overrides(client)), /--key is not valid/);
});

test("activity wait binds an exact parent ID and preserves creation proof through phone wait", async () => {
  let created;
  let now = 0;
  const output = await execute([
    "activity", "wait", PARENT_ACTIVITY, "Approve", "the", "reviewed", "release?",
    "--approval", "--primary-label", "Approve", "--secondary-label", "Deny",
    "--expires-in", "15m", "--idempotency-key", "release-wait-1", "--poll",
  ], {
    ...overrides({
      createActivityWait: async (id, body, key) => {
        created = { id, body, key };
        return activityWaitResponse();
      },
      waitForInteraction: async (id, timeoutSeconds) => {
        assert.equal(id, WAIT_INTERACTION);
        assert.equal(timeoutSeconds, 20);
        now += timeoutSeconds * 1_000;
        return {
          interaction: {
            ...activityWaitResponse().interaction,
            state: "approved",
            action: "approve",
            respondingDevice: { id: "dev_123456789012", name: "iPhone" },
            respondedAt: "2026-08-07T12:01:00.000Z",
          },
        };
      },
    }),
    now: () => now,
  });
  assert.deepEqual(created, {
    id: PARENT_ACTIVITY,
    key: "release-wait-1",
    body: {
      type: "approval",
      prompt: "Approve the reviewed release?",
      expiresInSeconds: 900,
      primaryLabel: "Approve",
      secondaryLabel: "Deny",
    },
  });
  assert.equal(output.command, "activity.wait");
  assert.equal(output.data.parentActivityId, PARENT_ACTIVITY);
  assert.equal(output.data.companionActivityId, COMPANION_ACTIVITY);
  assert.equal(output.data.eventId, WAIT_EVENT);
  assert.equal(output.data.delivery.durableCommands, 1);
  assert.equal(output.data.deliveryMode, "durable_inbox_refresh_only");
  assert.equal(output.data.interaction.id, WAIT_INTERACTION);
  assert.equal(output.data.interaction.state, "approved");
});

test("activity wait supports canonical text attachment without a companion activity", async () => {
  let body;
  const response = activityWaitResponse({
    companionActivityId: null,
    interaction: {
      type: "text",
      prompt: "Short release note?",
    },
    replayed: true,
    unexpectedSecret: "must-not-reach-stdout",
  });
  const output = await execute([
    "activity", "wait", PARENT_ACTIVITY, "Short", "release", "note?",
    "--text", "--idempotency-key", "release-text-1",
  ], overrides({
    createActivityWait: async (_id, value) => { body = value; return response; },
  }));
  assert.deepEqual(body, {
    type: "text",
    prompt: "Short release note?",
    expiresInSeconds: 900,
  });
  assert.equal(output.data.parentActivityId, PARENT_ACTIVITY);
  assert.equal(output.data.companionActivityId, null);
  assert.equal(output.data.interaction.type, "text");
  assert.equal(output.data.replayed, true);
  assert.equal("unexpectedSecret" in output.data, false);
  assert.equal(JSON.stringify(output).includes("must-not-reach-stdout"), false);
});

test("activity wait rejects aliases, unsafe request combinations, malformed evidence, and no delivery", async () => {
  let calls = 0;
  const client = {
    createActivityWait: async () => {
      calls += 1;
      return activityWaitResponse();
    },
  };
  for (const argv of [
    ["activity", "wait", "release-main", "Approve?", "--approval"],
    ["activity", "wait", PARENT_ACTIVITY, "Reply?", "--text", "--primary-label", "Reply"],
    ["activity", "wait", PARENT_ACTIVITY, "x".repeat(241), "--approval"],
  ]) {
    await assert.rejects(execute(argv, overrides(client)), (error) => error.code === "USAGE_ERROR");
  }
  assert.equal(calls, 0);

  const malformed = [
    { parentActivityId: COMPANION_ACTIVITY },
    { companionActivityId: null },
    { eventId: "ntf_55555555-5555-4555-8555-555555555555" },
    { interaction: { type: "yes_no" } },
    { interaction: { expiresAt: "August 7, 2026" } },
    { deliveryMode: "queued_for_direct_apns" },
    { queued: -1 },
  ];
  for (const overridesValue of malformed) {
    await assert.rejects(
      execute([
        "activity", "wait", PARENT_ACTIVITY, "Approve", "the", "reviewed", "release?",
        "--approval",
      ], overrides({
        createActivityWait: async () => activityWaitResponse(overridesValue),
      })),
      (error) => error.code === "INVALID_API_RESPONSE",
    );
  }

  await assert.rejects(
    execute([
      "activity", "wait", PARENT_ACTIVITY, "Approve", "the", "reviewed", "release?",
      "--approval",
    ], overrides({
      createActivityWait: async () => activityWaitResponse({
        delivery: { eligibleDevices: 1, durableCommands: 0, apnsJobs: 0 },
      }),
    })),
    (error) => error.code === "NO_ACCEPTED_DELIVERY" && error.exitCode === EXIT.NO_DELIVERY,
  );
});

test("devices list enumerates every page without changing its output contract", async () => {
  const calls = [];
  const first = { deviceId: "dev_111111111111", name: "First" };
  const second = { deviceId: "dev_222222222222", name: "Second" };
  const third = { deviceId: "dev_333333333333", name: "Third" };
  const client = {
    listDevices: async (options) => {
      calls.push(options);
      if (options.cursor === undefined) {
        return { devices: [first, second], cursor: "page-two", hasMore: true };
      }
      return { devices: [third], cursor: null, hasMore: false };
    },
  };
  const output = await execute(["devices", "list", "--page-size", "2"], overrides(client));
  assert.equal(output.command, "devices.list");
  assert.deepEqual(output.data, { devices: [first, second, third] });
  assert.deepEqual(calls, [
    { limit: 2 },
    { limit: 2, cursor: "page-two" },
  ]);

  await assert.rejects(
    execute(["devices", "list", "--page-size", "0"], overrides(client)),
    /at least 1/,
  );
  await assert.rejects(
    execute(["devices", "list", "--page-size", "101"], overrides(client)),
    /at most 100/,
  );
});

test("device pagination fails closed on malformed pages, duplicates, loops, and excessive pages", async () => {
  const valid = { deviceId: "dev_111111111111" };
  for (const response of [
    undefined,
    {},
    { devices: "invalid", cursor: null, hasMore: false },
    { devices: [{ deviceId: "invalid" }], cursor: null, hasMore: false },
    { devices: [valid] },
    { devices: [valid], hasMore: false },
    { devices: [valid], cursor: null },
    { devices: [valid], cursor: null, hasMore: true },
    { devices: [valid], cursor: "next", hasMore: false },
    { devices: [], cursor: "next", hasMore: true },
  ]) {
    await assert.rejects(
      execute(["devices", "list"], overrides({ listDevices: async () => response })),
      (error) => error.code === "INVALID_API_RESPONSE",
    );
  }

  await assert.rejects(
    execute(["devices", "list"], overrides({
      listDevices: async ({ cursor }) => cursor === undefined
        ? { devices: [valid], cursor: "again", hasMore: true }
        : { devices: [{ deviceId: "dev_222222222222" }], cursor: "again", hasMore: true },
    })),
    (error) => error.code === "INVALID_API_RESPONSE",
  );
  await assert.rejects(
    execute(["devices", "list"], overrides({
      listDevices: async ({ cursor }) => cursor === undefined
        ? { devices: [valid], cursor: "next", hasMore: true }
        : { devices: [valid], cursor: null, hasMore: false },
    })),
    (error) => error.code === "INVALID_API_RESPONSE",
  );

  let pages = 0;
  await assert.rejects(
    execute(["devices", "list", "--page-size", "1"], overrides({
      listDevices: async () => {
        pages += 1;
        return {
          devices: [{ deviceId: `dev_${String(pages).padStart(12, "0")}` }],
          cursor: `page-${pages}`,
          hasMore: true,
        };
      },
    })),
    (error) => error.code === "INVALID_API_RESPONSE",
  );
  assert.equal(pages, 100);
});

test("target validation reaches later pages and preserves authentication and cursor failures", async () => {
  const target = "dev_999999999999";
  let sent;
  const output = await execute(["notify", "send", "Done", "--device", target], overrides({
    listDevices: async ({ cursor }) => cursor === undefined
      ? { devices: [{ deviceId: "dev_111111111111" }], cursor: "next", hasMore: true }
      : { devices: [{ deviceId: target }], cursor: null, hasMore: false },
    sendNotification: async (body) => { sent = body; return DELIVERY; },
  }));
  assert.equal(output.exitCode, EXIT.OK);
  assert.deepEqual(sent.deviceIds, [target]);

  for (const failure of [
    new ApiError("unauthorized", { status: 401, code: "UNAUTHORIZED" }),
    new ApiError("cursor_expired", { status: 410, code: "CURSOR_EXPIRED" }),
  ]) {
    await assert.rejects(
      execute(["devices", "list"], overrides({ listDevices: async () => { throw failure; } })),
      (error) => error === failure,
    );
  }
});

test("supports stdin ask selectors and a fixed twenty-second poll", async () => {
  let now = 0;
  let created;
  const waits = [];
  const output = await execute(["notify", "ask", "--stdin", "--yes-no", "--poll"], {
    ...overrides({
      createInteraction: async (body) => {
        created = body;
        return {
          interaction: { id: "int_1", state: "pending" },
          eventId: "ntf_created_123456",
          delivery: DELIVERY,
          queued: 0,
          replayed: false,
        };
      },
      waitForInteraction: async (_id, timeoutSeconds) => {
        waits.push(timeoutSeconds);
        now += timeoutSeconds * 1_000;
        return { interaction: { id: "int_1", state: "yes" } };
      },
    }),
    now: () => now,
    readStdinJson: async () => ({
      prompt: "Continue?",
      type: "approval",
      title: "Build",
      expiresInSeconds: 120,
    }),
  });
  assert.deepEqual(created, {
    prompt: "Continue?",
    type: "yes_no",
    title: "Build",
    expiresInSeconds: 120,
  });
  assert.deepEqual(waits, [20]);
  assert.deepEqual(output.data, {
    interaction: { id: "int_1", state: "yes" },
    eventId: "ntf_created_123456",
    delivery: DELIVERY,
    queued: 0,
    replayed: false,
  });
});

test("notify ask wait preserves creation proof when the canonical wait response is bare", async () => {
  let now = 0;
  const output = await execute(
    ["notify", "ask", "Continue?", "--approval", "--wait", "--timeout", "1m"],
    {
      ...overrides({
        createInteraction: async () => ({
          interaction: { id: "int_bare_123456", state: "pending" },
          eventId: "ntf_bare_123456",
          delivery: DELIVERY,
          queued: 0,
          replayed: true,
        }),
        waitForInteraction: async (_id, timeoutSeconds) => {
          now += timeoutSeconds * 1_000;
          return { id: "int_bare_123456", state: "approved", respondedAt: "2026-08-07T00:00:00.000Z" };
        },
      }),
      now: () => now,
    },
  );
  assert.deepEqual(output.data, {
    interaction: {
      id: "int_bare_123456",
      state: "approved",
      respondedAt: "2026-08-07T00:00:00.000Z",
    },
    eventId: "ntf_bare_123456",
    delivery: DELIVERY,
    queued: 0,
    replayed: true,
  });
});

test("notify ask terminal JSON retains complete creation proof without changing nonzero exits", async () => {
  const creation = {
    interaction: { id: "int_terminal_123456", state: "pending" },
    eventId: "ntf_terminal_123456",
    liveActivityId: "act_terminal_123456",
    delivery: DELIVERY,
    queued: 0,
    replayed: true,
  };
  const cases = [
    { name: "denial", state: "denied", expectedExit: EXIT.NEGATIVE, argv: ["--wait", "--timeout", "1s"] },
    { name: "no", state: "no", expectedExit: EXIT.NEGATIVE, argv: ["--wait", "--timeout", "1s"] },
    { name: "canceled", state: "canceled", expectedExit: EXIT.TERMINAL, argv: ["--wait", "--timeout", "1s"] },
    { name: "expired", state: "expired", expectedExit: EXIT.TERMINAL, argv: ["--wait", "--timeout", "1s"] },
    { name: "pending poll", state: "pending", expectedExit: EXIT.TERMINAL, argv: ["--poll"] },
    { name: "timeout", state: "pending", expectedExit: EXIT.TERMINAL, argv: ["--wait", "--timeout", "1s"] },
  ];
  for (const entry of cases) {
    let now = 0;
    const stdout = [];
    const stderr = [];
    const canonical = {
      id: creation.interaction.id,
      state: entry.state,
      response: entry.state === "no" ? false : null,
      respondedAt: entry.state === "pending" ? null : "2026-08-07T00:00:00.000Z",
    };
    const exitCode = await run(
      [
        "notify", "ask", `Terminal ${entry.name}?`, "--approval", "--live-activity",
        ...entry.argv, "--json",
      ],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      {
        ...overrides({
          createInteraction: async () => creation,
          waitForInteraction: async (_id, timeoutSeconds) => {
            now += timeoutSeconds * 1_000;
            return { interaction: canonical };
          },
        }),
        now: () => now,
      },
    );
    assert.equal(exitCode, entry.expectedExit, entry.name);
    assert.equal(stderr.length, 1, entry.name);
    const envelope = JSON.parse(stdout[0]);
    assert.equal(envelope.ok, false, entry.name);
    assert.deepEqual(envelope.error.details.result, {
      ...creation,
      interaction: canonical,
    }, entry.name);
    assert.equal(
      envelope.error.details.state,
      entry.state === "pending" ? "timeout" : entry.state,
      entry.name,
    );
  }
});

test("approval is the default interactive Live Activity style", async () => {
  let created;
  await execute(
    ["notify", "ask", "Continue?", "--approval", "--live-activity"],
    overrides({
      createInteraction: async (body) => {
        created = body;
        return {
          interaction: { id: "int_default_style_123456", state: "pending" },
          delivery: DELIVERY,
        };
      },
    }),
  );
  assert.equal(created.style, "approval");
});

test("creates an interactive Live Activity ask and returns its activity ID", async () => {
  let created;
  const output = await execute(
    [
      "notify",
      "ask",
      "Send the prepared release email?",
      "--approval",
      "--title",
      "Release",
      "--live-activity",
      "--style",
      "signal",
      "--primary-label",
      "Send",
      "--secondary-label",
      "Deny",
    ],
    overrides({
      createInteraction: async (body) => {
        created = body;
        return {
          interaction: { id: "int_live_123456", state: "pending" },
          liveActivityId: "act_live_123456",
          delivery: DELIVERY,
        };
      },
    }),
  );
  assert.deepEqual(created, {
    prompt: "Send the prepared release email?",
    type: "approval",
    title: "Release",
    expiresInSeconds: 900,
    presentation: "live_activity",
    style: "signal",
    primaryLabel: "Send",
    secondaryLabel: "Deny",
  });
  assert.equal(output.data.liveActivityId, "act_live_123456");
});

test("merges stdin Live Activity fields and preserves its activity ID after waiting", async () => {
  let now = 0;
  let created;
  const output = await execute(
    ["notify", "ask", "--stdin", "--yes-no", "--primary-label", "Proceed", "--wait"],
    {
      ...overrides({
        createInteraction: async (body) => {
          created = body;
          return {
            interaction: { id: "int_live_123456", state: "pending" },
            liveActivityId: "act_live_123456",
            delivery: DELIVERY,
          };
        },
        waitForInteraction: async (_id, timeoutSeconds) => {
          now += timeoutSeconds * 1_000;
          return { interaction: { id: "int_live_123456", state: "yes" } };
        },
      }),
      now: () => now,
      readStdinJson: async () => ({
        prompt: "Continue deployment?",
        type: "approval",
        presentation: "live_activity",
        style: "verdict",
        primaryLabel: "Allow",
        secondaryLabel: "Stop",
        expiresInSeconds: 600,
      }),
    },
  );
  assert.deepEqual(created, {
    prompt: "Continue deployment?",
    type: "yes_no",
    expiresInSeconds: 600,
    presentation: "live_activity",
    style: "verdict",
    primaryLabel: "Proceed",
    secondaryLabel: "Stop",
  });
  assert.equal(output.data.interaction.state, "yes");
  assert.equal(output.data.liveActivityId, "act_live_123456");
  assert.deepEqual(output.data.delivery, DELIVERY);
});

test("rejects unsupported interactive Live Activity ask shapes before the API call", async () => {
  const rejects = async (argv, pattern, stdin) => {
    let called = false;
    await assert.rejects(
      execute(argv, {
        ...overrides({
          createInteraction: async () => {
            called = true;
            return { delivery: DELIVERY };
          },
        }),
        ...(stdin ? { readStdinJson: async () => stdin } : {}),
      }),
      pattern,
    );
    assert.equal(called, false);
  };
  await rejects(
    ["notify", "ask", "Reply", "--text", "--live-activity"],
    /supports --approval or --yes-no/,
  );
  await rejects(
    ["notify", "ask", "Deploy?", "--approval", "--style", "signal"],
    /style requires --live-activity/,
  );
  await rejects(
    ["notify", "ask", "Deploy?", "--approval", "--primary-label", "Deploy"],
    /labels require --live-activity/,
  );
  await rejects(
    ["notify", "ask", "Deploy?", "--approval", "--live-activity", "--style", "neon"],
    /approval, shell, verdict, signal/,
  );
  await rejects(
    ["notify", "ask", "Deploy?", "--approval", "--live-activity", "--expires-in", "9h"],
    /between 30s and 28800s/,
  );
  await rejects(
    ["notify", "ask", "x".repeat(241), "--approval", "--live-activity"],
    /at most 240 characters/,
  );
  await rejects(
    ["notify", "ask", "Deploy?", "--approval", "--live-activity", "--primary-label", "x".repeat(25)],
    /at most 24 characters/,
  );
  await rejects(
    ["notify", "ask", "Deploy?", "--approval", "--live-activity", "--primary-label", "Run\nNow"],
    /single line/,
  );
  await rejects(
    ["notify", "ask", "--approval", "--stdin"],
    /presentation must be/,
    { prompt: "Deploy?", presentation: "dynamic_island" },
  );
});

test("rejects ambiguous ask selectors and timeout without wait", async () => {
  await assert.rejects(
    execute(["notify", "ask", "Question?", "--approval", "--text"], overrides({})),
    /exactly one ask response selector/,
  );
  await assert.rejects(
    execute(["notify", "ask", "Question?", "--approval", "--timeout", "1m"], overrides({})),
    /--timeout requires --wait/,
  );
  await assert.rejects(
    execute(["notify", "ask", "Question?", "--approval", "--poll", "--wait"], overrides({})),
    /--poll cannot be combined/,
  );
});

test("merges activity stdin with explicit flags taking precedence", async () => {
  let start;
  let update;
  let end;
  const client = {
    startActivity: async (body) => {
      start = body;
      return DELIVERY;
    },
    updateActivity: async (_id, body) => {
      update = body;
      return DELIVERY;
    },
    endActivity: async (_id, body) => {
      end = body;
      return DELIVERY;
    },
  };
  await execute(["activity", "start", "--title", "Flag title", "--stdin"], {
    ...overrides(client),
    readStdinJson: async () => ({
      name: "build-main",
      title: "stdin title",
      status: "Starting",
      progress: 0.1,
      style: "standard",
    }),
  });
  await execute(["activity", "update", "act_123456789012", "--status", "Flag status", "--stdin"], {
    ...overrides(client),
    readStdinJson: async () => ({ status: "stdin status", detail: null, progress: null, ifSequence: 2 }),
  });
  await execute(["activity", "end", "act_123456789012", "--clear-detail", "--stdin"], {
    ...overrides(client),
    readStdinJson: async () => ({ status: "Complete", detail: "stdin detail", dismissAfterSeconds: 15 }),
  });
  assert.deepEqual(start, {
    key: "build-main",
    replace: false,
    title: "Flag title",
    status: "Starting",
    progress: 0.1,
    style: "standard",
    expiresInSeconds: 28_800,
    staleAfterSeconds: 14_400,
  });
  assert.deepEqual(update, {
    status: "Flag status",
    detail: null,
    progress: null,
    ifSequence: 2,
  });
  assert.deepEqual(end, {
    status: "Complete",
    detail: null,
    symbol: "success",
    dismissAfterSeconds: 15,
  });
});

test("ensures and reconciles one lifecycle through an opaque origin",async () => {
  const origin = {
    sourceInstance: "codex-installation",project: "relo",
    thread: "opaque-thread",channel: "task-progress",
  };
  const activity = { id: "act_123456789012",generation: 2,sequence: 4,state: "active" };
  const calls = [];
  const client = {
    startActivity: async (body,key) => {
      calls.push(["ensure",body,key]);
      return { activity,delivery: DELIVERY,replayed: false,reused: true,resumed: false };
    },
    resolveActivity: async (value) => {
      calls.push(["resolve",value]);
      return { found: true,activity };
    },
    updateActivity: async (id,body,key) => {
      calls.push(["update",id,body,key]);
      return { activity: { ...activity,sequence: 5 },delivery: DELIVERY };
    },
    endActivity: async (id,body,key) => {
      calls.push(["end",id,body,key]);
      return { activity: { ...activity,state: "ended",sequence: 5 },delivery: DELIVERY };
    },
  };
  const ensure = await execute(["activity","ensure","--stdin","--idempotency-key","codex-start"],{
    ...overrides(client),readStdinJson: async () => ({ origin,title: "Codex task",status: "Starting" }),
  });
  const status = await execute(["activity","status","--stdin"],{
    ...overrides(client),readStdinJson: async () => ({ origin }),
  });
  await execute(["activity","update","--stdin","--idempotency-key","codex-progress"],{
    ...overrides(client),readStdinJson: async () => ({ origin,status: "Verifying" }),
  });
  await execute(["activity","end","--stdin","--idempotency-key","codex-end"],{
    ...overrides(client),readStdinJson: async () => ({ origin,status: "Complete" }),
  });
  assert.equal(ensure.command,"activity.ensure");
  assert.equal(status.command,"activity.status");
  assert.deepEqual(calls,[
    ["ensure",{
      acquireMode: "ensure",replace: false,title: "Codex task",status: "Starting",expiresInSeconds: 28_800,
      staleAfterSeconds: 14_400,origin,
    },"codex-start"],
    ["resolve",{ origin }],
    ["resolve",{ origin }],
    ["update",activity.id,{ status: "Verifying" },"codex-progress"],
    ["resolve",{ origin }],
    ["end",activity.id,{ status: "Complete",symbol: "success",dismissAfterSeconds: 300 },"codex-end"],
  ]);
});

test("manual ensure can use server-owned current selection or an explicit stable key",async () => {
  const calls = [];
  const client = {
    startActivity: async (body,key) => {
      calls.push([body,key]);
      return { activity: { id: "act_123456789012",sequence: 0,state: "active" },delivery: DELIVERY };
    },
  };
  await execute([
    "activity","ensure","--name","manual-run","--title","Manual task","--status","Starting",
    "--thread-name","Release verification","--task-title","Verify manual separation",
    "--idempotency-key","manual-ensure-key",
  ],overrides(client));
  assert.deepEqual(calls,[
    [{
      key: "manual-run",replace: false,acquireMode: "ensure",title: "Manual task",status: "Starting",
      expiresInSeconds: 28_800,staleAfterSeconds: 14_400,
      context: { threadName: "Release verification",taskTitle: "Verify manual separation" },
    },"manual-ensure-key"],
  ]);
  await execute(
    ["activity","ensure","--title","Current task","--status","Working"],
    overrides(client),
  );
  assert.deepEqual(calls[1][0],{
    acquireMode: "ensure",replace: false,title: "Current task",status: "Working",
    expiresInSeconds: 28_800,staleAfterSeconds: 14_400,
  });
  await assert.rejects(
    execute(["activity","ensure","--name","manual-run","--stdin"],{
      ...overrides(client),readStdinJson: async () => ({
        origin: { sourceInstance: "codex",project: "relo",thread: "thread",channel: "task" },
        title: "Ambiguous",status: "Starting",
      }),
    }),
    /lifecycle origin or a manual key, not both/,
  );
  await assert.rejects(
    execute(["activity","ensure","--name","one","--stdin"],{
      ...overrides(client),readStdinJson: async () => ({ name: "two",title: "Ambiguous",status: "Starting" }),
    }),
    /only one of --name or stdin name/,
  );
});

test("activity status accepts a human-readable name while retaining server current as the default",async () => {
  const calls = [];
  const client = {
    getActivity: async (target) => { calls.push(["get",target]); return { activity: { id: "act_named",key: target } }; },
    resolveActivity: async (resolver) => { calls.push(["resolve",resolver]); return { found: true,activity: { id: "act_current" } }; },
  };
  await execute(["activity","status","--name","release-build"],overrides(client));
  await execute(["activity","status"],overrides(client));
  assert.deepEqual(calls,[["get","release-build"],["resolve",{ current: true }]]);
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

test("resolves exact provider-run lifecycle coverage independently of origin history",async () => {
  const lifecycle = { provider: "codex",runId: "codex-run-123" };
  const activity = { id: "act_123456789012",generation: 3,sequence: 2,state: "active" };
  const calls = [];
  const client = {
    startActivity: async (body) => { calls.push(["ensure",body]); return { activity,delivery: DELIVERY }; },
    resolveActivity: async (resolver) => { calls.push(["resolve",resolver]); return { found: true,activity }; },
    heartbeatActivity: async (id,body) => { calls.push(["heartbeat",id,body]); return { activity,renewed: true }; },
    updateActivity: async (id,body) => { calls.push(["update",id,body]); return { activity,delivery: DELIVERY }; },
    endActivity: async (id,body) => { calls.push(["end",id,body]); return { activity,delivery: DELIVERY }; },
  };
  await execute(["activity","ensure","--stdin"],{
    ...overrides(client),readStdinJson: async () => ({
      lifecycle,origin: {
        sourceInstance: "codex-installation",project: "relo",thread: "opaque-thread",channel: "task-progress",
      },title: "Codex task",status: "Planning",
    }),
  });
  await execute(["activity","status","--stdin"],{
    ...overrides(client),readStdinJson: async () => ({ lifecycle }),
  });
  const heartbeat = await execute(["activity","heartbeat","--stdin","--lease-after","2h"],{
    ...overrides(client),readStdinJson: async () => ({ lifecycle }),
  });
  await execute(["activity","update","--stdin"],{
    ...overrides(client),readStdinJson: async () => ({ lifecycle,status: "Working" }),
  });
  await execute(["activity","end","--stdin"],{
    ...overrides(client),readStdinJson: async () => ({ lifecycle,status: "Complete" }),
  });
  assert.deepEqual(calls[0][1].lifecycle,lifecycle);
  assert.equal(heartbeat.command,"activity.heartbeat");
  assert.deepEqual(calls.slice(1).map((call) => call[1]),[
    { lifecycle },{ lifecycle },activity.id,{ lifecycle },activity.id,{ lifecycle },activity.id,
  ]);
  assert.deepEqual(calls[3][2],{ lifecycle,leaseAfterSeconds: 7_200 });
  assert.deepEqual(calls[5][2],{ lifecycle,status: "Working" });
  assert.deepEqual(calls[7][2],{
    lifecycle,status: "Complete",symbol: "success",dismissAfterSeconds: 300,
  });
});

test("status, update, and end use the server-owned current activity without a local handle",async () => {
  const calls = [];
  const activity = { id: "act_123456789012",generation: 1,sequence: 3,state: "active" };
  const client = {
    resolveActivity: async (resolver) => { calls.push(["resolve",resolver]); return { found: true,activity }; },
    updateActivity: async (target,body) => { calls.push(["update",target,body]); return { activity,delivery: DELIVERY }; },
    endActivity: async (target,body) => { calls.push(["end",target,body]); return { activity,delivery: DELIVERY }; },
  };
  await execute(["activity","status"],overrides(client));
  await execute(["activity","update","--status","Testing","--progress","0.6"],overrides(client));
  await execute(["activity","end","--dismiss-after","30s"],overrides(client));
  assert.deepEqual(calls,[
    ["resolve",{ current: true }],
    ["update","current",{ status: "Testing",progress: 0.6 }],
    ["end","current",{ status: "Complete",symbol: "success",dismissAfterSeconds: 30 }],
  ]);
});

test("supports full activity fields, key addressing, and clearable progress", async () => {
  const calls = [];
  const client = {
    startActivity: async (body) => {
      calls.push(["start", body]);
      return DELIVERY;
    },
    updateActivity: async (target, body) => {
      calls.push(["update", target, body]);
      return DELIVERY;
    },
    endActivity: async (target, body) => {
      calls.push(["end", target, body]);
      return DELIVERY;
    },
    getActivity: async (target) => {
      calls.push(["get", target]);
      return { activity: { id: "act_123456789012", key: target } };
    },
  };
  await execute(["activity", "start", "--stdin"], {
    ...overrides(client),
    readStdinJson: async () => ({
      name: "deploy-main",
      replace: true,
      title: "Deploy",
      status: "Starting",
      detail: "Production",
      progress: 0,
      symbol: "build",
      style: "hero",
      accentColor: "#aBc123",
      expiresInSeconds: 600,
      staleAfterSeconds: 120,
      context: { computer: "Mac", project: "Relo", taskTitle: "Deploy task" },
    }),
  });
  await execute(
    [
      "activity",
      "update",
      "deploy-main",
      "--title",
      "Deploying",
      "--style",
      "steps",
      "--clear-progress",
      "--if-sequence",
      "1",
    ],
    overrides(client),
  );
  await execute(
    ["activity", "end", "deploy-main", "--clear-progress", "--if-sequence", "2"],
    overrides(client),
  );
  await execute(["activity", "get", "deploy-main"], overrides(client));

  assert.deepEqual(calls[0][1], {
    key: "deploy-main",
    replace: true,
    title: "Deploy",
    status: "Starting",
    detail: "Production",
    progress: 0,
    symbol: "build",
    style: "hero",
    accentColor: "#aBc123",
    expiresInSeconds: 600,
    staleAfterSeconds: 120,
    context: { computer: "Mac", project: "Relo", taskTitle: "Deploy task" },
  });
  assert.deepEqual(calls[1], [
    "update",
    "deploy-main",
    {
      title: "Deploying",
      progress: null,
      style: "steps",
      ifSequence: 1,
    },
  ]);
  assert.deepEqual(calls[2], [
    "end",
    "deploy-main",
    {
      status: "Complete",
      progress: null,
      symbol: "success",
      dismissAfterSeconds: 300,
      ifSequence: 2,
    },
  ]);
  assert.deepEqual(calls[3], ["get", "deploy-main"]);

  await assert.rejects(
    execute(["activity", "update", "deploy-main", "--if-sequence", "3"], overrides(client)),
    /requires at least one changed field/,
  );
  await assert.rejects(
    execute(
      [
        "activity",
        "start",
        "--title",
        "No",
        "--privacy",
        "private",
      ],
      overrides(client),
    ),
    /not valid for this command/,
  );
});

test("creates and lists services with canonical request fields", async () => {
  let created;
  const listed = {
    services: [
      {
        id: "svc_123456789012",
        title: "Builds",
        imageUrl: "https://example.test/bot.png",
        destinationUrl: "https://example.test/builds",
        prefix: "hook_example",
        createdAt: "2026-08-07T00:00:00.000Z",
        updatedAt: "2026-08-07T00:00:00.000Z",
      },
    ],
  };
  const client = {
    createService: async (body) => {
      created = body;
      return { service: listed.services[0], webhookUrl: "https://secret.invalid/hooks/hook_redacted" };
    },
    listServices: async () => listed,
  };
  const createdOutput = await execute(["services", "create", "--title", "Builds", "--stdin"], {
    ...overrides(client),
    readStdinJson: async () => ({
      title: "stdin title",
      imageUrl: "https://example.test/bot.png",
      url: "https://example.test/builds",
    }),
  });
  const listedOutput = await execute(["services", "list"], overrides(client));
  assert.deepEqual(created, {
    title: "Builds",
    imageUrl: "https://example.test/bot.png",
    destinationUrl: "https://example.test/builds",
  });
  assert.equal(createdOutput.data.service.id, "svc_123456789012");
  assert.equal(createdOutput.data.webhookUrl, "https://secret.invalid/hooks/hook_redacted");
  assert.deepEqual(listedOutput.data, listed);
});

test("service secret-file output is exclusive, private, durable, and secret-free", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relo-service-secret-"));
  const secretPath = join(directory, "builds.webhook");
  const secret = "https://server.example.test/hooks/hook_supersecretvalue";
  const created = {
    service: { id: "svc_123456789012", title: "Builds", prefix: "hook_super" },
    webhookUrl: secret,
  };
  try {
    const stdout = [];
    const stderr = [];
    const exitCode = await run(
      ["services", "create", "--title", "Builds", "--secret-file", secretPath, "--json"],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      overrides({ createService: async () => created }),
    );
    assert.equal(exitCode, EXIT.OK);
    assert.equal(await readFile(secretPath, "utf8"), secret);
    if (process.platform !== "win32") assert.equal((await stat(secretPath)).mode & 0o777, 0o600);
    assert.equal(stdout.join("\n").includes(secret), false);
    assert.equal(stderr.join("\n").includes(secret), false);
    assert.deepEqual(JSON.parse(stdout[0]).data, {
      service: created.service,
      secretFileWritten: true,
      secretFileName: "builds.webhook",
    });
    assert.equal((await readdir(directory)).some((name) => name.endsWith(".tmp")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("service secret-file refuses existing regular, symlink, and non-regular targets before creation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relo-service-refuse-"));
  let creates = 0;
  const client = {
    createService: async () => {
      creates += 1;
      return { service: { id: "svc_never" }, webhookUrl: "https://secret.invalid/hooks/never" };
    },
  };
  try {
    const regular = join(directory, "existing");
    const linked = join(directory, "linked");
    const folder = join(directory, "folder");
    await writeFile(regular, "sentinel", { mode: 0o600 });
    await symlink(regular, linked);
    await mkdir(folder);
    for (const path of [regular, linked, folder]) {
      await assert.rejects(
        execute(["services", "create", "--title", "No", "--secret-file", path], overrides(client)),
        /Refusing to overwrite/,
      );
    }
    assert.equal(creates, 0);
    assert.equal(await readFile(regular, "utf8"), "sentinel");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("racing service secret-file writers publish once and clean temporary files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relo-service-race-"));
  const path = join(directory, "service.url");
  let creates = 0;
  const client = {
    createService: async () => {
      creates += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return {
        service: { id: "svc_race" },
        webhookUrl: "https://secret.invalid/hooks/race-secret",
      };
    },
  };
  try {
    const results = await Promise.allSettled([
      execute(["services", "create", "--title", "Race", "--secret-file", path], overrides(client)),
      execute(["services", "create", "--title", "Race", "--secret-file", path], overrides(client)),
    ]);
    assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(results.filter((item) => item.status === "rejected").length, 1);
    assert.equal(creates, 1);
    assert.equal(await readFile(path, "utf8"), "https://secret.invalid/hooks/race-secret");
    assert.equal((await readdir(directory)).some((name) => name.endsWith(".tmp") || name.endsWith(".lock")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("destination reservation blocks a noncooperating external creator during the API call", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relo-service-external-race-"));
  const path = join(directory, "service.url");
  const secret = "https://secret.invalid/hooks/external-race-secret";
  let externalError;
  try {
    const output = await execute(
      ["services", "create", "--title", "External race", "--secret-file", path],
      overrides({
        createService: async () => {
          try {
            await writeFile(path, "external", { flag: "wx", mode: 0o600 });
          } catch (error) {
            externalError = error;
          }
          return { service: { id: "svc_external" }, webhookUrl: secret };
        },
      }),
    );
    assert.equal(externalError?.code, "EEXIST");
    assert.equal(await readFile(path, "utf8"), secret);
    assert.equal(output.data.secretFileWritten, true);
    assert.equal(JSON.stringify(output).includes(secret), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a renamed-away reservation is refused, revoked, and never overwrites its replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relo-service-replaced-reservation-"));
  const path = join(directory, "service.url");
  const movedPath = join(directory, "renamed-reservation.url");
  let revoked;
  try {
    await assert.rejects(
      execute(
        ["services", "create", "--title", "Replaced", "--secret-file", path],
        overrides({
          createService: async () => {
            await rename(path, movedPath);
            await writeFile(path, "external sentinel", { flag: "wx", mode: 0o600 });
            return {
              service: { id: "svc_replaced" },
              webhookUrl: "https://secret.invalid/hooks/must-not-overwrite",
            };
          },
          revokeService: async (id) => { revoked = id; },
        }),
      ),
      /changed --secret-file reservation/,
    );
    assert.equal(revoked, "svc_replaced");
    assert.equal(await readFile(path, "utf8"), "external sentinel");
    assert.equal(await readFile(movedPath, "utf8"), "");
    assert.equal((await readdir(directory)).some((name) => name.endsWith(".tmp")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("service secret-file failures do not expose the webhook or leave partial files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relo-service-failure-"));
  const path = join(directory, "service.url");
  const secret = "hostilealphanumericsecret123456789";
  let revoked;
  try {
    const stdout = [];
    const stderr = [];
    const exitCode = await run(
      ["services", "create", "--title", "Broken", "--secret-file", path, "--json"],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      overrides({
        createService: async () => ({ service: { id: "svc_bad" }, webhookUrl: secret }),
        revokeService: async (id) => { revoked = id; },
      }),
    );
    assert.equal(exitCode, EXIT.API);
    assert.equal(stdout.join("\n").includes(secret), false);
    assert.equal(stderr.join("\n").includes(secret), false);
    assert.equal(revoked, "svc_bad");
    assert.equal(await readFile(path, "utf8"), "");
    assert.equal((await readdir(directory)).some((name) => name.endsWith(".tmp") || name.endsWith(".lock")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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

test("emits exact machine output and usage errors", async () => {
  const successStdout = [];
  const successStderr = [];
  const successExit = await run(
    ["services", "list", "--json"],
    { stdout: (line) => successStdout.push(line), stderr: (line) => successStderr.push(line) },
    overrides({ listServices: async () => ({ services: [] }) }),
  );
  assert.equal(successExit, EXIT.OK);
  assert.deepEqual(successStdout, ['{"ok":true,"command":"services.list","data":{"services":[]}}']);
  assert.deepEqual(successStderr, []);

  const errorStdout = [];
  const errorStderr = [];
  const errorExit = await run(
    ["notify", "ask", "Continue?", "--approval", "--timeout", "1m", "--json"],
    { stdout: (line) => errorStdout.push(line), stderr: (line) => errorStderr.push(line) },
    overrides({}),
  );
  assert.equal(errorExit, EXIT.USAGE);
  assert.deepEqual(errorStdout, [
    '{"ok":false,"error":{"code":"USAGE_ERROR","message":"--timeout requires --wait"}}',
  ]);
  assert.deepEqual(errorStderr, ["USAGE_ERROR: --timeout requires --wait"]);
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
  assert.equal(seen.body.sourceName, "Relo");
  assert.equal(seen.body.title, "CI");
  assert.deepEqual(seen.body.context, {
    computer: "MacBook",
    project: "Relo notifications",
    taskTitle: "Finish notification lifecycle",
  });
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
  const help = await execute(["--help"]);
  assert.match(help.data.help, /Supplied idempotency keys use 1-200 characters/);
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
    if (expected !== EXIT.OK) assert.equal(stderr.length, 1);
  };
  let now = 0;
  await stateCase("approved", EXIT.OK);
  await stateCase("yes", EXIT.OK);
  await stateCase("replied", EXIT.OK);
  await stateCase("denied", EXIT.NEGATIVE);
  await stateCase("no", EXIT.NEGATIVE);
  await stateCase("expired", EXIT.TERMINAL);
  await stateCase("canceled", EXIT.TERMINAL);
  await stateCase("pending", EXIT.TERMINAL);
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
    '{"ok":true,"command":"interaction.cancel","data":{"interaction":{"id":"int_123456789012","state":"canceled","action":null,"response":null}}}',
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
    assert.equal(stderr.length, 1);
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

test("enriches the current activity with safe thread and work context", async () => {
  let update;
  await execute(
    [
      "activity",
      "update",
      "--status",
      "Implementing",
      "--computer",
      "developer-mac-codex",
      "--project",
      "Relo notifications",
      "--thread-name",
      "Dashboard lifecycle audit",
      "--task-title",
      "Correct activity lifecycle history",
    ],
    overrides({
      updateActivity: async (id, body) => {
        update = { id,body };
        return { activity: { id: "act_123456789012" },delivery: DELIVERY };
      },
    }),
  );
  assert.equal(update.id, "current");
  assert.deepEqual(update.body.context, {
    computer: "developer-mac-codex",
    project: "Relo notifications",
    threadName: "Dashboard lifecycle audit",
    taskTitle: "Correct activity lifecycle history",
  });
  assert.equal(update.body.progress, undefined);
});

test("keeps interaction expiry independent and repeats capped waits through the caller deadline", async () => {
  let now = 0;
  let created;
  const waits = [];
  const output = await execute(
    [
      "notify",
      "ask",
      "Continue?",
      "--type",
      "approval",
      "--expires-in",
      "2m",
      "--timeout",
      "10m",
      "--wait",
    ],
    {
      ...overrides({
        createInteraction: async (body) => {
          created = body;
          return { interaction: { id: "int_1", state: "pending" }, delivery: DELIVERY };
        },
        waitForInteraction: async (_id, timeoutSeconds) => {
          waits.push(timeoutSeconds);
          now += timeoutSeconds * 1_000;
          return {
            interaction: {
              id: "int_1",
              state: waits.length === 2 ? "approved" : "pending",
            },
          };
        },
      }),
      now: () => now,
      generateIdempotencyKey: () => "12345678-1234-1234-1234-123456789abc",
    },
  );
  assert.equal(created.expiresInSeconds, 120);
  assert.deepEqual(waits, [300, 300]);
  assert.equal(output.data.interaction.state, "approved");
});

test("rejects malformed and unknown target devices before a mutation", async () => {
  let listed = 0;
  let mutated = 0;
  const client = {
    listDevices: async () => {
      listed += 1;
      return { devices: [{ deviceId: TARGET_DEVICE }], cursor: null, hasMore: false };
    },
    sendNotification: async () => {
      mutated += 1;
      return DELIVERY;
    },
  };
  await assert.rejects(
    execute(["notify", "send", "Done", "--device", "dev_bad"], overrides(client)),
    /Malformed target device/,
  );
  assert.equal(listed, 0);
  await assert.rejects(
    execute(
      ["notify", "send", "Done", "--device", "dev_999999999999"],
      overrides(client),
    ),
    /Unknown target device/,
  );
  assert.equal(listed, 1);
  assert.equal(mutated, 0);
});

test("emits the frozen notification and activity-update contract shapes", async () => {
  let notification;
  let start;
  let update;
  let end;
  const client = {
    listDevices: async () => ({
      devices: [{ deviceId: TARGET_DEVICE }], cursor: null, hasMore: false,
    }),
    sendNotification: async (body) => {
      notification = body;
      return { ...CONTRACT_FIXTURE.delivery };
    },
    startActivity: async (body) => {
      start = body;
      return { ...CONTRACT_FIXTURE.delivery };
    },
    updateActivity: async (_id, body) => {
      update = body;
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
      "start",
      "--name",
      "codex-build",
      "--replace",
      "--title",
      "Build",
      "--status",
      "Starting",
      "--progress",
      "0",
      "--symbol",
      "build",
      "--style",
      "terminal",
      "--accent-color",
      "#5ED8B7",
      "--expires-in",
      "8h",
      "--stale-after",
      "4h",
      "--device",
      TARGET_DEVICE,
    ],
    overrides(client),
  );
  await execute(
    [
      "activity",
      "update",
      "act_123456789012",
      "--title",
      "Build and test",
      "--status",
      "Running tests",
      "--progress",
      "0.5",
      "--symbol",
      "code",
      "--accent-color",
      "#64D2FF",
      "--stale-after",
      "1h",
      "--if-sequence",
      "0",
    ],
    overrides(client),
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
  assert.deepEqual(notification, CONTRACT_FIXTURE.notification);
  assert.deepEqual(start, CONTRACT_FIXTURE.activityStart);
  assert.deepEqual(update, CONTRACT_FIXTURE.activityUpdate);
  assert.deepEqual(end, CONTRACT_FIXTURE.activityEnd);
  await assert.rejects(
    execute(
      ["activity", "update", "act_123456789012", "--status", "Done", "--sequence", "2"],
      overrides(client),
    ),
    /Unknown option: --sequence/,
  );
});

test("permissions setup, doctor, and uninstall round-trip through an explicit temporary home", async () => {
  const home = await mkdtemp(join(tmpdir(), "relo-permissions-cli-"));
  const client = {
    authStatus: async () => ({
      authenticated: true,
      credential: { scopes: CONFIG.principal.scopes },
    }),
    ready: async () => ({ ready: true, status: "ready" }),
  };
  const options = {
    ...overrides(client),
    permissionsHome: home,
    nodePath: "/test/node",
    entrypoint: "/test/relo.mjs",
  };
  try {
    const setup = await execute(["permissions", "setup", "codex"], options);
    assert.equal(setup.exitCode, EXIT.OK);
    assert.equal(setup.data.targets[0].changed, true);

    const output = await execute(["permissions", "doctor", "codex"], options);
    assert.equal(output.exitCode, EXIT.OK);
    assert.equal(output.data.checks.scopes.ok, true);
    assert.equal(output.data.checks.server.ok, true);
    assert.equal(output.data.checks.hooks.ok, true);
    assert.equal(output.data.checks.hooks.targets[0].trust, "manual-review-required");

    const uninstall = await execute(["permissions", "uninstall", "codex"], options);
    assert.equal(uninstall.data.targets[0].removed, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("permissions setup all rolls back earlier adapters when OpenCode startup fails", async () => {
  const home = await mkdtemp(join(tmpdir(), "relo-permissions-rollback-"));
  const client = {
    authStatus: async () => ({ authenticated: true, credential: { scopes: CONFIG.principal.scopes } }),
    ready: async () => ({ ready: true }),
  };
  try {
    await assert.rejects(
      execute(["permissions", "setup", "all"], {
        ...overrides(client),
        permissionsHome: home,
        nodePath: "/test/node",
        entrypoint: "/test/relo.mjs",
        platform: "darwin",
        uid: 501,
        runPermissionCommand: async (_command, args) => {
          if (args[0] === "bootstrap") throw new Error("launchctl unavailable");
          if (args[0] === "print") throw new Error("not loaded");
        },
      }),
      (error) => error.code === "OPENCODE_BRIDGE_START_FAILED",
    );
    assert.equal(existsSync(join(home, ".codex", "hooks.json")), false);
    assert.equal(existsSync(join(home, ".claude", "settings.json")), false);
    assert.equal(
      existsSync(join(home, ".config", "opencode", "plugin", "relo-permissions-v1.js")),
      false,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("permissions setup and doctor all skip the macOS-only OpenCode bridge on Linux", async () => {
  const home = await mkdtemp(join(tmpdir(), "relo-permissions-linux-all-"));
  const client = {
    authStatus: async () => ({
      authenticated: true,
      credential: { scopes: CONFIG.principal.scopes },
    }),
    ready: async () => ({ ready: true, status: "ready" }),
  };
  const options = {
    ...overrides(client),
    permissionsHome: home,
    nodePath: "/test/node",
    entrypoint: "/test/relo.mjs",
    platform: "linux",
  };
  try {
    const setup = await execute(["permissions", "setup", "all"], options);
    assert.deepEqual(setup.data.targets.map((target) => target.target), ["codex", "claude"]);
    assert.deepEqual(setup.data.skipped, [
      {
        target: "opencode",
        reason: "OpenCode permission setup currently requires macOS.",
      },
    ]);
    const doctor = await execute(["permissions", "doctor"], options);
    assert.equal(doctor.exitCode, EXIT.OK);
    assert.deepEqual(
      doctor.data.checks.hooks.targets.map((target) => target.state),
      ["installed", "installed"],
    );
    assert.deepEqual(doctor.data.checks.hooks.skipped, setup.data.skipped);
    assert.equal(existsSync(join(home, "Library", "LaunchAgents")), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("permission setup rejects Windows before writing POSIX hook commands", async () => {
  const home = await mkdtemp(join(tmpdir(), "relo-permissions-windows-"));
  try {
    await assert.rejects(
      execute(["permissions", "setup", "codex"], {
        ...overrides({}),
        permissionsHome: home,
        platform: "win32",
      }),
      (error) => error.code === "UNSUPPORTED_PLATFORM",
    );
    assert.equal(existsSync(join(home, ".codex", "hooks.json")), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("permissions setup all preserves a concurrent user edit and reports partial recovery", async () => {
  const home = await mkdtemp(join(tmpdir(), "relo-permissions-concurrent-rollback-"));
  const codexPath = join(home, ".codex", "hooks.json");
  const userUpdate = `${JSON.stringify({ description: "concurrent user replacement" }, null, 2)}\n`;
  const client = {
    authStatus: async () => ({ authenticated: true, credential: { scopes: CONFIG.principal.scopes } }),
    ready: async () => ({ ready: true }),
  };
  try {
    await assert.rejects(
      execute(["permissions", "setup", "all"], {
        ...overrides(client),
        permissionsHome: home,
        nodePath: "/test/node",
        entrypoint: "/test/relo.mjs",
        platform: "darwin",
        uid: 501,
        runPermissionCommand: async (_command, args) => {
          if (args[0] === "bootstrap") {
            await writeFile(codexPath, userUpdate, { mode: 0o600 });
            throw new Error("launchctl unavailable");
          }
          if (args[0] === "print") throw new Error("not loaded");
        },
      }),
      (error) => {
        assert.equal(error.code, "PERMISSION_SETUP_ROLLBACK_FAILED");
        assert.equal(error.details.rollbackErrors[0].target, "codex");
        assert.equal(error.details.rollbackErrors[0].code, "CONFIGURATION_CHANGED");
        return true;
      },
    );
    assert.equal(await readFile(codexPath, "utf8"), userUpdate);
    assert.equal(existsSync(join(home, ".claude", "settings.json")), false);
    assert.equal(existsSync(join(home, ".config", "opencode", "plugin", "relo-permissions-v1.js")), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("auth status verifies the live credential and emits safe metadata", async () => {
  const output = await execute(
    ["auth", "status"],
    overrides({
      authStatus: async () => ({
        authenticated: true,
        credential: issuedCredential().credential,
        accessToken: "malicious-server-field-must-not-be-forwarded",
      }),
    }),
  );
  assert.equal(output.exitCode, EXIT.OK);
  assert.equal(output.data.authenticated, true);
  assert.equal("token" in output.data, false);
  assert.equal("accessToken" in output.data, false);
  assert.equal(JSON.stringify(output).includes(CONFIG.token), false);
  assert.equal(JSON.stringify(output).includes("malicious-server-field"), false);
});

test("auth logout removes local credentials when remote revocation is unconfirmed", async () => {
  let removed;
  const output = await execute(["auth", "logout"], {
    configPath: () => CONFIG.path,
    loadConfig: async () => CONFIG,
    clientFactory: () => ({
      revokeAuth: async () => {
        throw new NetworkError("offline");
      },
    }),
    removeConfig: async (path) => {
      removed = path;
      return true;
    },
  });
  assert.equal(output.exitCode, EXIT.OK);
  assert.equal(removed, CONFIG.path);
  assert.deepEqual(output.data, {
    authenticated: false,
    revoked: false,
    credentialsRemoved: true,
    serverRevocation: "unconfirmed",
    revocationError: "NETWORK_ERROR",
  });
});

test("separate hosts retain distinct browser-approved client identities", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relo-distinct-auth-"));
  const hosts = [
    {
      name: "MacBook Codex notifier",
      id: "key_macbook0001",
      token: `relo_${"m".repeat(43)}`,
    },
    {
      name: "Relo server Codex notifier",
      id: "key_server001",
      token: `relo_${"h".repeat(43)}`,
    },
  ];
  try {
    for (const [index, host] of hosts.entries()) {
      const path = join(directory, `host-${index}`, "config.json");
      let now = 0;
      const credential = {
        ...issuedCredential().credential,
        id: host.id,
        clientName: host.name,
      };
      const clientFactory = (config) => config.token
        ? {
            authStatus: async () => ({ authenticated: true, credential }),
          }
        : {
            startDeviceAuthorization: async (body) => {
              assert.equal(body.clientName, host.name);
              return authorizationStart();
            },
            pollDeviceAuthorization: async () => ({
              accessToken: host.token,
              credential,
            }),
          };
      const dependencies = {
        env: { RELO_API_URL: "http://192.168.1.10:8180" },
        configPath: () => path,
        clientFactory,
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
        stderr: () => {},
      };
      const loggedIn = await execute([
        "auth", "login", "--client-name", host.name,
        "--scope", "notifications:send",
        "--scope", "interactions:create",
        "--scope", "interactions:read",
        "--no-open",
      ], dependencies);
      assert.equal(loggedIn.data.credential.id, host.id);
      assert.equal(loggedIn.data.credential.clientName, host.name);
      assert.equal(JSON.stringify(loggedIn).includes(host.token), false);

      const status = await execute(["auth", "status"], dependencies);
      assert.equal(status.data.credential.id, host.id);
      assert.equal(status.data.credential.clientName, host.name);
      assert.equal(JSON.stringify(status).includes(host.token), false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("confirmed logout revokes once, removes the credential, and rejects post-logout auth", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relo-confirmed-logout-"));
  const path = join(directory, "config.json");
  let revocations = 0;
  let authenticatedCalls = 0;
  try {
    await writeFile(path, `${JSON.stringify({
      version: 1,
      apiUrl: CONFIG.apiUrl,
      token: CONFIG.token,
      principal: CONFIG.principal,
    })}\n`, { mode: 0o600 });
    const dependencies = {
      configPath: () => path,
      clientFactory: (config) => {
        assert.equal(config.token, CONFIG.token);
        return {
          revokeAuth: async () => {
            revocations += 1;
            return { revoked: true };
          },
          authStatus: async () => {
            authenticatedCalls += 1;
            return { authenticated: true, credential: issuedCredential().credential };
          },
        };
      },
    };
    const loggedOut = await execute(["auth", "logout"], dependencies);
    assert.deepEqual(loggedOut.data, {
      authenticated: false,
      revoked: true,
      credentialsRemoved: true,
      serverRevocation: "confirmed",
    });
    assert.equal(revocations, 1);

    const stdout = [];
    const stderr = [];
    const postLogout = await run(
      ["auth", "status", "--json"],
      { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
      dependencies,
    );
    assert.equal(postLogout, EXIT.AUTH);
    assert.equal(stdout.length, 1);
    assert.equal(JSON.parse(stdout[0]).error.code, "CONFIG_NOT_FOUND");
    assert.equal(authenticatedCalls, 0);
    assert.equal(JSON.stringify({ stdout, stderr }).includes(CONFIG.token), false);

    const repeated = await execute(["auth", "logout"], dependencies);
    assert.deepEqual(repeated.data, {
      authenticated: false,
      revoked: false,
      credentialsRemoved: false,
      alreadyLoggedOut: true,
    });
    assert.equal(revocations, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
