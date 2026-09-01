import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { createDashboardTestLabHandler } from "./dashboard-test-lab.js";

const account = {
  principalId: "11111111-1111-4111-8111-111111111111",
  accountId: "acc_11111111-1111-4111-8111-111111111111",
  user: { name: "Owner", email: "owner@example.test" },
};
const activityId = "22222222-2222-4222-8222-222222222222";
const deviceId = "33333333-3333-4333-8333-333333333333";
const presentation = {
    content: { header: "Relo",title: "Release #42",subtitle: "Compiling",status: "Building" },
  identity: { project: null,thread: null,direct: true },
  state: { kind: "active",tone: "live",icon: "active" },
  components: [{ id: "progress",type: "progress_bar",colorRole: "project",value: 0.68,label: null }],
  surfaces: { lock_screen: ["progress"],expanded_leading: [],expanded_trailing: ["progress"],
    expanded_bottom: ["progress"],compact_leading: [],compact_trailing: ["progress"],minimal: ["progress"] },
  behavior: { type: "progress" },
  appearance: { theme: "system",roles: {
    cardIdentity: "project",componentIdentity: "thread",statusEmphasis: "state",
  } },
  privacy: "standard",
};

function application(options: { authenticated?: boolean; includeRun?: boolean } = {}) {
  const app = new Hono();
  const handler = createDashboardTestLabHandler({
    db: {
      async query(sql: string, values: unknown[]) {
        expect(values[0]).toBe(account.principalId);
        if (sql.includes("FROM devices\n         WHERE principal_id")) {
          return {
            rowCount: 1,
            rows: [
              {
                id: deviceId,
                name: "iPhone",
                model: "iPhone 17 Pro",
                app_version: "1.0",
                os_version: "19.0",
                notification_authorization: "authorized",
                live_activity_authorization: "authorized",
                live_activity_schema_version: 2,
                interaction_capability_version: 2,
                last_seen_at: "2026-08-08T00:00:00.000Z",
              },
            ],
          };
        }
        const rows = options.includeRun
          ? [
              {
                id: activityId,
                title: "Release #42",
                detail: "Compiling",
                style: "standard",
                status: "Building",
                state: "active",
                progress: 0.68,
                generation: 3,
                sequence: 5,
                target_device_ids: [deviceId],
                target_device_name: "iPhone",
                delivery_summary: { durableCommands: 1, apnsJobs: 1 },
                expected_receipts: 1,
                confirmed_receipts: 0,
                requester_label: "Dashboard",
                requester_service_id: null,
                requester_credential_id: null,
                presentation,
                presentation_sha256: null,
              },
            ]
          : [];
        return { rowCount: rows.length, rows };
      },
    } as any,
    getAccount: async () =>
      options.authenticated === false ? null : account,
    releaseIdentity: "test-release",
    presets: [],
    renderDocument: async (bootstrap) => JSON.stringify(bootstrap),
  });
  app.get("/dashboard/testing", handler);
  app.get("/dashboard/testing/runs/:activityId", handler);
  return app;
}

describe("React Test Lab dashboard projection", () => {
  test("redirects an unauthenticated owner without querying private data", async () => {
    const response = await application({ authenticated: false }).request(
      "/dashboard/testing",
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("next=");
  });

  test("renders account-scoped devices and generation-aware runs", async () => {
    const response = await application({ includeRun: true }).request(
      `/dashboard/testing/runs/act_${activityId}?compose=1`,
    );
    expect(response.status).toBe(200);
    const bootstrap = await response.json();
    expect(bootstrap).toMatchObject({
      kind: "test-lab",
      route: {
        selectedActivityId: `act_${activityId}`,
        compose: true,
      },
      summary: { total: 1, active: 1 },
      runs: [
        {
          id: `act_${activityId}`,
          generation: 3,
          sequence: 5,
          targetDeviceIds: [`dev_${deviceId}`],
        },
      ],
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  test("does not expose a missing or foreign selected activity", async () => {
    const response = await application().request(
      `/dashboard/testing/runs/act_${activityId}`,
    );
    expect(response.status).toBe(404);
  });
});
