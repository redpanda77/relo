import type { LiveActivityPresentation } from "@relo/notification-contracts";
import { RUN_CARD_EVIDENCE_SQL,RUN_PHONE_EVIDENCE_SQL } from "./run-evidence.js";
import type { Handler } from "hono";
import type { Database } from "../db.js";
import { internalId, publicId } from "../ids.js";
import {
  createTestLabDashboardBootstrap,
  type TestLabDashboardBootstrap,
} from "./dashboard-app.js";

type TestLabDashboardAccount = {
  principalId: string;
  accountId: string;
  user: { name: string; email: string };
};

type TestLabHandlerDependencies = {
  db: Database;
  releaseIdentity: string;
  getAccount(headers: Headers): Promise<TestLabDashboardAccount | null>;
  renderDocument(bootstrap: TestLabDashboardBootstrap): Promise<string>;
  presets: Array<{
    id: string;
    label: string;
    presentation: LiveActivityPresentation;
  }>;
};

function secureHtml(context: any, html: string): Response {
  context.header(
    "content-security-policy",
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  context.header("cache-control", "private, no-store");
  context.header("x-content-type-options", "nosniff");
  return context.html(html);
}

export function createDashboardTestLabHandler(
  dependencies: TestLabHandlerDependencies,
): Handler {
  const {
    db,
    getAccount,
    presets,
    releaseIdentity,
    renderDocument,
  } = dependencies;

  return async (context) => {
    const account = await getAccount(context.req.raw.headers);
    if (!account)
      return context.redirect(`/?next=${encodeURIComponent(context.req.path)}`);

    const requestedActivity = context.req.param("activityId") || null;
    const requestedActivityId = requestedActivity
      ? internalId("act", requestedActivity)
      : null;
    if (requestedActivity && !requestedActivityId) return context.notFound();

    const [devices, activities] = await Promise.all([
      db.query<any>(
        `SELECT id,name,model,app_version,os_version,notification_authorization,
          live_activity_authorization,last_seen_at
         FROM devices
         WHERE principal_id=$1 AND revoked_at IS NULL
         ORDER BY last_seen_at DESC,id DESC`,
        [account.principalId],
      ),
      db.query<any>(
        `SELECT a.id,a.title,a.detail,a.style,a.status,a.state,a.progress,a.symbol,
          a.privacy,a.accent_color,a.presentation,a.presentation_sha256,
          a.generation,a.sequence,a.created_at,a.updated_at,a.target_device_ids,
          target_device.name AS target_device_name,
          run_delivery.job_state AS delivery_state,
          run_delivery.summary AS delivery_summary,
          run_receipts.expected AS expected_receipts,
          run_receipts.confirmed AS confirmed_receipts,
          run_card.shown_at AS card_shown_at,
          run_interaction.kind AS interaction_kind,
          run_interaction.state AS interaction_state,
          run_interaction.action AS interaction_action,
          run_interaction.responded_at AS interaction_responded_at,
          a.requester_service_id,a.requester_credential_id,
          CASE WHEN a.requester_service_id IS NOT NULL
                 THEN 'Service - '||COALESCE(s.title,'revoked')
               WHEN a.requester_credential_id IS NOT NULL
                 THEN 'Client - '||COALESCE(k.label,'revoked')
               ELSE 'Dashboard' END AS requester_label
         FROM live_activities a
         LEFT JOIN webhook_services s ON s.id=a.requester_service_id
         LEFT JOIN principal_api_keys k ON k.id=a.requester_credential_id
         LEFT JOIN LATERAL (
           SELECT d.name FROM devices d
           WHERE d.principal_id=a.principal_id
             AND d.id=ANY(a.target_device_ids)
           ORDER BY d.name,d.id LIMIT 1
         ) target_device ON true
         LEFT JOIN LATERAL (
           SELECT e.delivery_summary AS summary,j.state AS job_state
           FROM notification_events e
           LEFT JOIN delivery_jobs j ON j.notification_event_id=e.id
           WHERE e.principal_id=a.principal_id AND (
             e.payload#>>'{liveActivity,activityId}'='act_'||a.id::text OR
             e.payload#>>'{workbench,parentActivityId}'='act_'||a.id::text)
           ORDER BY e.created_at DESC,j.updated_at DESC NULLS LAST LIMIT 1
         ) run_delivery ON true
         ${RUN_PHONE_EVIDENCE_SQL}
         ${RUN_CARD_EVIDENCE_SQL}
         LEFT JOIN LATERAL (
           SELECT r.kind,r.state,i.kind AS action,r.responded_at
           FROM interaction_requests r
           JOIN notification_events e ON e.id=r.notification_event_id
           LEFT JOIN interactions i ON i.interaction_request_id=r.id
           WHERE e.principal_id=a.principal_id AND (
             e.payload#>>'{liveActivity,activityId}'='act_'||a.id::text OR
             e.payload#>>'{workbench,parentActivityId}'='act_'||a.id::text)
           ORDER BY r.created_at DESC,i.created_at DESC NULLS LAST LIMIT 1
         ) run_interaction ON true
         WHERE a.principal_id=$1
           AND a.requester_service_id IS NULL
           AND a.requester_credential_id IS NULL
           AND a.activity_key LIKE 'dashboard-test-%'
         ORDER BY CASE WHEN a.state='active' THEN 0 ELSE 1 END,
           CASE WHEN a.id=$2::uuid THEN 0 ELSE 1 END,
           a.updated_at DESC,a.id DESC
         LIMIT 200`,
        [account.principalId, requestedActivityId],
      ),
    ]);

    const selected = requestedActivity
      ? activities.rows.find(
          (row) => publicId("act", String(row.id)) === requestedActivity,
        )
      : null;
    if (requestedActivity && !selected) return context.notFound();

    const bootstrap = createTestLabDashboardBootstrap({
      path: context.req.path,
      selectedActivityId: selected
        ? publicId("act", String(selected.id))
        : null,
      compose: context.req.query("compose") === "1",
      releaseIdentity,
      account: {
        id: account.accountId,
        name: account.user.name,
        email: account.user.email,
      },
      devices: devices.rows,
      activities: activities.rows,
      presets,
    });
    return secureHtml(context, await renderDocument(bootstrap));
  };
}
