import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  apiTokenScopeSchema,
  inboxPageSchema,
  inboxLiveActivitySchema,
  inboxHistoryPageSchema,
  inboxHistoryQuerySchema,
  interactionResponseSchema,
  liveActivityStartRequestSchema,
  liveActivityEndRequestSchema,
  liveActivityUpdateRequestSchema,
  deliverySummarySchema,
  notificationRequestSchema,
  operationHeadersSchema,
  serviceCreateRequestSchema,
  serviceCreateResponseSchema,
  publicHttpsUrlSchema,
  interactionResultResponseSchema,
  liveActivityUpdateTokenRequestSchema,
  liveActivityResolveRequestSchema,
  liveActivityResolveResponseSchema,
  taskLiveActivityMutationResponseSchema,
  DELIVERY_EVIDENCE_STAGES,
  DELIVERY_EVIDENCE_STAGE_ORDER,
  deliveryEvidenceResponseSchema,
} from "../src/index.js";

test("delivery evidence vocabulary and golden fixture remain versioned and strictly ordered", () => {
  assert.deepEqual(DELIVERY_EVIDENCE_STAGES,[
    "accepted","canonicalized","queued","attempted","provider_accepted","provider_rejected",
    "provider_ambiguous","device_applied","device_received","opened","responded","withdrawn",
    "reconciled",
  ]);
  assert.deepEqual(DELIVERY_EVIDENCE_STAGES.map((stage) => DELIVERY_EVIDENCE_STAGE_ORDER[stage]),
    [10,20,30,40,50,60,70,80,90,100,110,120,130]);
  const fixture = JSON.parse(readFileSync(
    new URL("../fixtures/delivery-evidence-v1.json",import.meta.url),"utf8",
  ));
  assert.equal(deliveryEvidenceResponseSchema.parse(fixture).version,1);
  const iosFixture = JSON.parse(readFileSync(new URL(
    "../../../apps/ios/Tests/ReloCoreTests/Fixtures/delivery-evidence-v1.json",
    import.meta.url,
  ),"utf8"));
  assert.deepEqual(iosFixture,fixture);
});

test("agent scopes use the stable least-privilege vocabulary", () => {
  assert.equal(apiTokenScopeSchema.parse("notifications:send"), "notifications:send");
  assert.equal(apiTokenScopeSchema.parse("services:read"), "services:read");
  assert.equal(apiTokenScopeSchema.safeParse("notifications:write").success, false);
});

test("service and interaction result envelopes are strict and safe", () => {
  const serviceInput = serviceCreateRequestSchema.parse({
    title: "Builds",
    imageUrl: "https://example.test/builds.png",
    destinationUrl: "https://example.test/builds",
  });
  assert.equal(serviceInput.title, "Builds");
  serviceCreateResponseSchema.parse({
    service: {
      id: "svc_123456789012",
      title: serviceInput.title,
      imageUrl: serviceInput.imageUrl,
      destinationUrl: serviceInput.destinationUrl,
      prefix: "hook_preview",
      createdAt: "2026-08-07T00:00:00.000Z",
      updatedAt: "2026-08-07T00:00:00.000Z",
    },
    webhookUrl: "https://relo.example/hooks/hook_secret",
  });
  interactionResultResponseSchema.parse({ interaction: {
    id: "int_123456789012",
    eventId: "ntf_123456789012",
    type: "approval",
    prompt: "Continue?",
    state: "pending",
    action: null,
    response: null,
    respondingDevice: null,
    expiresAt: "2026-08-07T00:15:00.000Z",
    respondedAt: null,
    createdAt: "2026-08-07T00:00:00.000Z",
  } });
});

