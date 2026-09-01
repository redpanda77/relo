import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import {
  createDashboardConnectionsHandlers,
  type ConnectionsDashboardBootstrap,
} from "./dashboard-connections.js";

const principalId = "11111111-1111-4111-8111-111111111111";
const accountId = "acc_11111111-1111-4111-8111-111111111111";
const serviceId = "22222222-2222-4222-8222-222222222222";
const phoneId = "33333333-3333-4333-8333-333333333333";
const clientId = "44444444-4444-4444-8444-444444444444";
const now = "2026-08-07T08:00:00.000Z";

function rows(values: Record<string, unknown>[]) {
  return { rows: values, rowCount: values.length };
}

function testDatabase() {
  return {
    async query(sql: string, params: unknown[] = []) {
      expect(params[0]).toBe(principalId);
      if (sql.includes("AS services") && sql.includes("AS phones")) {
        return rows([
          {
            services: 26,
            phones: 1,
            clients: 1,
            pending: 2,
            notifications: 32,
            deliveries: 40,
          },
        ]);
      }
      if (sql.includes("FROM webhook_services WHERE")) {
        expect(params).toEqual([principalId, 25, 25]);
        return rows([
          {
            id: serviceId,
            title: "Deploy bot",
            secret_prefix: "kwh_••••42",
            image_url: "https://example.test/avatar.png",
            default_url: "https://example.test/deployments",
            created_at: now,
          },
        ]);
      }
      if (sql.includes("FROM devices WHERE")) {
        return rows([
          {
            id: phoneId,
            name: "Developer's iPhone",
            model: "iPhone",
            app_version: "1.0",
            os_version: "26.0",
            notification_authorization: "authorized",
            live_activity_authorization: "authorized",
            live_activity_schema_version: 2,
            interaction_capability_version: 1,
            last_seen_at: now,
          },
        ]);
      }
      if (sql.includes("FROM principal_api_keys WHERE")) {
        return rows([
          {
            id: clientId,
            label: "Codex Mac",
            token_prefix: "kal_cli_42",
            scopes: ["notifications:send", "activities:write"],
            created_at: now,
            expires_at: null,
            last_used_at: now,
          },
        ]);
      }
      return rows([]);
    },
  };
}

function app(authenticated = true) {
  const application = new Hono();
  const handlers = createDashboardConnectionsHandlers({
    db: testDatabase() as any,
    releaseIdentity: "test-release",
    getAccount: async () =>
      authenticated
        ? {
            principalId,
            accountId,
            user: { name: "Relo Owner", email: "owner@example.test" },
          }
        : null,
    renderDocument: async (bootstrap) => JSON.stringify(bootstrap),
  });
  application.get("/dashboard/connections/services", handlers.services);
  application.get("/dashboard/connections/phones", handlers.phones);
  application.get("/dashboard/connections/clients", handlers.clients);
  return application;
}

async function bootstrap(
  response: Response,
): Promise<ConnectionsDashboardBootstrap> {
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  const policy = response.headers.get("content-security-policy");
  expect(policy).toContain("default-src 'self'");
  expect(policy).toContain("script-src 'self'");
  expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
  return JSON.parse(await response.text()) as ConnectionsDashboardBootstrap;
}

describe("dashboard Connections handlers", () => {
  test("redirects anonymous requests back to the requested Connections route", async () => {
    const response = await app(false).request("/dashboard/connections/phones");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "/?next=%2Fdashboard%2Fconnections%2Fphones",
    );
  });

  test("serializes paginated account-scoped services without a secret", async () => {
    const result = await bootstrap(
      await app().request("/dashboard/connections/services?page=99"),
    );
    expect(result.kind).toBe("connections-services");
    if (result.kind !== "connections-services") return;
    expect(result.route.page).toBe(2);
    expect(result.pagination).toMatchObject({
      page: 2,
      pageCount: 2,
      total: 26,
      previousHref: "/dashboard/connections/services?page=1",
      nextHref: null,
    });
    expect(result.services[0]).toMatchObject({
      id: `svc_${serviceId}`,
      title: "Deploy bot",
      prefix: "kwh_••••42",
      liveActivityPolicy: null,
      liveActivityPolicySource: "system",
      effectiveLiveActivityPolicy: {
        preset: "automatic",
        colorStrategy: "thread",
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /webhookUrl|secretHash|rawSecret/i,
    );
  });

  test("serializes typed phone readiness fields", async () => {
    const result = await bootstrap(
      await app().request("/dashboard/connections/phones"),
    );
    expect(result.kind).toBe("connections-phones");
    if (result.kind !== "connections-phones") return;
    expect(result.phones[0]).toMatchObject({
      id: `dev_${phoneId}`,
      notificationAuthorization: "authorized",
      liveActivityAuthorization: "authorized",
    });
  });

  test("serializes client scopes without credential material", async () => {
    const result = await bootstrap(
      await app().request("/dashboard/connections/clients"),
    );
    expect(result.kind).toBe("connections-clients");
    if (result.kind !== "connections-clients") return;
    expect(result.clients[0]).toMatchObject({
      id: `key_${clientId}`,
      label: "Codex Mac",
      scopes: ["notifications:send", "activities:write"],
      liveActivityPolicy: null,
      liveActivityPolicySource: "system",
    });
    expect(JSON.stringify(result)).not.toMatch(
      /tokenHash|accessToken|credentialHash/i,
    );
  });
});
