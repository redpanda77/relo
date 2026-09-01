import { Hono } from "hono";
import { describe,expect,test } from "vitest";
import { registerDeliveryObservabilityRoutes } from "./delivery-observability.js";

const principalId = "11111111-1111-4111-8111-111111111111";
const deliveryId = "22222222-2222-4222-8222-222222222222";
const eventId = "33333333-3333-4333-8333-333333333333";
const deviceId = "44444444-4444-4444-8444-444444444444";
const attemptId = "55555555-5555-4555-8555-555555555555";

class FakeDeliveryDatabase {
  readonly statements: Array<{ text: string; values?: unknown[] }> = [];
  owned = true;
  deliveryRows = [deliveryRow(),deliveryRow({
    id: "66666666-6666-4666-8666-666666666666",
    cursor_created_at: "2026-08-07T10:59:00.000000Z",
    created_at: new Date("2026-08-07T10:59:00.000Z"),
  })];
  attemptRows = [attemptRow(),attemptRow({
    id: "77777777-7777-4777-8777-777777777777",
    cursor_created_at: "2026-08-07T10:58:00.000000Z",
    created_at: new Date("2026-08-07T10:58:00.000Z"),
  })];

  async query(text: string,values?: unknown[]) {
    this.statements.push({ text,...(values ? { values } : {}) });
    if (text.startsWith("SELECT 1 FROM delivery_jobs")) {
      return { rowCount: this.owned ? 1 : 0,rows: this.owned ? [{ exists: 1 }] : [] };
    }
    if (text.includes("FROM delivery_attempts a WHERE a.delivery_job_id")) {
      return { rowCount: this.attemptRows.length,rows: this.attemptRows };
    }
    if (text.includes("FROM delivery_jobs j")) {
      return { rowCount: this.deliveryRows.length,rows: this.deliveryRows };
    }
    return { rowCount: 0,rows: [] };
  }
}

function deliveryRow(overrides: Record<string,unknown> = {}) {
  return {
    id: deliveryId,event_id: eventId,device_id: deviceId,device_name: "Phone",
    transport: "notification",state: "accepted",attempt_count: 2,
    available_at: new Date("2026-08-07T11:00:00.000Z"),
    provider_message_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    accepted_at: new Date("2026-08-07T11:00:02.000Z"),
    provider_outcome_category: "accepted",provider_status: 200,
    provider_transport_code: null,last_error_code: null,provider_attempts_used: 2,
    provider_retry_started_at: new Date("2026-08-07T11:00:00.300Z"),
    provider_retry_attempt_cap: 3,provider_retry_horizon_at: new Date("2026-08-07T12:00:00.000Z"),
    provider_next_attempt_not_before: new Date("2026-08-07T11:15:00.000Z"),
    last_provider_attempt_at: new Date("2026-08-07T11:00:02.000Z"),
    first_claimed_at: new Date("2026-08-07T11:00:00.100Z"),
    last_claimed_at: new Date("2026-08-07T11:00:00.100Z"),
    last_dispatch_started_at: new Date("2026-08-07T11:00:00.200Z"),apns_priority: 10,
    canonical_intent_sha256: "a".repeat(64),
    device_projection_sha256: "b".repeat(64),apns_payload_sha256: "c".repeat(64),
    event_created_at: new Date("2026-08-07T10:59:59.900Z"),
    created_at: new Date("2026-08-07T11:00:00.000Z"),updated_at: new Date("2026-08-07T11:00:02.000Z"),
    cursor_created_at: "2026-08-07T11:00:00.000000Z",received_at: null,opened_at: null,
    provider_reason: "reason containing secret content",invalidated_at: null,cursor_valid: true,
    ...overrides,
  };
}

function attemptRow(overrides: Record<string,unknown> = {}) {
  return {
    id: attemptId,job_attempt: 2,provider_attempts: 1,outcome_category: "invalid-recipient",
    provider_status: 410,provider_reason: "BadDeviceToken",
    provider_message_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",transport_code: null,
    invalidated_at: new Date("2026-08-07T11:00:02.000Z"),
    provider_first_attempt_at: new Date("2026-08-07T11:00:00.000Z"),
    created_at: new Date("2026-08-07T11:00:02.000Z"),
    cursor_created_at: "2026-08-07T11:00:02.000000Z",cursor_valid: true,
    ...overrides,
  };
}