test("public HTTPS images reject local and reserved destinations", () => {
  assert.equal(publicHttpsUrlSchema.parse("https://cdn.example.test/avatar.png"), "https://cdn.example.test/avatar.png");
  for (const value of [
    "https://fcdn.example.com/avatar.png",
    "https://fdn.example.com/avatar.png",
    "https://ffmpeg.example.com/avatar.png",
    "https://fe8.example.com/avatar.png",
  ]) assert.equal(publicHttpsUrlSchema.safeParse(value).success, true, value);
  for (const value of [
    "http://cdn.example.test/avatar.png",
    "https://localhost/avatar.png",
    "https://localhost./avatar.png",
    "https://router/avatar.png",
    "https://metadata/avatar.png",
    "https://host.local/avatar.png",
    "https://host.local./avatar.png",
    "https://host.internal/avatar.png",
    "https://host.home/avatar.png",
    "https://host.lan/avatar.png",
    "https://127.0.0.1/avatar.png",
    "https://127.1/avatar.png",
    "https://2130706433/avatar.png",
    "https://0x7f000001/avatar.png",
    "https://0177.0.0.1/avatar.png",
    "https://10.0.0.1/avatar.png",
    "https://169.254.1.2/avatar.png",
    "https://172.16.0.1/avatar.png",
    "https://192.168.1.1/avatar.png",
    "https://100.64.0.1/avatar.png",
    "https://198.18.0.1/avatar.png",
    "https://192.0.2.1/avatar.png",
    "https://198.51.100.1/avatar.png",
    "https://203.0.113.1/avatar.png",
    "https://224.0.0.1/avatar.png",
    "https://250.0.0.1/avatar.png",
    "https://[::]/avatar.png",
    "https://[::1]/avatar.png",
    "https://[fd00::1]/avatar.png",
    "https://[fe80::1]/avatar.png",
    "https://[ff02::1]/avatar.png",
    "https://[2001:db8::1]/avatar.png",
    "https://[::ffff:127.0.0.1]/avatar.png",
    "https://[0:0:0:0:0:ffff:7f00:1]/avatar.png",
  ]) assert.equal(publicHttpsUrlSchema.safeParse(value).success, false, value);
});

test("notification requests accept a server-generated idempotency key and reject removed privacy inputs", () => {
  assert.deepEqual(notificationRequestSchema.parse({
    title: "Complete",
    body: "Build finished",
    sourceName: "Codex",
  }), { title: "Complete", body: "Build finished", sourceName: "Codex" });
  assert.equal(notificationRequestSchema.safeParse({
    title: "Complete", body: "Build finished", sourceName: "Codex", privacy: "private",
  }).success, false);
  assert.equal(operationHeadersSchema.parse({}).idempotencyKey, undefined);
  assert.equal(operationHeadersSchema.parse({ idempotencyKey: "x" }).idempotencyKey, "x");
  assert.equal(operationHeadersSchema.parse({ idempotencyKey: "x".repeat(200) }).idempotencyKey?.length, 200);
  assert.equal(operationHeadersSchema.safeParse({ idempotencyKey: "" }).success, false);
  assert.equal(operationHeadersSchema.safeParse({ idempotencyKey: "x".repeat(201) }).success, false);
});

test("text responses require text and binary responses reject it", () => {
  const base = {
    interactionId: "int_123456789012",
    deviceId: "dev_123456789012",
    responseToken: "x".repeat(40),
    idempotencyKey: "reply-1",
  };
  assert.equal(interactionResponseSchema.safeParse({ ...base, action: "reply" }).success, false);
  assert.equal(
    interactionResponseSchema.safeParse({ ...base, action: "approve", response: "oops" }).success,
    false,
  );
  assert.equal(
    interactionResponseSchema.safeParse({ ...base, action: "reply", response: "x".repeat(4_000) }).success,
    true,
  );
  assert.equal(
    interactionResponseSchema.safeParse({ ...base, action: "reply", response: "x".repeat(4_001) }).success,
    false,
  );
});

test("inbox pages always expose a resynchronization cursor", () => {
  const page = inboxPageSchema.parse({
    items: [],
    cursor: null,
    hasMore: false,
    serverTime: "2026-08-06T12:00:00.000Z",
  });
  assert.equal(page.items.length, 0);
});

