import { RUN_PHONE_EVIDENCE_SQL } from "./web/run-evidence.js";
import { isServerAdmin } from "./server-accounts.js";
import { registerServerAdminRoutes } from "./web/server-admin-routes.js";
import { LIVE_ACTIVITY_PRESET_IDS } from "@relo/notification-contracts";
import type { Hono } from "hono";
import type { AccountAuth } from "./account-auth.js";
import {
expireDueActivities,

type ApnsMode
} from "./activities.js";

import type { Database } from "./db.js";

import { internalId,publicId } from "./ids.js";
import { createNotificationContentCipher } from "./notification-content.js";

import { assertOwnerRole } from "./user-admin.js";
import { createDashboardActivityHistoryHandler } from "./web/dashboard-activity-history.js";
import {
createTestLabDashboardBootstrap,
dashboardAppAssetResponse,
renderDashboardAppDocument,
} from "./web/dashboard-app.js";
import { createDashboardAuthHandler } from "./web/dashboard-auth.js";
import { createDashboardConnectionsHandlers } from "./web/dashboard-connections.js";
import { createDashboardInboxHandlers } from "./web/dashboard-inbox.js";
import { createDashboardProjectHandlers } from "./web/dashboard-projects.js";
import { createDashboardSystemHandlers } from "./web/dashboard-system.js";
import { dashboardReleaseIdentity,secureHtml } from "./web/http.js";
import { agentsMarkdown,documentationMarkdown,llmsText } from "./web/docs-content.js";

export type WebAuthDependencies = {
  accountAuth: AccountAuth;
  bootstrapOwnerHandle: string;
  appUrl: string;
  credentialDerivationSecret: string;
  apnsMode: ApnsMode;
  reconcileActivities?: () => Promise<number>;
};

export type { OwnerAccount } from "./web/owner-account.js";
export { getOwnerAccount } from "./web/owner-account.js";
import { getOwnerAccount,type OwnerAccount } from "./web/owner-account.js";
import { registerAccountRoutes } from "./web/account-routes.js";
import { registerAdminRoutes } from "./web/admin-routes.js";
import { registerInboxActionRoutes } from "./web/inbox-routes.js";
import { dashboardBuilderPresetPresentation,liveActivityGallery,registerTestLabRoutes } from "./web/test-lab-routes.js";
import type { WebRouteContext } from "./web/route-context.js";

export function safeNextPath(value: string | undefined): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || /[\u0000-\u001f]/.test(value)) {
    return "/dashboard";
  }
  return value;
}

