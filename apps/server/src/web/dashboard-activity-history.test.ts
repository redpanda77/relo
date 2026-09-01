import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import {
  createDashboardActivityHistoryHandler,
  type ActivityHistoryBootstrap,
} from "./dashboard-activity-history.js";

const principalId = "11111111-1111-4111-8111-111111111111";
const activityId = "22222222-2222-4222-8222-222222222222";
const deviceId = "33333333-3333-4333-8333-333333333333";
const eventId = "44444444-4444-4444-8444-444444444444";
const predecessorId = "55555555-5555-4555-8555-555555555555";
const relationshipId = "66666666-6666-4666-8666-666666666666";
const decisionId = "77777777-7777-4777-8777-777777777777";
const now = "2026-08-08T01:00:00.000Z";

function rows(values: Record<string, unknown>[]) {
  return { rows: values, rowCount: values.length };
}

function application(authenticated = true) {
  const app = new Hono();
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const handler = createDashboardActivityHistoryHandler({
    db: {
      async query(sql: string, params: unknown[] = []) {
        queries.push({ sql, params });
        if (sql.includes("FROM live_activities a")) {
          if (params[0] !== activityId || params[1] !== principalId)
            return rows([]);
          return rows([
            {
              id: activityId,
              activity_key: "dashboard-test-browser",
              title: "Release 42",
              status: "Building",
              detail: "Compiling the notification pipeline",
              progress: 0.68,
              symbol: "shippingbox",
              style: "progress",
              privacy: "standard",
              accent_color: "#ff6b57",
              state: "active",
              generation: 2,
              sequence: 3,
              lifecycle_provider: "codex",
              lifecycle_run_id: "codex-run-0123456789abcdef",
              target_device_ids: [deviceId],
              expires_at: now,
              stale_at: now,
              created_at: now,
              updated_at: now,
              ended_at: null,
              requester_label: "Dashboard",
            },
          ]);
        }
        if (sql.includes("FROM live_activity_operations"))
          return rows([
            {
              operation: "update",
              resulting_sequence: 3,
              delivery_summary: { durableCommands: 1, apnsJobs: 1 },
              dismiss_after_seconds: null,
              companion_activity_id: null,
              created_at: now,
            },
          ]);
        if (sql.includes("FROM notification_events"))
          return rows([
            {
              id: eventId,
              kind: "live_activity",
              title: "Release 42",
              state: "active",
              created_at: now,
            },
          ]);
        if (sql.includes("FROM devices"))
          return rows([
            { id: deviceId, name: "Test iPhone", last_seen_at: now },
          ]);
        if (sql.includes("FROM activity_relationships relationship"))
          return rows([
            {
              id: relationshipId,
              kind: "continuation",
              actor: "cli",
              reason: "same_origin_generation",
              provenance: "runtime",
              created_at: now,
              predecessor_id: predecessorId,
              predecessor_title: "Release 41",
              predecessor_state: "ended",
              predecessor_generation: 1,
              successor_id: activityId,
              successor_title: "Release 42",
              successor_state: "active",
              successor_generation: 2,
            },
          ]);
        if (sql.includes("FROM activity_correlation_decisions"))
          return rows([
            {
              id: decisionId,
              outcome: "resumed",
              matched_by: "origin",
              actor: "cli",
              reason: "same_origin_generation",
              provenance: "runtime",
              relationship_id: relationshipId,
              created_at: now,
            },
          ]);
        return rows([]);
      },
    } as any,
    releaseIdentity: "test-release",
    getAccount: async () =>
      authenticated
        ? {
            principalId,
            accountId: "acc_owner",
            user: { name: "Relo Owner", email: "owner@example.test" },
          }
        : null,
    renderDocument: async (bootstrap) => JSON.stringify(bootstrap),
  });
  app.get("/dashboard/testing/runs/:activityId/history", handler);
  return { app, queries };
}

describe("dashboard activity history handler", () => {
  test("redirects an anonymous request back through owner authentication", async () => {
    const response = await application(false).app.request(
      `/dashboard/testing/runs/act_${activityId}/history`,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("next=");
  });

  test("serializes one account-scoped lifecycle with generation evidence", async () => {
    const { app, queries } = application();
    const response = await app.request(
      `/dashboard/testing/runs/act_${activityId}/history`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-security-policy")).toContain(
      "style-src 'self' 'unsafe-inline'",
    );
    const result = JSON.parse(
      await response.text(),
    ) as ActivityHistoryBootstrap;
    expect(result.kind).toBe("activity-history");
    expect(result.activity).toMatchObject({
      id: `act_${activityId}`,
      generation: 2,
      sequence: 3,
      lifecycle: { provider: "codex",runId: "codex-run-0123456789abcdef" },
    });
    expect(result.targetDevices[0]?.id).toBe(`dev_${deviceId}`);
    expect(result.events[0]?.id).toBe(`ntf_${eventId}`);
    expect(result.relationships).toEqual([
      expect.objectContaining({
        id: `rel_${relationshipId}`,
        direction: "predecessor",
        relatedActivity: expect.objectContaining({ id: `act_${predecessorId}` }),
      }),
    ]);
    expect(result.correlationDecisions).toEqual([
      expect.objectContaining({
        id: `cor_${decisionId}`,
        outcome: "resumed",
        relationshipId: `rel_${relationshipId}`,
      }),
    ]);
    expect(queries[0]?.params).toEqual([activityId, principalId]);
    expect(JSON.stringify(result)).not.toMatch(
      /"(?:token|credentialHash|idempotencyKey|payload)"/i,
    );
  });

  test("returns not found for malformed public activity IDs", async () => {
    const { app, queries } = application();
    const response = await app.request(
      "/dashboard/testing/runs/not-an-activity/history",
    );
    expect(response.status).toBe(404);
    expect(queries).toHaveLength(0);
  });
});
