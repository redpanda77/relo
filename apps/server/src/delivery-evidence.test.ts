import {
  deliveryEvidenceMetricsSchema,deliveryEvidenceResponseSchema,
} from "@relo/notification-contracts";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "./app.js";
import { hashToken } from "./auth.js";
import { bootstrapOwner } from "./bootstrap.js";
import { createDatabase,type Database } from "./db.js";
import { registerDeliveryObservabilityRoutes } from "./delivery-observability.js";
import { loadDeliveryEvidence } from "./delivery-evidence.js";
import { migrate } from "./migrate.js";

const principalId = "11111111-1111-4111-8111-111111111111";
const eventId = "22222222-2222-4222-8222-222222222222";
const deliveryId = "33333333-3333-4333-8333-333333333333";
const deviceId = "44444444-4444-4444-8444-444444444444";
const attemptId = "55555555-5555-4555-8555-555555555555";

class EvidenceDatabase {
  readonly statements: Array<{ text: string; values?: unknown[] }> = [];

  async query(text: string,values?: unknown[]) {
    this.statements.push({ text,...(values ? { values } : {}) });
    if (text.includes("WITH owned_events AS MATERIALIZED")) {
      return { rows: [evidenceRow(),evidenceRow({
        source_id: "66666666-6666-4666-8666-666666666666",
        sort_key: "event-canonicalized-22222222-2222-4222-8222-222222222222",
        stage: "canonicalized",stage_order: 20,delivery_job_id: null,delivery_attempt_id: null,
        device_id: null,canonical_intent_sha256: null,
        device_projection_sha256: null,apns_payload_sha256: null,
      })] };
    }
    if (text.startsWith("SELECT now() AS generated_at")) {
      return { rows: [{
        generated_at: new Date("2026-08-14T12:01:00.000Z"),pending_jobs: 2,
        oldest_age_ms: 12_000,worker_lag_ms: 4_000,retry_rate_1h: 0.25,
        ambiguous_outcomes_1h: 1,invalidated_tokens_24h: 3,receipt_latency_p95_ms: 900,
      }] };
    }
    return { rows: [],rowCount: 0 };
  }
}

function evidenceRow(overrides: Record<string,unknown> = {}) {
  return {
    cursor_valid: true,sort_key: "attempt-outcome-55555555-5555-4555-8555-555555555555",
    cursor_occurred_at: "2026-08-14T12:00:05.000000Z",source_id: attemptId,
    notification_event_id: eventId,delivery_job_id: deliveryId,delivery_attempt_id: attemptId,
    device_id: deviceId,live_activity_id: null,stage: "provider_accepted",stage_order: 50,
    evidence_state: "accepted",detail_code: "reason containing secret content",
    canonical_intent_sha256: "a".repeat(64),
    device_projection_sha256: "b".repeat(64),apns_payload_sha256: "c".repeat(64),
    occurred_at: new Date("2026-08-14T12:00:05.000Z"),...overrides,
  };
}

function application(db: EvidenceDatabase,credentialKind: "principal" | "device" = "principal") {
  const app = new Hono();
  app.use("*",async (context,next) => {
    context.set("auth",{
      principalId,scopes: new Set(["devices:read"]),credentialKind,
      ...(credentialKind === "device" ? { deviceId } : { credentialId: "credential-id" }),
    });
    await next();
  });
  registerDeliveryObservabilityRoutes(app,db as never,"sandbox");
  return app;
}

