import { Hono } from "hono";
import { describe, expect, test, vi } from "vitest";
import {
  createDashboardInboxHandlers,
  type InboxDashboardBootstrap,
} from "./dashboard-inbox.js";

const principalId = "11111111-1111-4111-8111-111111111111";
const accountId = "acc_11111111-1111-4111-8111-111111111111";
const eventId = "22222222-2222-4222-8222-222222222222";
const deviceId = "33333333-3333-4333-8333-333333333333";
const activityId = "66666666-6666-4666-8666-666666666666";
const relationshipId = "88888888-8888-4888-8888-888888888888";
const decisionId = "99999999-9999-4999-8999-999999999999";
const originThreadId = "org_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const now = "2026-08-07T08:00:00.000Z";

function rows(values: Record<string, unknown>[]) {
  return { rows: values, rowCount: values.length };
}

function testDatabase(
  options: {
    deepLink?: string;
    response?: unknown;
    eventPrincipalId?: string;
    liveActivity?: boolean;
    ordinaryNotification?: boolean;
    requesterKind?: "cli" | "webhook" | "dashboard";
    reconcileActivities?: () => Promise<number>;
  } = {},
) {
  return {
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes("WITH owned_events AS MATERIALIZED")) {
        return rows([{ cursor_valid: true, sort_key: null }]);
      }
      if (
        sql.includes("AS approvals") &&
        sql.includes("AS pending_responses")
      ) {
        return rows([
          {
            approvals: 1,
            pending_responses: 1,
            notifications: 32,
            deliveries: 2,
          },
        ]);
      }
      if (
        sql.includes("AS total FROM notification_events")
      ) {
        expect(params.slice(0, 3)).toEqual(
          options.liveActivity
            ? [principalId, "live_activity", "ended"]
            : [principalId, "question", "active"],
        );
        return rows([{ total: 32 }]);
      }
      if (sql.includes("SELECT DISTINCT") && sql.includes("AS project")) {
        return rows([
          { project: "Relo notifications" },
          { project: "Kuatzi" },
        ]);
      }
      if (sql.includes("FROM device_authorizations WHERE status='pending'")) {
        return rows([
          {
            user_code: "ABCD-EFGH",
            client_name: "Relo CLI",
            requested_scopes: ["notifications:write"],
            expires_at: now,
            credential_expires_at: now,
          },
        ]);
      }
      if (
        sql.includes("FROM interaction_requests r JOIN notification_events")
      ) {
        return rows([
          {
            kind: "question",
            prompt: "Ship it?",
            state: "pending",
            created_at: now,
            expires_at: now,
            event_id: eventId,
            source: "Test Lab",
            title: "Release gate",
            device_names: ["Developer's iPhone"],
          },
        ]);
      }
      if (
        sql.includes("FROM notification_events e") &&
        sql.includes("targets.device_names")
      ) {
        expect(sql).toContain("WHERE logical_rank=1");
        return rows([
          {
            id: eventId,
            source: options.liveActivity ? "Codex" : "Test Lab",
            kind: options.liveActivity ? "live_activity" : options.ordinaryNotification ? "notification" : "question",
            title: options.liveActivity ? "Codex · Relo notifications" : "Release gate",
            body: options.liveActivity ? "Earlier update" : "Review the build",
            deep_link: options.deepLink ?? "https://example.test/releases/42",
            state: "active",
            created_at: now,
            device_names: ["Developer's iPhone"],
            requester_credential_id:
              (options.requesterKind ?? "cli") === "cli" ? principalId : null,
            requester_service_id:
              options.requesterKind === "webhook" ? principalId : null,
            response_action: options.liveActivity ? null : "approve",
            responded_at: options.liveActivity ? null : now,
            live_activity_id: options.liveActivity ? activityId : null,
            activity_operation: options.liveActivity ? "update" : null,
            activity_event_sequence: options.liveActivity ? 4 : null,
            activity_state: options.liveActivity ? "ended" : null,
            activity_generation: options.liveActivity ? 2 : null,
            activity_sequence: options.liveActivity ? 6 : null,
            activity_status: options.liveActivity ? "Complete" : null,
            activity_detail: options.liveActivity ? "Dashboard lifecycle fixed" : null,
            activity_progress: null,
            activity_context: options.liveActivity
              ? {
                  providerName: "Codex",
                  project: "Relo notifications",
                  threadName: "Dashboard lifecycle audit",
                  taskTitle: "Correct activity lifecycle history",
                }
              : null,
            activity_origin_hash: options.liveActivity ? originThreadId : null,
            lifecycle_provider: options.liveActivity ? "codex" : null,
            lifecycle_run_id: options.liveActivity ? "codex-run-dashboard-lifecycle" : null,
            activity_created_at: options.liveActivity ? now : null,
            activity_updated_at: options.liveActivity ? now : null,
            activity_stale_at: options.liveActivity ? now : null,
            activity_expires_at: options.liveActivity ? now : null,
            activity_ended_at: options.liveActivity ? now : null,
            activity_terminal_reason: options.liveActivity ? "explicit_end" : null,
            activity_terminal_actor: options.liveActivity ? "provider:codex" : null,
            activity_terminal_policy: options.liveActivity ? "producer_terminal" : null,
            activity_terminal_transition_at: options.liveActivity ? now : null,
            activity_presentation_preset_id: options.liveActivity ? "system.agent.informational" : null,
            activity_presentation_preset_revision: options.liveActivity ? 1 : null,
            activity_presentation_policy_source: options.liveActivity ? "system" : null,
          },
        ]);
      }
      if (
        sql.includes("FROM delivery_jobs j") &&
        sql.includes("WHERE e.principal_id=$1")
      ) {
        return rows([
          {
            id: "55555555-5555-4555-8555-555555555555",
            transport: "apns",
            state: "accepted",
            attempt_count: 1,
            provider_message_id: "provider-id",
            last_error_code: null,
            last_error_message: null,
            accepted_at: now,
            created_at: now,
            updated_at: now,
            event_id: eventId,
            title: "Release gate",
            source: "Test Lab",
            device_name: "Developer's iPhone",
            payload: {},
            reconciliation_action: null,
          },
        ]);
      }
      if (
        sql.includes("FROM notification_events e") &&
        sql.includes("LEFT JOIN webhook_services")
      ) {
        if (
          params[0] !== eventId ||
          params[1] !== (options.eventPrincipalId ?? principalId)
        ) {
          return rows([]);
        }
        return rows([
          {
            id: eventId,
            source: "Test Lab",
            kind: options.ordinaryNotification ? "notification" : "question",
            title: "Release gate",
            body: "Review the build",
            deep_link: options.deepLink ?? "https://example.test/releases/42",
            state: options.ordinaryNotification ? "active" : "responded",
            expires_at: now,
            created_at: now,
            updated_at: now,
            target_mode: "devices",
            service_title: null,
            privacy: "standard",
            live_activity_id: options.liveActivity ? activityId : null,
            activity_operation: options.liveActivity ? "update" : null,
            activity_event_sequence: options.liveActivity ? 4 : null,
            activity_state: options.liveActivity ? "ended" : null,
            activity_generation: options.liveActivity ? 2 : null,
            activity_sequence: options.liveActivity ? 6 : null,
            activity_title: options.liveActivity ? "Codex · Relo notifications" : null,
            activity_status: options.liveActivity ? "Complete" : null,
            activity_detail: options.liveActivity ? "Dashboard lifecycle fixed" : null,
            activity_progress: null,
            activity_context: options.liveActivity
              ? {
                  providerName: "Codex",
                  project: "Relo notifications",
                  threadName: "Dashboard lifecycle audit",
                  taskTitle: "Correct activity lifecycle history",
                }
              : null,
            activity_origin_hash: options.liveActivity ? originThreadId : null,
            lifecycle_provider: options.liveActivity ? "codex" : null,
            lifecycle_run_id: options.liveActivity ? "codex-run-dashboard-lifecycle" : null,
            activity_created_at: options.liveActivity ? now : null,
            activity_updated_at: options.liveActivity ? now : null,
            activity_stale_at: options.liveActivity ? now : null,
            activity_expires_at: options.liveActivity ? now : null,
            activity_ended_at: options.liveActivity ? now : null,
            activity_terminal_reason: options.liveActivity ? "explicit_end" : null,
            activity_terminal_actor: options.liveActivity ? "provider:codex" : null,
            activity_terminal_policy: options.liveActivity ? "producer_terminal" : null,
            activity_terminal_transition_at: options.liveActivity ? now : null,
            activity_presentation_preset_id: options.liveActivity ? "system.agent.informational" : null,
            activity_presentation_preset_revision: options.liveActivity ? 1 : null,
            activity_presentation_policy_source: options.liveActivity ? "system" : null,
          },
        ]);
      }
      if (sql.includes("FROM live_activity_operations")) {
        return rows(
          options.liveActivity
            ? [
                {
                  operation: "start",
                  resulting_sequence: 1,
                  created_at: now,
                  activity_snapshot: { state: "active", status: "Planning" },
                },
                {
                  operation: "end",
                  resulting_sequence: 6,
                  created_at: now,
                  activity_snapshot: { state: "ended", status: "Complete" },
                },
              ]
            : [],
        );
      }
      if (
        sql.includes("FROM live_activities") &&
        sql.includes("WHERE principal_id=$1 AND origin_hash=$2")
      ) {
        return rows(
          options.liveActivity
            ? [
                {
                  id: activityId,
                  generation: 2,
                  state: "ended",
                  title: "Codex · Relo notifications",
                  status: "Complete",
                  context: {
                    providerName: "Codex",
                    project: "Relo notifications",
                    threadName: "Dashboard lifecycle audit",
                    taskTitle: "Correct activity lifecycle history",
                  },
                  created_at: now,
                  updated_at: now,
                  ended_at: now,
                },
                {
                  id: "77777777-7777-4777-8777-777777777777",
                  generation: 1,
                  state: "ended",
                  title: "Codex · Relo notifications",
                  status: "Complete",
                  context: {
                    providerName: "Codex",
                    project: "Relo notifications",
                    threadName: "Dashboard lifecycle audit",
                    taskTitle: "Audit lifecycle history",
                  },
                  created_at: now,
                  updated_at: now,
                  ended_at: now,
                },
              ]
            : [],
        );
      }
      if (sql.includes("FROM activity_relationships relationship")) {
        return rows(options.liveActivity ? [
          {
            id: relationshipId,
            kind: "continuation",
            actor: "cli",
            reason: "same_origin_generation",
            provenance: "runtime",
            created_at: now,
            predecessor_id: "77777777-7777-4777-8777-777777777777",
            predecessor_title: "Audit lifecycle history",
            predecessor_state: "ended",
            predecessor_generation: 1,
            successor_id: activityId,
            successor_title: "Correct activity lifecycle history",
            successor_state: "ended",
            successor_generation: 2,
          },
        ] : []);
      }
      if (sql.includes("FROM activity_correlation_decisions")) {
        return rows(options.liveActivity ? [
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
        ] : []);
      }
      if (
        sql.includes("FROM interaction_requests r") &&
        sql.includes("winner.kind")
      ) {
        return rows([
          {
            kind: "question",
            prompt: "Ship it?",
            state: "responded",
            response: options.response ?? { response: "yes" },
            expires_at: now,
            created_at: now,
            responded_at: now,
            response_action: "answer",
            response_device_id: deviceId,
            response_device_name: "Developer's iPhone",
          },
        ]);
      }
      if (sql.includes("WHERE j.notification_event_id=$1")) {
        return rows([
          {
            id: "55555555-5555-4555-8555-555555555555",
            transport: "apns",
            state: "accepted",
            attempt_count: 1,
            provider_message_id: null,
            last_error_code: null,
            last_error_message: null,
            accepted_at: now,
            created_at: now,
            updated_at: now,
            event_id: eventId,
            title: "Release gate",
            source: "Test Lab",
            device_name: "Developer's iPhone",
            payload: {},
            reconciliation_action: null,
          },
        ]);
      }
      if (sql.includes("FROM interactions i JOIN devices")) {
        return rows([
          { kind: "answer", created_at: now, device_name: "Developer's iPhone" },
        ]);
      }
      return rows([]);
    },
  };
}