function application(db: FakeDeliveryDatabase,credentialKind: "principal" | "device" = "principal") {
  const app = new Hono();
  app.use("*",async (context,next) => {
    context.set("auth",{
      principalId,scopes: new Set(["devices:read"]),credentialKind,
      ...(credentialKind === "device" ? { deviceId } : { credentialId: "credential-id" }),
    });
    await next();
  });
  registerDeliveryObservabilityRoutes(app,db as never,"disabled");
  return app;
}

describe("account delivery observability API", () => {
  test("separates APNs acceptance from exact device receipt and redacts diagnostics", async () => {
    const db = new FakeDeliveryDatabase();
    const response = await application(db).request("/api/deliveries?limit=1");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json() as any;
    expect(body).toMatchObject({
      apns: { mode: "disabled",remoteEnqueueEnabled: false,providerCredentialActive: false,
        deliverySemantics: "durable_inbox_refresh_only" },
      hasMore: true,cursor: expect.any(String),deliveries: [{
        id: `job_${deliveryId}`,notificationId: `ntf_${eventId}`,
        device: { id: `dev_${deviceId}`,name: "Phone" },status: "accepted_by_apns",
        provider: { acceptedAt: "2026-08-07T11:00:02.000Z",status: 200,reason: null,priority: 10 },
        receipt: { receivedAt: null,openedAt: null },
        retry: { providerAttemptsUsed: 2,attemptCap: 3 },
        serialization: {
          canonicalIntent: "sha256:aaaaaaaaaaaa",
          deviceProjection: "sha256:bbbbbbbbbbbb",providerBytes: "sha256:cccccccccccc",
        },
        reconciliation: { required: false,code: null },
        timeline: { apiCommittedAt: "2026-08-07T10:59:59.900Z",
          apnsRequestStartedAt: "2026-08-07T11:00:00.300Z",deviceReceivedAt: null },
        latencyMs: { commitToEnqueue: 100,enqueueToFirstClaim: 100,
          firstClaimToApnsRequest: 200,apnsRequestToAcceptance: 1_700,
          commitToAcceptance: 2_100,acceptanceToDeviceReceipt: null },
      }],
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("secret content");
    expect(serialized).not.toMatch(/apns_token|claim_token|payload/i);
    expect(db.statements[0]!.values?.[0]).toBe(principalId);
    expect(db.statements[0]!.text).toContain("d.principal_id=e.principal_id");
  });

  test("binds delivery cursors to endpoint filters and rejects device credentials", async () => {
    const db = new FakeDeliveryDatabase();
    const first = await (await application(db).request(
      `/api/deliveries?limit=1&deviceId=dev_${deviceId}`,
    )).json() as any;
    const changedFilter = await application(db).request(
      `/api/deliveries?limit=1&deviceId=dev_99999999-9999-4999-8999-999999999999&cursor=${encodeURIComponent(first.cursor)}`,
    );
    expect(changedFilter.status).toBe(410);
    expect(await changedFilter.json()).toEqual({ error: "cursor_expired" });
    expect((await application(db,"device").request("/api/deliveries")).status).toBe(403);
    expect((await application(db).request("/api/deliveries?limit=101")).status).toBe(400);
    expect((await application(db).request("/api/deliveries?status=unknown")).status).toBe(400);
    const status = await (await application(db).request("/api/deliveries/status")).json();
    expect(status).toEqual({ apns: {
      mode: "disabled",remoteEnqueueEnabled: false,providerCredentialActive: false,
      deliverySemantics: "durable_inbox_refresh_only",
    } });
  });

  test("paginates append-only attempts without exposing claim identity", async () => {
    const db = new FakeDeliveryDatabase();
    const response = await application(db).request(`/api/deliveries/job_${deliveryId}/attempts?limit=1`);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body).toMatchObject({
      deliveryId: `job_${deliveryId}`,hasMore: true,cursor: expect.any(String),attempts: [{
        id: `att_${attemptId}`,deliveryId: `job_${deliveryId}`,jobAttempt: 2,providerAttempts: 1,
        outcome: "invalid-recipient",providerStatus: 410,providerReason: "BadDeviceToken",
        tokenInvalidatedAt: "2026-08-07T11:00:02.000Z",
      }],
    });
    expect(JSON.stringify(body)).not.toMatch(/claim|token_generation|payload/i);
    db.owned = false;
    expect((await application(db).request(`/api/deliveries/job_${deliveryId}/attempts`)).status).toBe(404);
  });
});