describe("unified delivery evidence API",() => {
  test("returns one strict account-scoped vocabulary without raw diagnostics",async () => {
    const db = new EvidenceDatabase();
    const response = await application(db).request(
      `/api/evidence/timeline?notificationId=ntf_${eventId}&limit=1`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = deliveryEvidenceResponseSchema.parse(await response.json());
    expect(body).toMatchObject({ version: 1,order: "newest_first",hasMore: true,
      cursor: expect.any(String),items: [{
        stage: "provider_accepted",stageOrder: 50,state: "accepted",detailCode: null,
        notificationId: `ntf_${eventId}`,deliveryId: `job_${deliveryId}`,
        attemptId: `att_${attemptId}`,deviceId: `dev_${deviceId}`,
        serialization: { canonicalIntent: "sha256:aaaaaaaaaaaa" },
      }],
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/secret content|raw provider|credential|deviceToken|"project"|"thread"/i);
    expect(serialized).not.toContain('"payload"');
    expect(db.statements[0]!.values?.[0]).toBe(principalId);
    expect(db.statements[0]!.text).toContain("WHERE e.principal_id=$1");
    expect(db.statements[0]!.text).toContain("'interaction-applied-'||i.id");
    expect(db.statements[0]!.text).toContain(
      "j.notification_event_id=e.id AND j.device_id=i.device_id",
    );
    expect(db.statements[0]!.text).not.toContain("lease.last_command_sequence");
  });

  test("binds cursors to the notification filter and rejects device credentials",async () => {
    const db = new EvidenceDatabase();
    const first = deliveryEvidenceResponseSchema.parse(await (await application(db).request(
      `/api/evidence/timeline?notificationId=ntf_${eventId}&limit=1`,
    )).json());
    const changed = await application(db).request(
      `/api/evidence/timeline?notificationId=ntf_77777777-7777-4777-8777-777777777777&cursor=${encodeURIComponent(first.cursor!)}`,
    );
    expect(changed.status).toBe(410);
    expect(await changed.json()).toEqual({ error: "cursor_expired" });
    expect((await application(db,"device").request("/api/evidence/timeline")).status).toBe(403);
    expect((await application(db).request("/api/evidence/timeline?limit=101")).status).toBe(400);
  });

  test("returns aggregate label-free operational counters",async () => {
    const db = new EvidenceDatabase();
    const response = await application(db).request("/api/evidence/metrics");
    expect(response.status).toBe(200);
    const body = deliveryEvidenceMetricsSchema.parse(await response.json());
    expect(body).toEqual({
      version: 1,generatedAt: "2026-08-14T12:01:00.000Z",
      queue: { pendingJobs: 2,oldestAgeMs: 12_000 },worker: { lagMs: 4_000 },
      delivery: { retryRate1h: 0.25,ambiguousOutcomes1h: 1,invalidatedTokens24h: 3,
        receiptLatencyP95Ms24h: 900 },
    });
    expect(JSON.stringify(body)).not.toMatch(/notification|device|project|thread|tokenValue|content/i);
  });

  test("binds device-detail evidence to the requesting phone",async () => {
    const db = new EvidenceDatabase();
    await loadDeliveryEvidence(db as never,principalId,{
      notificationId: `ntf_${eventId}`,deviceId,limit: 25,
    });
    expect(db.statements[0]!.values?.[5]).toBe(deviceId);
    expect(db.statements[0]!.text).toContain("WHERE ($6::uuid IS NULL OR j.device_id=$6::uuid)");
    expect(db.statements[0]!.text).toContain("WHERE ($6::uuid IS NULL OR i.device_id=$6::uuid)");
    expect(db.statements[0]!.text).toContain(
      "WHERE ($6::uuid IS NULL OR w.device_id IS NULL OR w.device_id=$6::uuid)",
    );
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseSuite = databaseUrl ? describe : describe.skip;

databaseSuite("unified delivery evidence PostgreSQL behavior",() => {
  let db: Database;
  const ownerToken = "evidence_owner_abcdefghijklmnopqrstuvwxyz_0123456789";
  const otherToken = "evidence_other_abcdefghijklmnopqrstuvwxyz_0123456789";
  const deviceToken = "evidence_device_abcdefghijklmnopqrstuvwxyz_0123456789";

  beforeAll(async () => {
    db = createDatabase(databaseUrl!);
    await migrate(db);
  });

  beforeEach(async () => {
    await db.query(
      "TRUNCATE interactions,delivery_jobs,notification_events,device_credentials,devices,principal_api_keys,owner_principals CASCADE",
    );
    await bootstrapOwner(db,"evidence-owner",ownerToken);
    await bootstrapOwner(db,"evidence-other",otherToken);
    const principal = (await db.query<{ id: string }>(
      "SELECT principal_id AS id FROM principal_api_keys WHERE token_hash=$1",
      [hashToken(ownerToken)],
    )).rows[0]!.id;
    const device = (await db.query<{ id: string }>(
      `INSERT INTO devices(
         principal_id,stable_device_id,installation_id,name,bundle_identifier,app_version,app_build,
         os_version,apns_environment,apns_token,notification_authorization,live_activity_authorization
       ) VALUES ($1,$2,$3,'Evidence phone','com.example.relo.notifications','0.9.3','15','26.0',
         'sandbox',$4,'authorized','authorized') RETURNING id`,
      [principal,`stable-${randomUUID()}`,randomUUID(),"a".repeat(64)],
    )).rows[0]!.id;
    await db.query(
      `INSERT INTO device_credentials(device_id,token_hash,scopes)
       VALUES ($1,$2,ARRAY['inbox:read'])`,
      [device,hashToken(deviceToken)],
    );
  });

  afterAll(async () => db.end());

  const request = (path: string,token: string,init: RequestInit = {}) => createApp(db,{
    apnsMode: "disabled",credentialDerivationSecret: "evidence-test-purpose-secret-at-least-32-characters",
  }).request(path,{ ...init,headers: { authorization: `Bearer ${token}`,
    "content-type": "application/json",...init.headers } });

  test("orders durable stages, scopes accounts, and projects the same timeline into Inbox detail",async () => {
    const sent = await request("/api/notifications",ownerToken,{
      method: "POST",headers: { "idempotency-key": "evidence-owner-event" },
      body: JSON.stringify({ sourceName: "Codex",title: "Evidence release",body: "Safe summary" }),
    });
    expect(sent.status).toBe(201);
    const notificationId = String((await sent.json() as { eventId: string }).eventId);
    await request("/api/notifications",otherToken,{
      method: "POST",headers: { "idempotency-key": "evidence-other-event" },
      body: JSON.stringify({ sourceName: "Other",title: "Other account",body: "Not visible" }),
    });

    const timelineResponse = await request(
      `/api/evidence/timeline?notificationId=${encodeURIComponent(notificationId)}`,ownerToken,
    );
    expect(timelineResponse.status).toBe(200);
    const timeline = deliveryEvidenceResponseSchema.parse(await timelineResponse.json());
    expect(timeline.items.map((item) => item.stage)).toEqual([
      "queued","canonicalized","accepted",
    ]);
    expect(new Set(timeline.items.map((item) => item.notificationId))).toEqual(new Set([notificationId]));

    const accountTimeline = deliveryEvidenceResponseSchema.parse(await (
      await request("/api/evidence/timeline",ownerToken)
    ).json());
    expect(new Set(accountTimeline.items.map((item) => item.notificationId))).toEqual(
      new Set([notificationId]),
    );
    const detailResponse = await request(`/api/inbox/${notificationId}`,deviceToken);
    expect(detailResponse.status).toBe(200);
    const detail = await detailResponse.json() as any;
    expect(detail.evidence.version).toBe(1);
    expect(detail.evidence.timeline).toEqual(timeline.items);
    expect(deliveryEvidenceMetricsSchema.parse(await (
      await request("/api/evidence/metrics",ownerToken)
    ).json()).queue.pendingJobs).toBe(1);
  });
});
