import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { registerWebAuthRoutes, safeDashboardDestination } from "../web.js";

function currentPresentation(title: string,status: string,progress: number) {
  return {
        content: { header: "Relo",title,subtitle: null,status },
    identity: { project: null,thread: null,direct: true },
    state: { kind: status === "Finished" ? "completed" : "active",
      tone: status === "Finished" ? "success" : "live",
      icon: status === "Finished" ? "completed" : "active" },
    components: [{ id: "progress",type: "progress_bar",colorRole: "project",value: progress,label: null }],
    surfaces: { lock_screen: ["progress"],expanded_leading: [],expanded_trailing: ["progress"],
      expanded_bottom: ["progress"],compact_leading: [],compact_trailing: ["progress"],minimal: ["progress"] },
    behavior: { type: "progress" },
    appearance: { theme: "system",roles: {
      cardIdentity: "project",componentIdentity: "thread",statusEmphasis: "state",
    } },
    privacy: "standard",
  };
}

function routeApp(): Hono {
  const app = new Hono();
  const db = { query: async () => ({ rows: [], rowCount: 0 }) };
  const accountAuth = {
    api: { getSession: async () => null },
    handler: async () => new Response(JSON.stringify(null), {
      headers: { "content-type": "application/json" },
    }),
  };
  registerWebAuthRoutes(app, db as any, {
    accountAuth: accountAuth as any,
    bootstrapOwnerHandle: "owner",
    appUrl: "http://127.0.0.1:8180",
    credentialDerivationSecret: "test-secret",
    apnsMode: "disabled",
    reconcileActivities: async () => 0,
  });
  return app;
}

function authenticatedRouteApp(options: { empty?: boolean } = {}): Hono {
  const app = new Hono();
  const now = "2026-08-07T08:00:00.000Z";
  const activities = options.empty ? [] : [
    {
      id: "11111111-1111-4111-8111-111111111111",
      title: "Release active",
      detail: "Compiling the notification pipeline",
      style: "standard",
      status: "Building",
      state: "active",
      progress: 0.42,
      symbol: "build",
      privacy: "standard",
      accent_color: "#5ED8B7",
      presentation: currentPresentation("Release active","Building",0.42),
      presentation_sha256: null,
      sequence: 3,
      created_at: now,
      updated_at: now,
      target_device_ids: ["33333333-3333-4333-8333-333333333333"],
      target_device_name: "Test iPhone",
      delivery_state: "accepted",
      delivery_summary: { durableCommands: 1, apnsJobs: 1 },
      expected_receipts: 1,
      confirmed_receipts: 0,
      interaction_kind: null,
      interaction_state: null,
      interaction_action: null,
      interaction_responded_at: null,
      requester_service_id: null,
      requester_credential_id: null,
      requester_label: "Dashboard",
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      title: "Release finished",
      detail: "Deployment complete",
      style: "standard",
      status: "Finished",
      state: "ended",
      progress: 1,
      symbol: "success",
      privacy: "standard",
      accent_color: "#5ED8B7",
      presentation: currentPresentation("Release finished","Finished",1),
      presentation_sha256: null,
      sequence: 5,
      created_at: now,
      updated_at: now,
      target_device_ids: ["33333333-3333-4333-8333-333333333333"],
      target_device_name: "Test iPhone",
      delivery_state: "accepted",
      delivery_summary: { durableCommands: 1, apnsJobs: 1 },
      expected_receipts: 1,
      confirmed_receipts: 1,
      interaction_kind: null,
      interaction_state: null,
      interaction_action: null,
      interaction_responded_at: null,
      requester_service_id: null,
      requester_credential_id: null,
      requester_label: "Dashboard",
    },
  ];
  const rows = (values: any[]) => ({ rows: values, rowCount: values.length });
  const db = {
    query: async (sql: string) => {
      if (sql.includes("FROM account_identities")) {
        return rows([{ principal_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }]);
      }
      if (sql.includes("AS notification_history") && sql.includes("AS activities")) {
        return rows([{
          devices: options.empty ? 0 : 1,
          credentials: 0,
          approvals: 1,
          pending_responses: 0,
          services: 0,
          notifications: 0,
          notification_history: 0,
          activities: activities.length,
          deliveries: 0,
        }]);
      }
      if (sql.includes("FROM devices WHERE principal_id")) {
        if (options.empty) return rows([]);
        return rows([{
          id: "33333333-3333-4333-8333-333333333333",
          name: "Test iPhone",
          model: "iPhone",
          app_version: "1.0",
          os_version: "19.0",
          notification_authorization: "authorized",
          live_activity_authorization: "authorized",
          live_activity_schema_version: 2,
          interaction_capability_version: 1,
          last_seen_at: now,
        }]);
      }
      if (sql.includes("FROM device_authorizations")) {
        return rows([{
          user_code: "ABCD-EFGH",
          client_name: "Test CLI",
          requested_scopes: ["notifications:write"],
          expires_at: "2026-08-07T09:00:00.000Z",
          credential_expires_at: "2027-08-07T08:00:00.000Z",
        }]);
      }
      if (sql.includes("FROM live_activities a")) return rows(activities);
      return rows([]);
    },
  };
  const accountAuth = {
    api: {
      getSession: async () => ({
        session: { id: "session-1", expiresAt: new Date("2026-08-08T08:00:00.000Z"), userId: "user-1" },
        user: { id: "user-1", name: "Owner", email: "owner@example.test", image: null },
      }),
    },
    handler: async () => new Response(JSON.stringify(null), {
      headers: { "content-type": "application/json" },
    }),
  };
  registerWebAuthRoutes(app, db as any, {
    accountAuth: accountAuth as any,
    bootstrapOwnerHandle: "owner",
    appUrl: "http://127.0.0.1:8180",
    credentialDerivationSecret: "test-secret",
    apnsMode: "disabled",
    reconcileActivities: async () => 0,
  });
  return app;
}

