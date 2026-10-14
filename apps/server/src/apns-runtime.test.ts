import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  apnsPriorityForJob,
  ApnsOutcomePersistenceError,
  CleanroomApnsRuntime,
  mapApnsOutcomeToRuntimeResult,
  type ApnsRuntimeJob,
} from "./apns-runtime.js";
import type {
  ApnsConnection,
  ApnsProviderConfig,
  ApnsTransport,
  GoawayEvent,
  PreparedApnsRequest,
  RecipientResolver,
  TransportBinding,
  TransportResult,
} from "./apns-provider-cleanroom.js";
import { presentationCommandProjection } from "./presentation-runtime.js";

const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

class RecordingConnection implements ApnsConnection {
  readonly security = {
    tlsVersion: "TLSv1.3", alpnProtocol: "h2", authorized: true,
    hostnameVerified: true, servername: "api.sandbox.push.apple.com",
  };
  readonly requests: PreparedApnsRequest[] = [];
  private nextStreamId = 1;
  constructor(private readonly responses: TransportResult[]) {}
  openStream(request: PreparedApnsRequest) {
    this.requests.push(request);
    const streamId = this.nextStreamId;
    this.nextStreamId += 2;
    return { streamId, result: Promise.resolve(this.responses.shift()!), cancel() {} };
  }
  onPeerSettings(): () => void { return () => undefined; }
  onGoaway(_listener: (event: GoawayEvent) => void): () => void { return () => undefined; }
  close(): void {}
}

class RecordingTransport implements ApnsTransport {
  readonly bindings: TransportBinding[] = [];
  readonly connection: RecordingConnection;
  constructor(responses: TransportResult[]) { this.connection = new RecordingConnection(responses); }
  async open(binding: TransportBinding): Promise<ApnsConnection> {
    this.bindings.push(binding);
    this.connection.security.servername = binding.servername;
    return this.connection;
  }
}

class FakeDatabase {
  readonly queries: Array<{ text: string; values?: unknown[] }> = [];
  payloadHash: string | null = null;
  failAttemptInsert = false;
  owned = true;
  providerRetryState: {
    attemptCap: number;
    retryHorizonAt: Date;
    nextAttemptNotBefore: Date;
  } | null = null;
  async query(text: string, values?: unknown[]) {
    this.queries.push({ text, ...(values === undefined ? {} : { values }) });
    if (text.startsWith("UPDATE delivery_jobs SET apns_payload_sha256")) {
      if (!this.owned) return { rowCount: 0, rows: [] };
      if (this.payloadHash !== null) return { rowCount: 0, rows: [] };
      this.payloadHash = String(values![1]);
      return { rowCount: 1, rows: [{ apns_payload_sha256: this.payloadHash }] };
    }
    if (text.startsWith("SELECT apns_payload_sha256")) {
      return this.owned
        ? { rowCount: 1, rows: [{ apns_payload_sha256: this.payloadHash }] }
        : { rowCount: 0, rows: [] };
    }
    if (text.includes("INSERT INTO delivery_attempts") && this.failAttemptInsert) throw new Error("db unavailable");
    if (text.includes("UPDATE delivery_jobs SET provider_outcome_category")) {
      return { rowCount: this.owned ? 1 : 0, rows: [] };
    }
    if (text.includes("provider_next_attempt_not_before=CASE")) {
      if (!this.owned) return { rowCount: 0,rows: [] };
      const proposed = {
        attemptCap: Number(values![4]),
        retryHorizonAt: values![5] as Date,
        nextAttemptNotBefore: values![6] as Date,
      };
      this.providerRetryState = this.providerRetryState === null ? proposed : {
        attemptCap: Math.min(this.providerRetryState.attemptCap,proposed.attemptCap),
        retryHorizonAt: new Date(Math.min(
          this.providerRetryState.retryHorizonAt.getTime(),proposed.retryHorizonAt.getTime(),
        )),
        nextAttemptNotBefore: new Date(Math.max(
          this.providerRetryState.nextAttemptNotBefore.getTime(),proposed.nextAttemptNotBefore.getTime(),
        )),
      };
      return { rowCount: 1,rows: [{
        provider_retry_attempt_cap: this.providerRetryState.attemptCap,
        provider_retry_horizon_at: this.providerRetryState.retryHorizonAt,
        provider_next_attempt_not_before: this.providerRetryState.nextAttemptNotBefore,
      }] };
    }
    return { rowCount: 1, rows: [] };
  }
  async connect() {
    return { query: this.query.bind(this), release() {} };
  }
}