export function safeDashboardDestination(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function registerWebAuthRoutes(app: Hono, db: Database, dependencies: WebAuthDependencies): void {
  const { accountAuth, bootstrapOwnerHandle, appUrl, apnsMode } = dependencies;
  const appOrigin = new URL(appUrl).origin;
  const releaseIdentity = dashboardReleaseIdentity(process.env.RELO_RELEASE_IDENTITY);
  const notificationContentCipher = createNotificationContentCipher(
      dependencies.credentialDerivationSecret.length >= 32
        ? dependencies.credentialDerivationSecret
        : apnsMode === "disabled"
          ? "relo-test-notification-content-secret-v1"
          : dependencies.credentialDerivationSecret,
    );
  const inboxHandlers = createDashboardInboxHandlers({
    db,
    releaseIdentity,
    getAccount: (headers) => getOwnerAccount(db,accountAuth,headers),
    renderDocument: renderDashboardAppDocument,
    reconcileActivities: dependencies.reconcileActivities ?? (() => expireDueActivities(db,apnsMode)),
    contentCipher: notificationContentCipher,
  });
  const systemHandlers = createDashboardSystemHandlers({
    db,
    releaseIdentity,
    serverOrigin: appOrigin,
    getAccount: (headers) => getOwnerAccount(db,accountAuth,headers),
    renderDocument: renderDashboardAppDocument,
  });
  const activityHistoryHandler = createDashboardActivityHistoryHandler({
    db,
    releaseIdentity,
    getAccount: (headers) => getOwnerAccount(db,accountAuth,headers),
    renderDocument: renderDashboardAppDocument,
  });
  const connectionsHandlers = createDashboardConnectionsHandlers({
    db,
    releaseIdentity,
    getAccount: (headers) => getOwnerAccount(db,accountAuth,headers),
    renderDocument: renderDashboardAppDocument,
  });

  const noStoreDashboard = async (context: any,next: () => Promise<void>) => {
    await next();
    context.header("cache-control","private, no-store");
  };
  app.use("/dashboard",noStoreDashboard);
  app.use("/dashboard/*",noStoreDashboard);

  app.get("/assets/:dashboardAsset", async (context) => {
    const response = await dashboardAppAssetResponse(context.req.param("dashboardAsset"));
    return response ?? context.notFound();
  });
  app.get("/docs.md", (context) => context.text(documentationMarkdown(),200,{ "content-type": "text/markdown; charset=utf-8" }));
  app.get("/agents.md", (context) => context.text(agentsMarkdown(),200,{ "content-type": "text/markdown; charset=utf-8" }));
  app.get("/llms.txt", (context) => context.text(llmsText(),200,{ "content-type": "text/plain; charset=utf-8" }));

  async function dashboardMutationAccount(context: any): Promise<OwnerAccount | Response> {
    const account = await getOwnerAccount(db, accountAuth, context.req.raw.headers);
    if (!account) return context.json({ error: "unauthorized" }, 401);
    if (context.req.header("origin") !== appOrigin) return context.json({ error: "forbidden" }, 403);
    return account;
  }

  const projectHandlers = createDashboardProjectHandlers({
    db,
    releaseIdentity,
    getAccount: (headers) => getOwnerAccount(db,accountAuth,headers),
    authorizeMutation: dashboardMutationAccount,
    renderDocument: renderDashboardAppDocument,
  });

  async function accountMutationAccount(context: any): Promise<OwnerAccount | Response> {
    const account = await getOwnerAccount(db,accountAuth,context.req.raw.headers);
    if (!account) return context.json({ error: "unauthorized" },401);
    const origin = context.req.header("origin");
    if (origin !== undefined && origin !== appOrigin) return context.json({ error: "forbidden" },403);
    return account;
  }

  async function ownerAdminAccount(context: any): Promise<OwnerAccount | Response> {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    if (!await assertOwnerRole(db,account.principalId,account.user.id)) {
      return context.json({ error: "owner_role_required" },403);
    }
    return account;
  }

  async function serverAdminAccount(context: any): Promise<OwnerAccount | Response> {
    const account = await dashboardMutationAccount(context);
    if (account instanceof Response) return account;
    if (!await isServerAdmin(db,account.user.id)) return context.json({ error: "server_admin_required" },403);
    return account;
  }

  const routeContext: WebRouteContext = {
    db,accountAuth,bootstrapOwnerHandle,appOrigin,appUrl,apnsMode,releaseIdentity,notificationContentCipher,
    dashboardMutationAccount,accountMutationAccount,ownerAdminAccount,serverAdminAccount,
  };
  registerAccountRoutes(app,routeContext);
  registerAdminRoutes(app,routeContext);
  registerServerAdminRoutes(app,routeContext);
  registerTestLabRoutes(app,routeContext);
  registerInboxActionRoutes(app,routeContext);

  app.get("/", createDashboardAuthHandler({
    db,
    getAccount: (headers: Headers) => getOwnerAccount(db,accountAuth,headers),
    renderDocument: renderDashboardAppDocument,
  }));

  const testLabPage = async (context: any) => {
    const account = await getOwnerAccount(db, accountAuth, context.req.raw.headers);
    if (!account) return context.redirect(`/?next=${encodeURIComponent(context.req.path)}`);
    const requestedActivityId = context.req.param("activityId") ?? context.req.query("activity");
    const requestedActivityInternalId = requestedActivityId ? internalId("act",requestedActivityId) : null;
    if (requestedActivityId && !requestedActivityInternalId) return context.notFound();
    const [devices,activities] = await Promise.all([
      db.query<any>(`SELECT id,name,model,app_version,os_version,notification_authorization,live_activity_authorization,
        last_seen_at
        FROM devices WHERE principal_id=$1 AND revoked_at IS NULL ORDER BY last_seen_at DESC,id DESC`,
      [account.principalId]),
      db.query<any>(`SELECT a.id,a.title,a.detail,a.style,a.status,a.state,a.progress,a.symbol,a.privacy,a.accent_color,
        a.presentation,a.presentation_sha256,a.sequence,a.created_at,a.updated_at,
        a.target_device_ids,target_device.name AS target_device_name,
        run_delivery.job_state AS delivery_state,run_delivery.summary AS delivery_summary,
        run_receipts.expected AS expected_receipts,run_receipts.confirmed AS confirmed_receipts,
        run_interaction.kind AS interaction_kind,run_interaction.state AS interaction_state,
        run_interaction.action AS interaction_action,run_interaction.responded_at AS interaction_responded_at,
        a.requester_service_id,a.requester_credential_id,
        CASE WHEN a.requester_service_id IS NOT NULL THEN 'Service · '||COALESCE(s.title,'revoked')
             WHEN a.requester_credential_id IS NOT NULL THEN 'Client · '||COALESCE(k.label,'revoked') ELSE 'Dashboard' END AS requester_label
        FROM live_activities a LEFT JOIN webhook_services s ON s.id=a.requester_service_id
        LEFT JOIN principal_api_keys k ON k.id=a.requester_credential_id
        LEFT JOIN LATERAL (
          SELECT d.name FROM devices d WHERE d.principal_id=a.principal_id
            AND d.id=ANY(a.target_device_ids) ORDER BY d.name,d.id LIMIT 1
        ) target_device ON true
        LEFT JOIN LATERAL (
          SELECT e.delivery_summary AS summary,j.state AS job_state
          FROM notification_events e LEFT JOIN delivery_jobs j ON j.notification_event_id=e.id
          WHERE e.principal_id=a.principal_id AND (
            e.payload#>>'{liveActivity,activityId}'='act_'||a.id::text OR
            e.payload#>>'{workbench,parentActivityId}'='act_'||a.id::text)
          ORDER BY e.created_at DESC,j.updated_at DESC NULLS LAST LIMIT 1
        ) run_delivery ON true
        ${RUN_PHONE_EVIDENCE_SQL}
        LEFT JOIN LATERAL (
          SELECT r.kind,r.state,i.kind AS action,r.responded_at
          FROM interaction_requests r JOIN notification_events e ON e.id=r.notification_event_id
          LEFT JOIN interactions i ON i.interaction_request_id=r.id
          WHERE e.principal_id=a.principal_id AND (
            e.payload#>>'{liveActivity,activityId}'='act_'||a.id::text OR
            e.payload#>>'{workbench,parentActivityId}'='act_'||a.id::text)
          ORDER BY r.created_at DESC,i.created_at DESC NULLS LAST LIMIT 1
        ) run_interaction ON true
        WHERE a.principal_id=$1 AND a.requester_service_id IS NULL
          AND a.requester_credential_id IS NULL
          AND a.activity_key LIKE 'dashboard-test-%'
        ORDER BY CASE WHEN a.state='active' THEN 0 ELSE 1 END,
          CASE WHEN a.id=$2::uuid THEN 0 ELSE 1 END,a.updated_at DESC,a.id DESC`,
      [account.principalId,requestedActivityInternalId]),
    ]);
    const selectedActivity = requestedActivityId
      ? activities.rows.find((row) => publicId("act",row.id) === requestedActivityId) : null;
    if (requestedActivityId && !selectedActivity) return context.notFound();
    const bootstrap = createTestLabDashboardBootstrap({
      path: context.req.path,
      selectedActivityId: selectedActivity ? publicId("act",selectedActivity.id) : null,
      compose: context.req.query("compose") === "1",
      releaseIdentity,
      account: { id: account.accountId,name: account.user.name,email: account.user.email },
      devices: devices.rows,
      activities: activities.rows,
      presets: LIVE_ACTIVITY_PRESET_IDS.map((id) => ({
        id,
        label: liveActivityGallery[id].label,
        presentation: dashboardBuilderPresetPresentation(id),
      })),
    });
    return secureHtml(context,await renderDashboardAppDocument(bootstrap));
  };
  app.get("/docs", (context) => context.redirect("/dashboard/docs"));
  app.get("/dashboard", inboxHandlers.overview);
  app.get("/dashboard/projects", projectHandlers.index);
  app.get("/dashboard/projects/:projectId", projectHandlers.detail);
  app.get("/dashboard/inbox", (context) => context.redirect("/dashboard",302));
  app.get("/dashboard/inbox/notifications", inboxHandlers.history);
  app.get("/dashboard/inbox/notifications/:notificationId", inboxHandlers.detail);
  app.get("/dashboard/inbox/delivery", inboxHandlers.delivery);
  app.get("/dashboard/connections", connectionsHandlers.overview);
  for (const retired of ["services","phones","clients"]) {
    app.get(`/dashboard/connections/${retired}`, (context) => context.redirect("/dashboard/connections",302));
  }
  app.get("/dashboard/testing", testLabPage);
  app.get("/dashboard/testing/runs/:activityId/history", activityHistoryHandler);
  app.get("/dashboard/testing/runs/:activityId", testLabPage);
  app.get("/dashboard/account", systemHandlers.account);
  app.get("/dashboard/docs", systemHandlers.docs);
  app.get("/dashboard/notifications", (context) => context.redirect("/dashboard/inbox/notifications",302));
  app.get("/dashboard/notifications/:notificationId", (context) => context.redirect(`/dashboard/inbox/notifications/${encodeURIComponent(context.req.param("notificationId"))}`,302));
  app.get("/dashboard/delivery", (context) => context.redirect("/dashboard/inbox/delivery",302));
  app.get("/dashboard/services", (context) => context.redirect("/dashboard/connections",302));
  app.get("/dashboard/devices", (context) => context.redirect("/dashboard/connections",302));
  app.get("/dashboard/clients", (context) => context.redirect("/dashboard/connections",302));
  app.get("/dashboard/approvals", (context) => context.redirect("/dashboard",302));

  app.patch("/api/dashboard/resources/projects/:projectId",projectHandlers.update);
  app.post("/api/dashboard/resources/projects/:projectId/aliases",projectHandlers.addAlias);
  app.delete("/api/dashboard/resources/projects/:projectId/aliases/:aliasId",projectHandlers.removeAlias);
  app.post("/api/dashboard/resources/projects/:projectId/merge",projectHandlers.merge);
  app.post("/api/dashboard/resources/projects/:projectId/split",projectHandlers.split);
  app.delete("/api/dashboard/resources/projects/:projectId",projectHandlers.archive);
  app.post("/api/dashboard/resources/projects/:projectId/restore",projectHandlers.restore);
}