function app(
  options: {
    authenticated?: boolean;
    accountPrincipalId?: string;
    deepLink?: string;
    response?: unknown;
    eventPrincipalId?: string;
    liveActivity?: boolean;
    ordinaryNotification?: boolean;
  } = {},
) {
  const application = new Hono();
  const handlers = createDashboardInboxHandlers({
    db: testDatabase(options) as any,
    releaseIdentity: "test-release",
    getAccount: async () =>
      options.authenticated !== false
        ? {
            principalId: options.accountPrincipalId ?? principalId,
            accountId,
            user: { name: "Relo Owner", email: "owner@example.test" },
          }
        : null,
    renderDocument: async (bootstrap) => JSON.stringify(bootstrap),
    reconcileActivities: options.reconcileActivities,
  });
  application.get("/dashboard", handlers.overview);
  application.get("/dashboard/inbox/notifications", handlers.history);
  application.get(
    "/dashboard/inbox/notifications/:notificationId",
    handlers.detail,
  );
  application.get("/dashboard/inbox/delivery", handlers.delivery);
  return application;
}

async function bootstrap(response: Response): Promise<InboxDashboardBootstrap> {
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const policy = response.headers.get("content-security-policy");
  expect(policy).toContain("default-src 'self'");
  expect(policy).toContain("style-src 'self' 'unsafe-inline'");
  expect(policy).toContain("script-src 'self'");
  expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
  return JSON.parse(await response.text()) as InboxDashboardBootstrap;
}