test("Inbox history freezes newest-first pagination boundaries and total semantics", () => {
  assert.deepEqual(inboxHistoryQuerySchema.parse({}), { limit: 20 });
  assert.deepEqual(inboxHistoryQuerySchema.parse({ before: "opaque", limit: "1" }), {
    before: "opaque", limit: 1,
  });
  assert.equal(inboxHistoryQuerySchema.parse({ limit: "100" }).limit,100);
  for (const limit of ["0","101","1.5","not-a-number"]) {
    assert.equal(inboxHistoryQuerySchema.safeParse({ limit }).success,false,limit);
  }
  assert.equal(inboxHistoryQuerySchema.safeParse({ before: "" }).success,false);
  assert.equal(inboxHistoryQuerySchema.safeParse({ unexpected: true }).success,false);

  const microsecondTimestamp = "2026-08-07T00:00:00.123456Z";
  assert.equal(inboxPageSchema.safeParse({
    items: [{
      id: "ntf_123456789012", kind: "notification", sourceName: "History",
      sourceImageUrl: null, title: "Precise", detail: null, result: null,
      deliveryState: null, apnsAcceptedAt: null, receivedAt: null, openedAt: null,
      createdAt: microsecondTimestamp, destinationUrl: null, privacy: "standard",
      interaction: null, context: null, liveActivity: null,
    }],
    cursor: "forward", hasMore: false, serverTime: "2026-08-07T00:00:01.000000Z",
  }).success,true);

  assert.equal(inboxHistoryPageSchema.safeParse({
    items: [], cursor: null, hasMore: false, total: 0,
    serverTime: "2026-08-07T00:00:00.000Z",
  }).success,true);
  assert.equal(inboxHistoryPageSchema.safeParse({
    items: [], cursor: "opaque", hasMore: true, total: 2,
    serverTime: "2026-08-07T00:00:00.000Z",
  }).success,true);
  for (const inconsistent of [
    { cursor: null, hasMore: true },
    { cursor: "opaque", hasMore: false },
  ]) assert.equal(inboxHistoryPageSchema.safeParse({
    items: [], total: 0, serverTime: "2026-08-07T00:00:00.000Z", ...inconsistent,
  }).success,false);
});

test("inbox accepts monotonic Live Activity commands with device-bound interaction context", () => {
  const page = inboxPageSchema.parse({
    items: [{
      id: "ntf_123456789012",
      kind: "live_activity",
      sourceName: "Relo Gallery",
      sourceImageUrl: null,
      title: "Approval needed",
      detail: "Continue this task?",
      result: null,
      deliveryState: "queued",
      apnsAcceptedAt: null,
      receivedAt: null,
      openedAt: null,
      createdAt: "2026-08-06T12:00:00.000Z",
      destinationUrl: "https://relo.example/tasks/123",
      privacy: "standard",
      interaction: {
        id: "int_123456789012",
        kind: "approval",
        prompt: "Continue this task?",
        state: "pending",
        expiresAt: "2026-08-06T12:10:00.000Z",
        respondedAt: null,
      },
      context: {
        providerName: "Codex",
        computer: "Mac",
        project: "Relo",
        threadName: "Lifecycle policy",
        taskTitle: "Notification lifecycle",
      },
      liveActivity: {
        operation: "update",
        activityId: "act_123456789012",
        generation: 3,
        targetDeviceId: "dev_123456789012",
        style: "approval",
        sourceName: "Relo Gallery",
        headline: "Approval needed",
        detail: "Continue this task?",
        status: "Waiting for input",
        progress: 0.73,
        privacy: "standard",
        alertOwner: "none",
        sequence: 4,
        dismissAfterSeconds: null,
        interaction: {
          id: "int_123456789012",
          notificationId: "ntf_123456789012",
          kind: "approval",
          state: "pending",
          credential: "x".repeat(43),
          expiresAt: "2026-08-06T12:10:00.000Z",
        },
      },
    }],
    cursor: "opaque",
    hasMore: false,
    serverTime: "2026-08-06T12:00:01.000Z",
  });
  assert.equal(page.items[0]?.liveActivity?.operation, "update");
  assert.equal(page.items[0]?.context?.computer, "Mac");
  assert.equal(page.items[0]?.destinationUrl, "https://relo.example/tasks/123");
});

test("Live Activity sequence is server-owned and targeting identifiers are strict", () => {
  assert.equal(liveActivityUpdateRequestSchema.safeParse({ status: "Running", sequence: 9 }).success, false);
  assert.equal(liveActivityStartRequestSchema.safeParse({ title: "Build" }).success, false);
  assert.equal(liveActivityStartRequestSchema.safeParse({
    key: "build",
    title: "Build",
    status: "Starting",
    deviceIds: ["not-a-device"],
  }).success, false);
});

test("Live Activity updates support explicit nullable field clears", () => {
  const update = liveActivityUpdateRequestSchema.parse({ detail: null, progress: null });
  assert.equal(update.detail, null);
  assert.equal(update.progress, null);
});

