import { describe,expect,test } from "vitest";
import {
  DeliveryReconciliationError,allowedDeliveryReconciliationActions,reconcileDeliveryJob,
} from "./delivery-reconciliation.js";

const jobId = "11111111-1111-4111-8111-111111111111";
const principalId = "22222222-2222-4222-8222-222222222222";
const credentialId = "33333333-3333-4333-8333-333333333333";

function database(row: Record<string,unknown>) {
  const calls: Array<{ sql: string;params: unknown[] }> = [];
  let resolution: { action: string;resulting_state: string } | null = null;
  const client = {
    async query(sql: string,params: unknown[] = []) {
      calls.push({ sql,params });
      if (sql.includes("SELECT j.*")) return { rows: [{ ...row,
        reconciliation_action: resolution?.action ?? null,
        reconciliation_resulting_state: resolution?.resulting_state ?? null,
      }],rowCount: 1 };
      if (sql.includes("UPDATE delivery_jobs SET state=")) {
        row.state = params[1];
        return { rows: [],rowCount: 1 };
      }
      if (sql.includes("INSERT INTO delivery_reconciliation_resolutions")) {
        resolution = { action: String(params[4]),resulting_state: String(params[6]) };
      }
      return { rows: [],rowCount: 1 };
    },
    release() {},
  };
  return { calls,db: { connect: async () => client } as any };
}

function base(overrides: Record<string,unknown> = {}) {
  return {
    id: jobId,notification_event_id: "44444444-4444-4444-8444-444444444444",
    state: "reconciliation_required",requester_credential_id: credentialId,
    last_error_code: "provider_dispatch_persistence_failed",provider_message_id: null,
    transport: "live_activity_update",payload: { liveActivity: { operation: "update" } },
    ...overrides,
  };
}

describe("delivery reconciliation", () => {
  test("permits only evidence-backed acceptance, sequence-safe replay, and cancellation", () => {
    expect(allowedDeliveryReconciliationActions(base())).toEqual(["retry","cancel"]);
    expect(allowedDeliveryReconciliationActions(base({
      last_error_code: "known_apns_acceptance_persistence_failed",provider_message_id: "apns-id",
      payload: { liveActivity: { operation: "start" } },
    }))).toEqual(["mark_accepted","cancel"]);
    expect(allowedDeliveryReconciliationActions(base({
      transport: "notification",payload: {},
    }))).toEqual(["cancel"]);
  });

  test("records a credential-owned safe replay and returns an idempotent result", async () => {
    const fixture = database(base());
    const input = {
      principalId,deliveryJobId: jobId,action: "retry" as const,
      actor: { kind: "credential" as const,credentialId },
    };
    expect(await reconcileDeliveryJob(fixture.db,input)).toMatchObject({
      action: "retry",state: "retry",replayed: false,
    });
    expect(await reconcileDeliveryJob(fixture.db,input)).toMatchObject({
      action: "retry",state: "retry",replayed: true,
    });
    expect(fixture.calls.some(({ sql }) => sql.includes("INSERT INTO delivery_reconciliation_resolutions"))).toBe(true);
  });

  test("rejects blind retry for an ambiguous start or another credential", async () => {
    const unsafe = database(base({ payload: { liveActivity: { operation: "start" } } }));
    await expect(reconcileDeliveryJob(unsafe.db,{
      principalId,deliveryJobId: jobId,action: "retry",actor: { kind: "dashboard" },
    })).rejects.toEqual(new DeliveryReconciliationError("unsafe_reconciliation_action",409));
    const foreign = database(base());
    await expect(reconcileDeliveryJob(foreign.db,{
      principalId,deliveryJobId: jobId,action: "cancel",
      actor: { kind: "credential",credentialId: "55555555-5555-4555-8555-555555555555" },
    })).rejects.toEqual(new DeliveryReconciliationError("delivery_not_found",404));
  });
});