describe("dashboard Inbox handlers", () => {
  test("redirects anonymous dashboard requests to the requested path", async () => {
    const response = await app({ authenticated: false }).request(
      "/dashboard/inbox/delivery",
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "/?next=%2Fdashboard%2Finbox%2Fdelivery",
    );
  });

  test("reconciles due activities before rendering lifecycle history", async () => {
    const reconcileActivities = vi.fn().mockResolvedValue(1);
    const response = await app({ reconcileActivities }).request(
      "/dashboard/inbox/notifications?kind=question&state=active",
    );
    expect(response.status).toBe(200);
    expect(reconcileActivities).toHaveBeenCalledOnce();
  });

  test("serializes an account-scoped overview without secret fields", async () => {
    const result = await bootstrap(await app().request("/dashboard"));
    expect(result.kind).toBe("inbox-overview");
    if (result.kind !== "inbox-overview") return;
    expect(result.shell.counts).toEqual({
      pending: 2,
      notifications: 32,
      deliveries: 2,
    });
    expect(result.pendingResponses[0].notificationId).toBe(`ntf_${eventId}`);
    expect(result.approvalRequests[0].userCode).toBe("ABCD-EFGH");
    expect(result.recentNotifications[0].requesterKind).toBe("cli");
    expect(result.recentNotifications[0].destination).toEqual({
      state: "safe",
      href: "https://example.test/releases/42",
    });
    expect(JSON.stringify(result)).not.toMatch(
      /idempotency|credentialHash|payload|responseToken|apnsToken/i,
    );
  });

  test("projects webhook ownership independently from optional project context", async () => {
    const result = await bootstrap(
      await app({ requesterKind: "webhook" }).request("/dashboard"),
    );
    expect(result.kind).toBe("inbox-overview");
    if (result.kind !== "inbox-overview") return;
    expect(result.recentNotifications[0]).toMatchObject({
      requesterKind: "webhook",
      context: { project: null, threadName: null },
    });
  });

  test("projects an ordinary durable notification as recorded instead of active", async () => {
    const result = await bootstrap(
      await app({ ordinaryNotification: true }).request("/dashboard"),
    );
    expect(result.kind).toBe("inbox-overview");
    if (result.kind !== "inbox-overview") return;
    expect(result.recentNotifications[0]).toMatchObject({
      kind: "notification",
      state: "recorded",
      activity: null,
    });

    const detail = await bootstrap(
      await app({ ordinaryNotification: true }).request(
        `/dashboard/inbox/notifications/ntf_${eventId}`,
      ),
    );
    expect(detail.kind).toBe("notification-detail");
    if (detail.kind !== "notification-detail") return;
    expect(detail.notification.state).toBe("recorded");
  });

  test("preserves notification filters and clamps pagination", async () => {
    const result = await bootstrap(
      await app().request(
        "/dashboard/inbox/notifications?project=Kuatzi&kind=question&state=active&page=9",
      ),
    );
    expect(result.kind).toBe("notification-history");
    if (result.kind !== "notification-history") return;
    expect(result.route.filters).toEqual({
      kind: "question",
      state: "active",
      project: "Kuatzi",
    });
    expect(result.filterOptions.projects).toEqual([
      "Relo notifications",
      "Kuatzi",
    ]);
    expect(result.pagination).toMatchObject({
      page: 2,
      pageCount: 2,
      total: 32,
      nextHref: null,
    });
    expect(result.pagination.previousHref).toBe(
      "/dashboard/inbox/notifications?kind=question&state=active&project=Kuatzi&page=1",
    );
  });

  test("maps detail response semantics and exposes only validated destinations", async () => {
    const result = await bootstrap(
      await app().request(`/dashboard/inbox/notifications/ntf_${eventId}`),
    );
    expect(result.kind).toBe("notification-detail");
    if (result.kind !== "notification-detail") return;
    expect(result.notification.destination).toEqual({
      state: "safe",
      href: "https://example.test/releases/42",
    });
    expect(result.interaction?.action).toBe("reply");
    expect(result.interaction?.responseText).toBe("yes");
    expect(result.interaction?.respondingDevice?.id).toBe(`dev_${deviceId}`);
    expect(result.receipts).toHaveLength(1);
  });

  test("projects canonical Live Activity truth and origin context into history and detail", async () => {
    const history = await bootstrap(
      await app({ liveActivity: true }).request(
        "/dashboard/inbox/notifications?kind=live_activity&state=ended",
      ),
    );
    expect(history.kind).toBe("notification-history");
    if (history.kind !== "notification-history") return;
    expect(history.notifications[0]).toMatchObject({
      state: "ended",
      activity: {
        id: `act_${activityId}`,
        operation: "update",
        eventSequence: 4,
        sequence: 6,
        generation: 2,
        state: "ended",
        terminalReason: "explicit_end",
        originThreadId,
        context: {
          threadName: "Dashboard lifecycle audit",
          taskTitle: "Correct activity lifecycle history",
        },
      },
    });

    const detail = await bootstrap(
      await app({ liveActivity: true }).request(
        `/dashboard/inbox/notifications/ntf_${eventId}`,
      ),
    );
    expect(detail.kind).toBe("notification-detail");
    if (detail.kind !== "notification-detail") return;
    expect(detail.notification.state).toBe("ended");
    expect(detail.activity).toMatchObject({
      id: `act_${activityId}`,
      originThreadId,
      lifecycle: { provider: "codex", runId: "codex-run-dashboard-lifecycle" },
      context: {
        project: "Relo notifications",
        threadName: "Dashboard lifecycle audit",
        taskTitle: "Correct activity lifecycle history",
      },
    });
    expect(detail.activity?.threadHistory).toEqual([
      expect.objectContaining({
        id: `act_${activityId}`,
        generation: 2,
        taskTitle: "Correct activity lifecycle history",
        current: true,
      }),
      expect.objectContaining({
        generation: 1,
        taskTitle: "Audit lifecycle history",
        current: false,
      }),
    ]);
    expect(detail.activity?.timeline).toEqual([
      expect.objectContaining({ operation: "start", sequence: 1, state: "active" }),
      expect.objectContaining({ operation: "end", sequence: 6, state: "ended" }),
    ]);
    expect(detail.activity?.relationships).toEqual([
      expect.objectContaining({
        id: `rel_${relationshipId}`,
        direction: "predecessor",
        relatedActivity: expect.objectContaining({
          id: "act_77777777-7777-4777-8777-777777777777",
        }),
      }),
    ]);
    expect(detail.activity?.correlationDecisions).toEqual([
      expect.objectContaining({
        id: `cor_${decisionId}`,
        outcome: "resumed",
        relationshipId: `rel_${relationshipId}`,
      }),
    ]);
  });

  test.each([
    "https://operator@example.test/releases/42",
    "https://operator:secret@example.test/releases/42",
    "http://example.test/releases/42",
  ])("does not expose unsafe destination %s", async (deepLink) => {
    const history = await bootstrap(
      await app({ deepLink }).request(
        "/dashboard/inbox/notifications?kind=question&state=active",
      ),
    );
    expect(history.kind).toBe("notification-history");
    if (history.kind !== "notification-history") return;
    expect(history.notifications[0].destination).toEqual({
      state: "unsafe",
      href: null,
    });

    const result = await bootstrap(
      await app({ deepLink }).request(
        `/dashboard/inbox/notifications/ntf_${eventId}`,
      ),
    );
    expect(result.kind).toBe("notification-detail");
    if (result.kind !== "notification-detail") return;
    expect(result.notification.destination).toEqual({
      state: "unsafe",
      href: null,
    });
  });

  test("returns not found when an authenticated foreign account requests the event", async () => {
    const foreignPrincipalId = "44444444-4444-4444-8444-444444444444";
    const response = await app({
      accountPrincipalId: foreignPrincipalId,
      eventPrincipalId: principalId,
    }).request(`/dashboard/inbox/notifications/ntf_${eventId}`);
    expect(response.status).toBe(404);
  });
});