test("task Live Activities preserve omitted appearance for server policy resolution", () => {
  const start = liveActivityStartRequestSchema.parse({ title: "Build", status: "Starting" });
  assert.deepEqual({
    key: start.key,
    replace: start.replace,
    symbol: start.symbol,
    style: start.style,
    accentColor: start.accentColor,
    expiresInSeconds: start.expiresInSeconds,
    staleAfterSeconds: start.staleAfterSeconds,
  },{
    key: undefined,
    replace: false,
    symbol: undefined,
    style: undefined,
    accentColor: undefined,
    expiresInSeconds: 28_800,
    staleAfterSeconds: 14_400,
  });
  assert.equal(liveActivityStartRequestSchema.safeParse({ title: "No", status: "Starting", style: "approval" }).success,false);
  assert.equal(liveActivityUpdateRequestSchema.safeParse({ style: "signal" }).success,false);
  assert.equal(liveActivityStartRequestSchema.safeParse({ title: "No", status: "Starting", accentColor: "red" }).success,false);
});

test("task Live Activity update and end schemas cover cosmetic, stale, and terminal fields", () => {
  const update = liveActivityUpdateRequestSchema.parse({
    title: "Deploy", status: "Shipping", detail: null, progress: null,
    symbol: "build", accentColor: "#aBc123",
    style: "steps", staleAfterSeconds: 60, ifSequence: 3,
  });
  assert.equal(update.staleAfterSeconds,60);
  assert.equal(liveActivityUpdateRequestSchema.safeParse({ ifSequence: 3 }).success,false);
  assert.equal(liveActivityUpdateRequestSchema.safeParse({
    lifecycle: { provider: "codex",runId: "codex-run-123" },
  }).success,false);
  assert.equal(liveActivityUpdateRequestSchema.safeParse({
    lifecycle: { provider: "codex",runId: "codex-run-123" },status: "Working",deliveryPriority: 10,
  }).success,true);
  assert.equal(liveActivityUpdateRequestSchema.safeParse({ status: "Working",deliveryPriority: 5 }).success,false);
  assert.equal(liveActivityStartRequestSchema.safeParse({
    acquireMode: "ensure",title: "Manual",status: "Starting",
  }).success,true);
  assert.equal(liveActivityStartRequestSchema.safeParse({
    acquireMode: "ensure",key: "manual-run",title: "Manual",status: "Starting",
  }).success,true);
  const end = liveActivityEndRequestSchema.parse({ progress: 1 });
  assert.deepEqual({ status: end.status, symbol: end.symbol, dismissAfterSeconds: end.dismissAfterSeconds },{
    status: "Complete", symbol: "success", dismissAfterSeconds: 0,
  });
});

test("task Live Activity mutation snapshots include expiry, stale, and replacement state", () => {
  const response = taskLiveActivityMutationResponseSchema.parse({
    activity: {
      id: "act_123456789012", generation: 3, key: "deploy", title: "Deploy", status: "Replaced",
      detail: null, progress: 0.5, symbol: "warning", privacy: "standard",
      privacyMode: "standard", accentColor: "#5ED8B7", style: "standard", state: "replaced",
      sequence: 4, expiresAt: "2026-08-07T08:00:00.000Z", staleAt: "2026-08-07T04:00:00.000Z",
      createdAt: "2026-08-07T00:00:00.000Z", updatedAt: "2026-08-07T01:00:00.000Z",
      endedAt: "2026-08-07T01:00:00.000Z",ownerKind: "credential_session",
    },
    delivery: { eligibleDevices: 1, durableCommands: 1, apnsJobs: 1 },
    queued: 1, replayed: true, reused: false, resumed: true, replaced: 1,
  });
  assert.equal(response.activity.state,"replaced");
  assert.equal(response.activity.generation,3);
  assert.equal(response.resumed,true);
});

test("Live Activity update-token registration binds an APNs environment and native activity", () => {
  const registration = liveActivityUpdateTokenRequestSchema.parse({
    token: "a".repeat(64),
    nativeActivityId: "native-activity-1",
    environment: "sandbox",
    generation: 3,
  });
  assert.equal(registration.environment,"sandbox");
  assert.equal(registration.generation,3);
  assert.equal(liveActivityUpdateTokenRequestSchema.safeParse({ ...registration, token: "secret" }).success,false);
  for (const invalid of [undefined,0,-1,1.5]) {
    assert.equal(liveActivityUpdateTokenRequestSchema.safeParse({ ...registration, generation: invalid }).success,false);
  }
});