function config(): ApnsProviderConfig {
  return {
    teamId: "TEAM123456",
    keyId: "KEY1234567",
    privateKeyPem,
    keyScope: "team-scoped",
    keyEnvironment: "sandbox",
    allowedTopics: ["com.example.app", "com.example.app.push-type.liveactivity"],
    bundleId: "com.example.app",
    environment: "sandbox",
    configurationGeneration: "runtime-test",
  };
}

function recipient(): RecipientResolver {
  return {
    async resolve() { return { token: "device-token", generation: "generation-1" }; },
    async invalidate() {},
  };
}

function job(overrides: Partial<ApnsRuntimeJob> = {}): ApnsRuntimeJob {
  return {
    id: "123e4567-e89b-42d3-a456-426614174000",
    claimToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    attemptCount: 1,
    providerAttemptsUsed: 0,
    providerRetryStartedAt: null,
    providerRetryAttemptCap: null,
    providerRetryHorizonAt: null,
    providerNextAttemptNotBefore: null,
    providerStatus: null,
    transport: "notification",
    createdAt: new Date("2026-08-07T00:00:00.000Z"),
    expiresAt: null,
    title: "Build complete",
    body: "The build succeeded",
    sourceName: "Codex",
    conversationId: "svc_stable",
    avatarUrl: "https://example.test/avatar.png",
    imageUrl: "https://example.test/image.png",
    deepLink: "https://example.test/result",
    notificationId: "ntf_123e4567-e89b-42d3-a456-426614174000",
    accountId: "acc_11111111-1111-4111-8111-111111111111",
    interactionKind: null,
    interactionId: null,
    badge: 2,
    payload: { privacy: "standard", context: { computer: "Mac", project: "Relo" } },
    ...overrides,
  };
}

