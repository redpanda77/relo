import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import {
  createDashboardConnectionsHandlers,
  type ConnectionsDashboardBootstrap,
} from "./dashboard-connections.js";
import { connectionsOverviewSchema } from "@relo/notification-contracts/dashboard/connections";

const principalId = "11111111-1111-4111-8111-111111111111";
const accountId = "acc_11111111-1111-4111-8111-111111111111";
const serviceId = "22222222-2222-4222-8222-222222222222";
const phoneId = "33333333-3333-4333-8333-333333333333";
const clientId = "44444444-4444-4444-8444-444444444444";
const ciTokenId = "55555555-5555-4555-8555-555555555555";
const computerId = "66666666-6666-4666-8666-666666666666";
const hookId = "77777777-7777-4777-8777-777777777777";
const orphanHookId = "88888888-8888-4888-8888-888888888888";
const expires = "2026-09-06T08:00:00.000Z";
const now = "2026-08-07T08:00:00.000Z";

function rows(values: Record<string, unknown>[]) {
  return { rows: values, rowCount: values.length };
}

function testDatabase() {
  return {
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes("LATERAL")) {
        expect(params).toEqual([[computerId]]);
        return rows([{
          id: computerId, tools: ["claude-code", "codex"], open_cards: 2, last_seen_at: now, has_keys: true,
          hooks: [{ id: hookId, name: "codex-mac", prefix: "relo_hk_1", createdAt: now, lastUsedAt: null }],
        }]);
      }
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
        expect(params).toEqual([principalId, 200]);
        return rows([
          {
            id: serviceId,
            title: "Deploy bot",
            secret_prefix: "kwh_••••42",
            image_url: "https://example.test/avatar.png",
            default_url: "https://example.test/deployments",
            readable_allowed: true,
            scopes: ["hooks:read", "hooks:notify", "retired:scope"],
            last_used_at: now,
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
      if (sql.includes("FROM computers c JOIN principal_api_keys k")) {
        return rows([{
          id: computerId, principal_id: principalId, login_key_id: clientId, display_name: null, icon: null, report: null, reported_at: null,
          created_at: now, updated_at: now, label: "Codex Mac", token_prefix: "kal_cli_42", scopes: ["notifications:send", "activities:write"],
          login_created_at: now, expires_at: null, last_used_at: now, live_activity_policy: null, max_active_cards: null,
        }]);
      }
      if (sql.includes("FROM harness_credentials h")) {
        return rows([{ id: orphanHookId, name: "old-laptop", token_prefix: "relo_hk_9", created_at: now, last_used_at: null }]);
      }
      if (sql.includes("FROM principal_api_keys WHERE")) {
        expect(sql).toContain("kind='ci-token'");
        return rows([
          {
            id: ciTokenId,
            kind: "ci-token",
            label: "Deploy pipeline",
            token_prefix: "relo_ci_7",
            scopes: ["activities:write", "interactions:create"],
            created_at: now,
            expires_at: expires,
            last_used_at: null,
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
  application.get("/dashboard/connections", handlers.overview);
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
  test("redirects anonymous requests back to Connections", async () => {
    const response = await app(false).request("/dashboard/connections");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/sign-in?next=%2Fdashboard%2Fconnections");
  });

  test("serves phones, computers, CI tokens and webhooks in one page without secrets or credential material", async () => {
    const result = await bootstrap(await app().request("/dashboard/connections"));
    expect(result.kind).toBe("connections");
    if (result.kind !== "connections") return;
    expect(result.shell.active).toBe("connections");
    expect(result.phones[0]).toMatchObject({
      id: `dev_${phoneId}`,
      notificationAuthorization: "authorized",
      liveActivityAuthorization: "authorized",
    });
    expect(result.computers[0]).toMatchObject({
      id: `cmp_${computerId}`,
      loginId: `key_${clientId}`,
      name: "Codex Mac",
      label: "Codex Mac",
      icon: "laptop",
      iconSource: "default",
      tools: ["claude-code", "codex"],
      openCards: 2,
      lastSeenAt: now,
      scopes: ["notifications:send", "activities:write"],
      encryption: "encrypts",
      liveActivityPolicySource: "system",
      hooks: [{ id: `hck_${hookId}`, name: "codex-mac", prefix: "relo_hk_1" }],
    });
    expect(result.unlinkedHooks).toEqual([expect.objectContaining({ id: `hck_${orphanHookId}`, name: "old-laptop" })]);
    expect(result.ciTokens[0]).toEqual(expect.objectContaining({
      id: `key_${ciTokenId}`,
      kind: "ci-token",
      label: "Deploy pipeline",
      prefix: "relo_ci_7",
      scopes: ["activities:write", "interactions:create"],
      createdAt: now,
      expiresAt: expires,
      lastUsedAt: null,
    }));
    expect(result.services[0]).toMatchObject({
      id: `svc_${serviceId}`,
      title: "Deploy bot",
      liveActivityPolicySource: "system",
      effectiveLiveActivityPolicy: { colorStrategy: "project" },
      readableAllowed: true,
      scopes: ["hooks:notify", "hooks:read"],
      lastUsedAt: now,
    });
    expect(connectionsOverviewSchema.safeParse(result).success).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/webhookUrl|secretHash|rawSecret|tokenHash|accessToken|credentialHash/i);
  });
});

describe("dashboard Connections counts", () => {
  test("counts only logins as computers", async () => {
    const queries: string[] = [];
    const database = testDatabase();
    const handlers = createDashboardConnectionsHandlers({
      db: { query: (sql: string, params?: unknown[]) => { queries.push(sql); return database.query(sql, params); } } as any,
      releaseIdentity: "test-release",
      getAccount: async () => ({ principalId, accountId, user: { name: "Relo Owner", email: "owner@example.test" } }),
      renderDocument: async (bootstrap) => JSON.stringify(bootstrap),
    });
    const application = new Hono();
    application.get("/dashboard/connections", handlers.overview);
    await bootstrap(await application.request("/dashboard/connections"));
    const summary = queries.find((sql) => sql.includes("AS clients"));
    expect(summary).toMatch(/principal_api_keys WHERE principal_id=\$1 AND kind='login'/);
  });
});