test("Live Activity recovery resolves exactly one origin, provider run, or server-owned current activity", () => {
  const origin = {
    sourceInstance: "codex-installation-7f3c", project: "relo-notifications",
    thread: "codex-task-opaque-digest", channel: "task-progress",
  };
  const lifecycle = { provider: "codex",runId: "codex-run-0123456789abcdef" };
  assert.deepEqual(liveActivityResolveRequestSchema.parse({ origin }),{ origin });
  assert.deepEqual(liveActivityResolveRequestSchema.parse({ lifecycle }),{ lifecycle });
  assert.deepEqual(liveActivityResolveRequestSchema.parse({ current: true }),{ current: true });
  assert.deepEqual(liveActivityResolveResponseSchema.parse({ found: false,activity: null }),{
    found: false,activity: null,
  });
  assert.equal(liveActivityResolveRequestSchema.safeParse({ origin: { ...origin,thread: "" } }).success,false);
  assert.equal(liveActivityResolveRequestSchema.safeParse({}).success,false);
  assert.equal(liveActivityResolveRequestSchema.safeParse({ origin,lifecycle }).success,false);
  assert.equal(liveActivityResolveRequestSchema.safeParse({ current: true,lifecycle }).success,false);
  assert.equal(liveActivityResolveRequestSchema.safeParse({ lifecycle: { provider: "Codex!",runId: "raw id" } }).success,false);
  assert.equal(liveActivityResolveRequestSchema.safeParse({ origin,rawPrompt: "forbidden" }).success,false);
});

test("Inbox Live Activity commands require a positive generation", () => {
  const command = {
    operation: "start", activityId: "act_123456789012", generation: 2,
    targetDeviceId: "dev_123456789012", style: "standard", sourceName: "Codex",
    headline: "Build", detail: null, status: "Running", progress: null,
  };
  assert.equal(inboxLiveActivitySchema.parse(command).generation,2);
  for (const invalid of [undefined,0,-1,1.5]) {
    assert.equal(inboxLiveActivitySchema.safeParse({ ...command, generation: invalid }).success,false);
  }
});

test("the cross-package current-slice fixture matches the canonical schemas", () => {
  const fixture = JSON.parse(readFileSync(new URL("../fixtures/current-slice.json", import.meta.url), "utf8"));
  notificationRequestSchema.parse(fixture.notification);
  liveActivityStartRequestSchema.parse(fixture.activityStart);
  liveActivityUpdateRequestSchema.parse(fixture.activityUpdate);
  liveActivityEndRequestSchema.parse(fixture.activityEnd);
  deliverySummarySchema.parse(fixture.delivery);
  for (const value of fixture.publicImageUrls.accepted) {
    assert.equal(publicHttpsUrlSchema.safeParse(value).success, true, value);
  }
  for (const value of fixture.publicImageUrls.rejected) {
    assert.equal(publicHttpsUrlSchema.safeParse(value).success, false, value);
  }
});

test("agent session events accept only bounded labels", async () => {
  const { agentSessionEventRequestSchema, inboxSnapshotResponseSchema } = await import("../src/index.js");
  const ok = { session: "a".repeat(64), harness: "claude-code", event: "start" };
  assert.equal(agentSessionEventRequestSchema.safeParse(ok).success, true);
  assert.equal(agentSessionEventRequestSchema.safeParse({ ...ok, event: "pause" }).success, false);
  assert.equal(agentSessionEventRequestSchema.safeParse({ ...ok, prompt: "hello" }).success, false);
  assert.equal(agentSessionEventRequestSchema.safeParse({ ...ok, session: "short" }).success, false);
  assert.equal(agentSessionEventRequestSchema.safeParse({ ...ok, project: "x".repeat(121) }).success, false);
  assert.equal(apiTokenScopeSchema.parse("sessions:write"), "sessions:write");
  const snapshot = inboxSnapshotResponseSchema.parse({
    items: [], total: 0, serverTime: new Date().toISOString(), readWatermark: null, unread: { account: 0, projects: {} },
  });
  assert.equal(snapshot.sessions, undefined);
});
