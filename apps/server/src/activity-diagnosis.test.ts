import { describe,expect,test } from "vitest";
import { Hono } from "hono";
import { loadActivityDiagnosis } from "./activity-diagnosis.js";
import { registerDeliveryObservabilityRoutes } from "./delivery-observability.js";

const principalId = "11111111-1111-4111-8111-111111111111";
const activityId = "22222222-2222-4222-8222-222222222222";
const deviceId = "33333333-3333-4333-8333-333333333333";
const deliveryId = "44444444-4444-4444-8444-444444444444";
const eventId = "55555555-5555-4555-8555-555555555555";

class DiagnosisDatabase {
  activity = activityRow();
  devices = [deviceRow()];
  readonly statements: Array<{ text: string; values?: unknown[] }> = [];

  async query(text: string,values?: unknown[]) {
    this.statements.push({ text,...(values ? { values } : {}) });
    if (text.startsWith("SELECT id,generation,sequence,state,target_device_ids")) {
      return { rows: this.activity ? [this.activity] : [],rowCount: this.activity ? 1 : 0 };
    }
    if (text.startsWith("SELECT d.id,d.name")) {
      return { rows: this.devices,rowCount: this.devices.length };
    }
    return { rows: [],rowCount: 0 };
  }
}

function activityRow(overrides: Record<string,unknown> = {}) {
  return {
    id: activityId,generation: 1,sequence: 0,state: "active",target_device_ids: [deviceId],
    created_at: new Date("2026-08-18T12:00:00.000Z"),
    updated_at: new Date("2026-08-18T12:00:00.000Z"),ended_at: null,...overrides,
  };
}

function deviceRow(overrides: Record<string,unknown> = {}) {
  return {
    id: deviceId,name: "Test iPhone",apns_environment: "sandbox",
    live_activity_authorization: "authorized",has_push_to_start_token: true,
    has_update_token: false,token_updated_at: null,delivery_job_id: deliveryId,
    notification_event_id: eventId,delivery_state: "accepted",
    job_created_at: new Date("2026-08-18T12:00:00.100Z"),
    accepted_at: new Date("2026-08-18T12:00:00.400Z"),
    provider_outcome_category: "accepted",last_error_code: null,provider_status: 200,
    provider_transport_code: null,command_created_at: new Date("2026-08-18T12:00:00.000Z"),
    operation: "start",received_at: null,provider_reason: null,...overrides,
  };
}

describe("Live Activity delivery diagnosis",() => {
  test("serves only an account-scoped, no-store principal diagnosis",async () => {
    const db = new DiagnosisDatabase();
    const app = new Hono();
    app.use("*",async (context,next) => {
      context.set("auth",{
        principalId,credentialId: "credential-id",credentialKind: "principal",
        scopes: new Set(["devices:read"]),
      });
      await next();
    });
    registerDeliveryObservabilityRoutes(app,db as never,"sandbox");
    const response = await app.request(`/api/live-activities/act_${activityId}/diagnosis`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({
      activity: { id: `act_${activityId}` },
      assessment: { problemStage: "phone" },
    });
    expect(db.statements[0]!.values).toEqual([activityId,principalId]);
  });

  test("stops at APNs when a remotely accepted start has no phone creation proof",async () => {
    const db = new DiagnosisDatabase();
    const diagnosis = await loadActivityDiagnosis(db as never,principalId,activityId,"sandbox");
    expect(diagnosis).toMatchObject({
      activity: { id: `act_${activityId}`,operation: "start",generation: 1,sequence: 0 },
      targets: { expected: 1,found: 1,confirmed: 0 },
      assessment: {
        status: "unconfirmed",lastConfirmedStage: "apns",problemStage: "phone",
        code: "PHONE_CREATION_UNCONFIRMED",
      },
      devices: [{
        server: { state: "command_queued",deliveryId: `job_${deliveryId}` },
        apns: { state: "accepted",providerStatus: 200 },
        phone: { activityCreated: "unconfirmed",latestCommandApplied: "unconfirmed" },
      }],
    });
    expect(db.statements[1]!.values).toEqual([principalId,activityId,[deviceId],0,1]);
    expect(db.statements[1]!.text).toContain("i.notification_event_id=j.notification_event_id");
    expect(db.statements[1]!.text).toContain("t.generation=$5");
    expect(JSON.stringify(diagnosis)).not.toMatch(/native_activity_id|provider_reason|payload|token_value/i);
  });

  test("uses the current-generation update-token registration as phone creation proof",async () => {
    const db = new DiagnosisDatabase();
    db.devices = [deviceRow({
      has_update_token: true,token_updated_at: new Date("2026-08-18T12:00:00.700Z"),
    })];
    const diagnosis = await loadActivityDiagnosis(db as never,principalId,activityId,"sandbox");
    expect(diagnosis?.assessment).toMatchObject({
      status: "healthy",lastConfirmedStage: "phone",problemStage: null,
      code: "PHONE_ACTIVITY_CREATED",
    });
    expect(diagnosis?.devices[0].phone).toEqual({
      activityCreated: "confirmed",activityCreatedAt: "2026-08-18T12:00:00.700Z",
      latestCommandApplied: "unconfirmed",latestCommandAppliedAt: null,
    });
  });

  test("requires an exact receipt for the latest update command",async () => {
    const db = new DiagnosisDatabase();
    db.activity = activityRow({ sequence: 3,updated_at: new Date("2026-08-18T12:03:00.000Z") });
    db.devices = [deviceRow({
      operation: "update",has_update_token: true,
      token_updated_at: new Date("2026-08-18T12:00:00.700Z"),
      received_at: new Date("2026-08-18T12:03:00.800Z"),
    })];
    const diagnosis = await loadActivityDiagnosis(db as never,principalId,activityId,"sandbox");
    expect(diagnosis?.activity.operation).toBe("update");
    expect(diagnosis?.assessment).toMatchObject({
      status: "healthy",code: "PHONE_COMMAND_APPLIED",lastConfirmedStage: "phone",
    });
    expect(diagnosis?.devices[0].phone.latestCommandAppliedAt).toBe("2026-08-18T12:03:00.800Z");
  });

  test("identifies a terminal APNs rejection without exposing the raw reason",async () => {
    const db = new DiagnosisDatabase();
    db.devices = [deviceRow({
      delivery_state: "permanently_failed",accepted_at: null,
      provider_outcome_category: "invalid-recipient",last_error_code: "BadDeviceToken",
      provider_reason: "reason containing secret context",
    })];
    const diagnosis = await loadActivityDiagnosis(db as never,principalId,activityId,"sandbox");
    expect(diagnosis?.assessment).toMatchObject({
      status: "failed",lastConfirmedStage: "server",problemStage: "apns",
      code: "APNS_TOKEN_INVALID",
    });
    expect(JSON.stringify(diagnosis)).not.toContain("secret context");
  });
});