describe("clean-room APNs worker runtime", () => {
  test.each([
    ["approval","RELO_APPROVAL"],["yes_no","RELO_YES_NO"],["text","RELO_TEXT"],
  ] as const)("serializes the %s category through the actual provider",async (kind,category)=>{
    const transport=new RecordingTransport([{kind:"response",status:200,body:Buffer.alloc(0)}]);
    const runtime=new CleanroomApnsRuntime(new FakeDatabase() as never,config(),transport);
    expect((await runtime.send(job({interactionKind:kind,interactionId:"int_123e4567-e89b-42d3-a456-426614174111"}),recipient())).kind).toBe("accepted");
    const payload=JSON.parse(Buffer.from(transport.connection.requests[0]!.body).toString());
    expect(payload.aps.category).toBe(category);expect(payload.relo.interactionType).toBe(kind);
  });

  test.each([-1,1.5,Number.MAX_SAFE_INTEGER+1])("rejects invalid badge %s without opening a provider stream",async badge=>{
    const transport=new RecordingTransport([]);
    const runtime=new CleanroomApnsRuntime(new FakeDatabase() as never,config(),transport);
    expect((await runtime.send(job({badge}),recipient())).kind).toBe("rejected");
    expect(transport.connection.requests).toHaveLength(0);
  });

  test("ordinary custom data cannot override categories or carry nested credentials",async()=>{
    const transport=new RecordingTransport([{kind:"response",status:200,body:Buffer.alloc(0)}]);
    const runtime=new CleanroomApnsRuntime(new FakeDatabase() as never,config(),transport);
    await runtime.send(job({badge:0,sourceName:"x".repeat(100),payload:{privacy:"standard",category:"CLIENT_CONTROLLED",
      credential:"SECRET_SENTINEL",nested:{responseToken:"SECRET_SENTINEL"},items:[{apiSecret:"SECRET_SENTINEL"}],
      context:{computer:"Mac",unknown:"SECRET_SENTINEL"}}}),recipient());
    const bytes=Buffer.from(transport.connection.requests[0]!.body).toString(),payload=JSON.parse(bytes);
    expect(bytes).not.toMatch(/SECRET_SENTINEL|CLIENT_CONTROLLED/);
    expect(payload.aps).not.toHaveProperty("category");expect(payload.aps.badge).toBe(0);
    expect(payload.relo.sourceName).toHaveLength(80);expect(payload.relo.context).toEqual({computer:"Mac"});
    expect(payload.relo).not.toHaveProperty("nested");expect(payload.relo).not.toHaveProperty("items");
  });

  test.each([undefined,0,-1,1.5])("rejects missing/invalid native generation %s before transport",async generation=>{
    const transport=new RecordingTransport([]);
    const runtime=new CleanroomApnsRuntime(new FakeDatabase() as never,config(),transport);
    await expect(runtime.send(job({transport:"live_activity_update",activityCommand:{generation,operation:"update"}}),recipient())).rejects.toThrow("positive integer");
    expect(transport.connection.requests).toHaveLength(0);
  });

  test.each([14_400,20_000])("ignores producer dismissal %s; the owner-state table sets it",async dismissAfterSeconds=>{
    const transport=new RecordingTransport([{kind:"response",status:200,body:Buffer.alloc(0)}]);
    const runtime=new CleanroomApnsRuntime(new FakeDatabase() as never,config(),transport);
    await runtime.send(job({transport:"live_activity_update",activityCommand:{generation:1,sequence:1,operation:"end",
      providerTimestamp:1_786_060_800,status:"Done",dismissAfterSeconds}}),recipient());
    const aps=JSON.parse(Buffer.from(transport.connection.requests[0]!.body).toString()).aps;
    expect(aps.event).toBe("end");expect(aps["content-state"].status).toBe("Done");
    // End dismissal comes from the owner-state table, never the producer: a card without a final owner state leaves at once.
    expect(aps["dismissal-date"]-aps.timestamp).toBe(0);
  });

  test("prewarms and reuses one HTTP/2 session", async () => {
    const db = new FakeDatabase();
    const transport = new RecordingTransport([
      { kind: "response",status: 200,body: Buffer.alloc(0) },
      { kind: "response",status: 200,body: Buffer.alloc(0) },
    ]);
    const runtime = new CleanroomApnsRuntime(db as never,config(),transport);
    await runtime.warm();
    await runtime.send(job(),recipient());
    db.payloadHash = null;
    await runtime.send(job({ id: "223e4567-e89b-42d3-a456-426614174000" }),recipient());
    expect(transport.bindings).toHaveLength(1);
    expect(transport.connection.requests).toHaveLength(2);
  });

  test("uses priority 10 for every Live Activity command", () => {
    expect(apnsPriorityForJob({
      transport: "live_activity_update",command: { operation: "update" },
      requesterCredentialId: null,requesterServiceId: null,
    })).toBe(10);
    expect(apnsPriorityForJob({
      transport: "live_activity_update",command: { operation: "update" },
      requesterCredentialId: "credential",requesterServiceId: null,
    })).toBe(10);
    expect(apnsPriorityForJob({
      transport: "live_activity_update",command: { operation: "update",priority: 10 },
      requesterCredentialId: "credential",requesterServiceId: null,
    })).toBe(10);
    expect(apnsPriorityForJob({
      transport: "live_activity_update",command: { operation: "end",priority: 5 },
      requesterCredentialId: "credential",requesterServiceId: null,
    })).toBe(10);
  });
  test("persists exact payload identity and provider acceptance without claiming device delivery", async () => {
    const db = new FakeDatabase();
    const transport = new RecordingTransport([{
      kind: "response", status: 200, body: Buffer.alloc(0),
      headers: { "apns-id": "123e4567-e89b-42d3-a456-426614174999" },
    }]);
    const runtime = new CleanroomApnsRuntime(db as never, config(), transport);
    const collapseId = `org_${"a".repeat(43)}`;
    const result = await runtime.send(job({ collapseId }), recipient());
    expect(result).toEqual({ kind: "accepted", providerMessageId: "123e4567-e89b-42d3-a456-426614174999" });
    const request = transport.connection.requests[0]!;
    expect(request.headers).toMatchObject({
      "apns-topic": "com.example.app", "apns-push-type": "alert", "apns-id": job().id,
      "apns-collapse-id": collapseId,
    });
    expect(JSON.parse(Buffer.from(request.body).toString())).toEqual({
      relo: {
        privacy: "standard", context: { computer: "Mac", project: "Relo" },
        notificationId: job().notificationId, sourceName: "Codex", conversationId: "svc_stable",
        avatarUrl: "https://example.test/avatar.png", imageUrl: "https://example.test/image.png",
        deepLink: "https://example.test/result",
      },
      aps: {
        alert: { title: "Build complete", body: "The build succeeded" },
        sound: "default", badge: 2, "mutable-content": 1, "thread-id": "svc_stable",
        "interruption-level": "active",
      },
    });
    expect(db.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(db.queries.some(({ text }) => text.includes("INSERT INTO delivery_attempts"))).toBe(true);
    expect(db.queries.some(({ text }) => text.includes("provider_outcome_category")
      && text.includes("claim_phase='dispatch_started'"))).toBe(true);
    expect(db.queries.some(({ text }) => text.includes("apns_payload_sha256")
      && text.includes("claim_phase='dispatch_started'"))).toBe(true);
  });

  test("masks private content before serialization and excludes identifying metadata", async () => {
    const db = new FakeDatabase();
    const transport = new RecordingTransport([{ kind: "response", status: 200, body: Buffer.alloc(0) }]);
    const runtime = new CleanroomApnsRuntime(db as never, config(), transport);
    await runtime.send(job({
      title: "Secret title", body: "Secret body", sourceName: "Secret source",
      conversationId: "secret-conversation", payload: { privacy: "private", context: { project: "Secret project" } },
    }), recipient());
    const serialized = Buffer.from(transport.connection.requests[0]!.body).toString();
    expect(serialized).not.toMatch(/Secret title|Secret body|Secret source|secret-conversation|Secret project/);
    expect(JSON.parse(serialized)).toMatchObject({
      relo: { privacy: "private", sourceName: "Relo", avatarUrl: null, imageUrl: null, deepLink: null },
      aps: { alert: { title: "Relo", body: "New private notification" } },
    });
  });

  test("preserves the public interaction identity and category in the APNs envelope", async () => {
    const db = new FakeDatabase();
    const transport = new RecordingTransport([{ kind: "response", status: 200, body: Buffer.alloc(0) }]);
    const runtime = new CleanroomApnsRuntime(db as never, config(), transport);
    await runtime.send(job({
      interactionKind: "approval",
      interactionId: "int_123e4567-e89b-42d3-a456-426614174111",
    }), recipient());
    const request = transport.connection.requests[0]!;
    expect(request.headers["apns-topic"]).toBe("com.example.app");
    expect(JSON.parse(Buffer.from(request.body).toString())).toMatchObject({
      relo: {
        interactionId: "int_123e4567-e89b-42d3-a456-426614174111",
        interactionType: "approval",
      },
      aps: { category: "RELO_APPROVAL", "mutable-content": 1 },
    });
  });

  test("runs the notification service extension for ordinary, rich, and communication alerts only", async () => {
    const db = new FakeDatabase();
    const transport = new RecordingTransport(Array.from({ length: 3 }, () => ({
      kind: "response" as const,status: 200,body: Buffer.alloc(0),
    })));
    const runtime = new CleanroomApnsRuntime(db as never,config(),transport);
    for (const overrides of [
      { imageUrl: null },
      { imageUrl: "https://example.test/rich.png" },
      { conversationId: "conversation",interactionKind: "yes_no" as const,
        interactionId: "int_123e4567-e89b-42d3-a456-426614174111" },
    ]) {
      db.payloadHash = null;
      await runtime.send(job(overrides),recipient());
    }
    for (const request of transport.connection.requests) {
      expect(JSON.parse(Buffer.from(request.body).toString()).aps["mutable-content"]).toBe(1);
    }
  });

  test("uses durable operation time and exact ActivityKit topic for start/update/end", async () => {
    const db = new FakeDatabase();
    const transport = new RecordingTransport([
      { kind: "response", status: 200, body: Buffer.alloc(0) },
      { kind: "response", status: 200, body: Buffer.alloc(0) },
      { kind: "response", status: 200, body: Buffer.alloc(0) },
    ]);
    const runtime = new CleanroomApnsRuntime(db as never, config(), transport);
    const command = {
      activityId: "act_12345678", sourceName: "Codex", headline: "Build", status: "Running",
      generation: 7,
      detail: "Compile", progress: 0.5, sequence: 2, style: "standard", symbol: "build",
      accentColor: "#64D2FF", privacy: "standard", staleAt: "2026-08-07T01:00:00.000Z",
      relevanceScore: 0.95,
    };
    for (const [transportKind, operation,providerTimestamp] of [
      ["live_activity_start", "start",1_786_060_800],
      ["live_activity_update", "update",1_786_060_801],
      ["live_activity_update", "end",1_786_060_802],
    ] as const) {
      db.payloadHash = null;
      const result = await runtime.send(job({
        transport: transportKind,
        activityCommand: {
          ...command,operation,providerTimestamp,
          ...(operation === "end" ? {
            status: "Approved",progress: null,sequence: 3,dismissAfterSeconds: 5,
          } : {}),
        },
      }), recipient());
      expect(result.kind).toBe("accepted");
    }
    for (const [index,request] of transport.connection.requests.entries()) {
      expect(request.headers).toMatchObject({
        "apns-topic": "com.example.app.push-type.liveactivity", "apns-push-type": "liveactivity",
      });
      const aps = JSON.parse(Buffer.from(request.body).toString()).aps;
      expect(aps.timestamp).toBe(1_786_060_800+index);
      expect(aps["mutable-content"]).toBeUndefined();
      expect(aps["input-push-token"]).toBe(index === 0 ? 1 : undefined);
      expect(aps["content-state"].generation).toBe(7);
      expect(aps["relevance-score"]).toBe(index === 2 ? 0 : 0.7); // OWNER_STATE_SURFACES.moving.relevance; an end ranks 0
      if (index === 0) expect(aps.attributes.generation).toBe(7);
    }
    // Plain progress spends priority 5; start and end are 10 (slice 1 item 1.8).
    expect(transport.connection.requests.map((request) => request.headers["apns-priority"]))
      .toEqual(["10", "5", "10"]);
    expect(transport.connection.requests.map((request) => request.headers["apns-expiration"]))
      .toEqual(["0","0","0"]);
    const terminal = JSON.parse(Buffer.from(transport.connection.requests[2]!.body).toString()).aps;
    expect(terminal).toMatchObject({
      event: "end",timestamp: 1_786_060_802,"dismissal-date": 1_786_060_802, // no owner state: leaves at once
      "content-state": { headline: "Build",status: "Approved",progress: null,sequence: 3 },
    });
  });

  test("emits the exact JSON-primitive ActivityKit interaction fixture", async () => {
    const fixture = JSON.parse(await readFile(new URL(
      "../fixtures/activitykit-content-state-interaction.json",
      import.meta.url,
    ),"utf8"));
    const db = new FakeDatabase();
    const transport = new RecordingTransport([{ kind: "response",status: 200,body: Buffer.alloc(0) }]);
    const runtime = new CleanroomApnsRuntime(db as never,config(),transport);
    await runtime.send(job({
      transport: "live_activity_update",
      activityCommand: {
        operation: "update",activityId: "act_12345678",generation: 7,sourceName: "Codex",
        ...fixture,
        expiresAt: "2030-01-01T00:00:00.000Z",
        staleAt: "2029-12-31T23:30:00.000Z",
      },
    }),recipient());
    const aps = JSON.parse(Buffer.from(transport.connection.requests[0]!.body).toString()).aps;
    // staleAt is derived from the owner state (evidence + T_fresh), never copied from the producer.
    expect(aps["content-state"]).toMatchObject({ generation: 7,...fixture,staleAt: null });
    expect(Object.keys(aps["content-state"]).sort()).toEqual([...Object.keys(fixture),"generation","owner"].sort());
  });

  test("sends the shared flat current projection without a nested canonical record",async () => {
    const db = new FakeDatabase();
    const transport = new RecordingTransport([{ kind: "response",status: 200,body: Buffer.alloc(0) }]);
    const runtime = new CleanroomApnsRuntime(db as never,config(),transport);
    const projection = presentationCommandProjection({
            content: { header: "Relo",title: "Deploy",subtitle: "Backend",status: "Running" },
      identity: { project: null,thread: null,direct: true },
      state: { kind: "active",tone: "live",icon: "active" },
      components: [{ id: "steps",type: "steps",colorRole: "project",items: [
        { id: "build",label: "Build",state: "complete" },
        { id: "deploy",label: "Deploy",state: "current" },
      ] }],
      surfaces: { lock_screen: ["steps"],expanded_leading: [],expanded_trailing: [],
        expanded_bottom: ["steps"],compact_leading: ["steps"],compact_trailing: [],minimal: ["steps"] },
      behavior: { type: "progress" },
      appearance: { theme: "dark",roles: {
        cardIdentity: "project",componentIdentity: "thread",statusEmphasis: "state",
      } },
      privacy: "standard",
    });
    await runtime.send(job({
      transport: "live_activity_update",
      activityCommand: {
        operation: "update",activityId: "act_12345678",generation: 7,sourceName: "Codex",
        ...projection,sequence: 4,expiresAt: null,staleAt: null,interaction: null,
      },
    }),recipient());
    const state = JSON.parse(Buffer.from(transport.connection.requests[0]!.body).toString())
      .aps["content-state"];
    expect(state).toMatchObject({
      title: "Deploy",behaviorType: "progress",
      sequence: 4,interaction: null,
    });
    expect(state.componentsJson).toContain('"type":"steps"');
    expect(state).not.toHaveProperty("presentation");
    expect(state).not.toHaveProperty("style");
  });

  test("fails closed before transport when durable payload identity does not match", async () => {
    const db = new FakeDatabase();
    db.payloadHash = "0".repeat(64);
    const transport = new RecordingTransport([{ kind: "response", status: 200, body: Buffer.alloc(0) }]);
    const runtime = new CleanroomApnsRuntime(db as never, config(), transport);
    await expect(runtime.send(job(), recipient())).resolves.toMatchObject({
      kind: "rejected", code: "validation",
    });
    expect(transport.connection.requests).toHaveLength(0);
    expect(db.queries.some(({ text }) => text.includes("INSERT INTO delivery_attempts"))).toBe(true);
  });

  test("does not turn exhausted provider policy into another worker retry budget", () => {
    for (const category of ["retry-exhausted","retryable-not-scheduled"] as const) {
      expect(mapApnsOutcomeToRuntimeResult({
        accepted: false,category,attempt: 3,apnsId: job().id,payloadBytes: 100,status: 503,
      })).toMatchObject({ kind: "rejected",code: category });
    }
    expect(mapApnsOutcomeToRuntimeResult({
      accepted: false,category: "indeterminate-transport",attempt: 1,
      apnsId: job().id,payloadBytes: 100,transportCode: "reset",
    })).toMatchObject({ kind: "reconcile",code: "reset" });
  });

  test("feeds persisted attempts and first-attempt epoch into the provider cap and horizon", async () => {
    const firstAttempt = new Date(Date.now()-1_000);
    const db = new FakeDatabase();
    const fourthTransport = new RecordingTransport([{
      kind: "response",status: 429,body: Buffer.from(JSON.stringify({ reason: "TooManyRequests" })),
    }]);
    const fourthRuntime = new CleanroomApnsRuntime(db as never,config(),fourthTransport);
    await expect(fourthRuntime.send(job({
      providerAttemptsUsed: 3,providerRetryStartedAt: firstAttempt,providerStatus: 429,
      providerRetryAttemptCap: 4,
      providerRetryHorizonAt: new Date(firstAttempt.getTime()+300_000),
      providerNextAttemptNotBefore: new Date(firstAttempt.getTime()+1_000),
    }),recipient())).resolves.toMatchObject({ kind: "rejected",code: "retry-exhausted" });
    expect(fourthTransport.connection.requests).toHaveLength(1);
    const attemptInsert = db.queries.find(({ text }) => text.includes("INSERT INTO delivery_attempts"))!;
    expect(attemptInsert.values?.[3]).toBe(1);
    expect(attemptInsert.values?.[10]).toEqual(firstAttempt);
    const aggregate = db.queries.find(({ text }) => text.includes("provider_outcome_category")
      && text.includes("provider_attempts_used=GREATEST"))!;
    expect(aggregate.values?.[5]).toBe(1);
    expect(aggregate.values?.[6]).toEqual(firstAttempt);

    const cappedDb = new FakeDatabase();
    const cappedTransport = new RecordingTransport([{
      kind: "response",status: 200,body: Buffer.alloc(0),
    }]);
    const cappedRuntime = new CleanroomApnsRuntime(cappedDb as never,config(),cappedTransport);
    await expect(cappedRuntime.send(job({
      providerAttemptsUsed: 4,providerRetryStartedAt: firstAttempt,providerStatus: 429,
      providerRetryAttemptCap: 4,
      providerRetryHorizonAt: new Date(firstAttempt.getTime()+300_000),
      providerNextAttemptNotBefore: new Date(firstAttempt.getTime()+1_000),
    }),recipient())).resolves.toMatchObject({ kind: "rejected",code: "retry-exhausted" });
    expect(cappedTransport.connection.requests).toHaveLength(0);
    expect(cappedDb.queries.find(({ text }) => text.includes("INSERT INTO delivery_attempts"))?.values?.[3]).toBe(0);

    const expiredDb = new FakeDatabase();
    const expiredTransport = new RecordingTransport([{
      kind: "response",status: 200,body: Buffer.alloc(0),
    }]);
    const expiredRuntime = new CleanroomApnsRuntime(expiredDb as never,config(),expiredTransport);
    const expiredFirst = new Date(Date.now()-300_001);
    await expect(expiredRuntime.send(job({
      providerAttemptsUsed: 1,
      providerRetryStartedAt: expiredFirst,
      providerRetryAttemptCap: 4,
      providerRetryHorizonAt: new Date(expiredFirst.getTime()+300_000),
      providerNextAttemptNotBefore: new Date(expiredFirst.getTime()+1_000),
      providerStatus: 429,
    }),recipient())).resolves.toMatchObject({ kind: "rejected",code: "retry-exhausted" });
    expect(expiredTransport.connection.requests).toHaveLength(0);
  });

  test("surfaces a known 200 persistence ambiguity without an internal resend", async () => {
    const db = new FakeDatabase();
    db.failAttemptInsert = true;
    const transport = new RecordingTransport([{
      kind: "response",status: 200,body: Buffer.alloc(0),
      headers: { "apns-id": "123e4567-e89b-42d3-a456-426614174999" },
    }]);
    const runtime = new CleanroomApnsRuntime(db as never,config(),transport);
    await expect(runtime.send(job(),recipient())).rejects.toMatchObject({
      name: ApnsOutcomePersistenceError.name,
      result: { kind: "accepted",providerMessageId: "123e4567-e89b-42d3-a456-426614174999" },
    });
    expect(transport.connection.requests).toHaveLength(1);
  });
});