function testLabBootstrap(html: string): Record<string,any> {
  const match = html.match(
    /<script id="relo-dashboard-bootstrap" type="application\/json">([^<]*)<\/script>/,
  );
  expect(match).not.toBeNull();
  return JSON.parse(match![1]);
}

describe("dashboard web routes", () => {
  test("serves external assets without a database session", async () => {
    const app = routeApp();
    const css = await app.request("/assets/relo-dashboard.css");
    const js = await app.request("/assets/relo-dashboard.js");

    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(css.headers.get("cache-control")).toContain("must-revalidate");
    expect(await css.text()).toContain("--sidebar-width");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(await js.text()).toContain("mobile-nav-toggle");
    expect(await (await app.request("/api/dashboard/snapshot")).json()).toEqual({ error: "unauthorized" });
  });

  test("protects every primary and nested route", async () => {
    const app = routeApp();
    for (const path of [
      "/dashboard", "/dashboard/inbox/notifications", "/dashboard/inbox/delivery",
      "/dashboard/connections/services", "/dashboard/connections/phones",
      "/dashboard/connections/clients", "/dashboard/testing",
      "/dashboard/testing/runs/act_00000000-0000-0000-0000-000000000000",
      "/dashboard/testing/runs/act_00000000-0000-0000-0000-000000000000/history",
      "/dashboard/account", "/dashboard/docs",
    ]) {
      const response = await app.request(path);
      expect(response.status, path).toBe(302);
      expect(response.headers.get("location"), path).toBe(`/?next=${encodeURIComponent(path)}`);
    }

    const docs = await app.request("/docs");
    expect(docs.status).toBe(302);
    expect(docs.headers.get("location")).toBe("/dashboard/docs");

    const detail = await app.request("/dashboard/notifications/ntf_00000000-0000-0000-0000-000000000000");
    expect(detail.status).toBe(302);
    expect(detail.headers.get("location")).toBe(
      "/dashboard/inbox/notifications/ntf_00000000-0000-0000-0000-000000000000",
    );
  });

  test("serves machine-readable documentation from the dashboard source", async () => {
    const app = routeApp();
    const docs = await app.request("/docs.md");
    const agents = await app.request("/agents.md");
    const llms = await app.request("/llms.txt");
    expect(docs.status).toBe(200);
    expect(docs.headers.get("content-type")).toContain("text/markdown");
    const docsText = await docs.text();
    expect(docsText).toContain("Coordinate Live Activities");
    for (const required of [
      "Authorization: Bearer <access-token>", "POST /api/notifications", "POST /api/interactions",
      "GET /api/interactions/:interactionId/wait", "GET /hooks/<service-secret>/events/:eventId",
      "PATCH /api/live-activities/:activityId", "apns_payload_too_large", "idempotency_conflict",
      '"delivery": { "eligibleDevices": 1, "durableCommands": 1, "apnsJobs": 1 }',
      '"ifSequence": 0', '"dismissAfterSeconds": 15', "activities:write", "activities:read",
      "/api/devices/register", "/api/device-authorizations/start", "/api/inbox", "/api/clients/self",
      "/health/ready",
      "300/minute account ceiling", "60/minute client or service ceiling",
      "respondingDevice", "`approval`", "`shell`", "`verdict`", "`signal`",
    ]) expect(docsText).toContain(required);
    const agentsText = await agents.text();
    expect(agentsText).toContain("Only an explicit phone approval");
    expect(agentsText).toContain("POST /api/notifications");
    expect(await llms.text()).toContain("- Documentation: /docs.md");
  });

  test("serves the authenticated React Test Lab entry with a safe typed bootstrap", async () => {
    const app = authenticatedRouteApp();
    const response = await app.request("/dashboard/testing");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    const html = await response.text();

    expect(html).toContain('<div id="root" data-dashboard-entry="test-lab">');
    expect(html).toContain('id="relo-dashboard-bootstrap" type="application/json"');
    const moduleAsset = html.match(/<script type="module"[^>]+src="(\/assets\/[A-Za-z0-9._-]+\.js)"/)?.[1];
    expect(moduleAsset).toBeDefined();
    expect(html).not.toContain("/assets/relo-dashboard.js");
    const assetResponse = await app.request(moduleAsset!);
    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect((await app.request("/assets/not-in-the-dashboard-build.js")).status).toBe(404);
    const bootstrap = testLabBootstrap(html);
    expect(bootstrap).toMatchObject({
      version: 1,
      kind: "test-lab",
      route: { path: "/dashboard/testing",selectedActivityId: null,compose: false },
      shell: {
        title: "Live Activity Test Lab",
        active: "testing",
        account: { id: "acc_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",initial: "O",name: "Owner",email: "owner@example.test" },
      },
      summary: { total: 2,active: 1,awaitingProvider: 0,awaitingPhone: 1,awaitingResponse: 0 },
    });
    expect(bootstrap.devices).toEqual([expect.objectContaining({
      id: "dev_33333333-3333-4333-8333-333333333333",
      ready: true,
    })]);
    expect(bootstrap.runs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "act_11111111-1111-4111-8111-111111111111",
        ownerControlled: true,
        ownerKind: "dashboard_test",
        evidence: expect.objectContaining({ phone: { expected: 1,confirmed: 0 } }),
      }),
    ]));
    const serialized = JSON.stringify(bootstrap);
    expect(serialized).not.toContain("requester_service_id");
    expect(serialized).not.toContain("requester_credential_id");
    expect(serialized).not.toContain("credentialDerivationSecret");
  });

  test("encodes compose and selected terminal run state in the React bootstrap", async () => {
    const app = authenticatedRouteApp();
    const composeHtml = await (await app.request("/dashboard/testing?compose=1")).text();
    expect(testLabBootstrap(composeHtml).route).toEqual({
      path: "/dashboard/testing",
      selectedActivityId: null,
      compose: true,
    });

    const terminalResponse = await app.request(
      "/dashboard/testing/runs/act_22222222-2222-4222-8222-222222222222",
    );
    expect(terminalResponse.status).toBe(200);
    const terminalHtml = await terminalResponse.text();
    const terminalBootstrap = testLabBootstrap(terminalHtml);
    expect(terminalBootstrap.route).toEqual({
      path: "/dashboard/testing/runs/act_22222222-2222-4222-8222-222222222222",
      selectedActivityId: "act_22222222-2222-4222-8222-222222222222",
      compose: false,
    });
    expect(terminalBootstrap.runs.find((run: any) => run.id === terminalBootstrap.route.selectedActivityId))
      .toMatchObject({
        state: "ended",
        sequence: 5,
        ownerControlled: true,
        evidence: { phone: { expected: 1,confirmed: 1 } },
      });

    const missing = await app.request(
      "/dashboard/testing/runs/act_99999999-9999-4999-8999-999999999999",
    );
    expect(missing.status).toBe(404);
  });

  test("represents an empty Test Lab without inventing client-side state", async () => {
    const app = authenticatedRouteApp({ empty: true });
    const html = await (await app.request("/dashboard/testing")).text();
    const bootstrap = testLabBootstrap(html);
    expect(bootstrap.route.compose).toBe(false);
    expect(bootstrap.summary).toEqual({
      total: 0,
      active: 0,
      awaitingProvider: 0,
      awaitingPhone: 0,
      awaitingResponse: 0,
    });
    expect(bootstrap.devices).toEqual([]);
    expect(bootstrap.runs).toEqual([]);
  });

  test("renders the requested credential lifetime for pending CLI approvals", async () => {
    const app = authenticatedRouteApp();
    const html = await (await app.request("/dashboard")).text();
    expect(testLabBootstrap(html)).toMatchObject({
      kind: "inbox-overview",
      approvalRequests: [{
        userCode: "ABCD-EFGH",
        approvalExpiresAt: "2026-08-07T09:00:00.000Z",
        credentialExpiresAt: "2027-08-07T08:00:00.000Z",
      }],
    });
  });

  test("only exposes validated HTTPS destinations", () => {
    expect(safeDashboardDestination("https://example.test/path?ok=1")).toBe("https://example.test/path?ok=1");
    for (const value of ["http://example.test","javascript:alert(1)","relo://detail","not a url",null]) {
      expect(safeDashboardDestination(value)).toBeNull();
    }
  });
});
