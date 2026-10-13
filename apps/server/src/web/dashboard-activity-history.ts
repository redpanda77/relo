import type { Handler } from "hono";
import type { Database } from "../db.js";
import { internalId, publicId } from "../ids.js";
import { isoDate,secureHtml } from "./http.js";

export type ActivityHistoryBootstrap = {
  version: 1;
  kind: "activity-history";
  route: { path: string; backHref: string };
  shell: {
    title: string;
    description: string;
    active: "testing";
    releaseIdentity: string;
    account: { id: string; initial: string; name: string; email: string };
  };
  activity: {
    id: string;
    key: string;
    title: string;
    status: string;
    detail: string | null;
    progress: number | null;
    symbol: string;
    style: string;
    privacy: string;
    accentColor: string;
    state: string;
    generation: number;
    sequence: number;
    lifecycle: { provider: string; runId: string } | null;
    requesterLabel: string;
    expiresAt: string | null;
    staleAt: string | null;
    createdAt: string | null;
    updatedAt: string | null;
    endedAt: string | null;
  };
  targetDevices: Array<{
    id: string;
    name: string;
    lastSeenAt: string | null;
  }>;
  operations: Array<{
    operation: string;
    resultingSequence: number;
    durableCommands: number;
    apnsJobs: number;
    dismissAfterSeconds: number | null;
    companionActivityId: string | null;
    createdAt: string | null;
  }>;
  events: Array<{
    id: string;
    kind: string;
    title: string;
    state: string;
    createdAt: string | null;
  }>;
  relationships: Array<{
    id: string;
    kind: string;
    direction: "predecessor" | "successor";
    relatedActivity: {
      id: string;
      title: string;
      state: string;
      generation: number;
    };
    actor: string;
    reason: string;
    provenance: string;
    createdAt: string | null;
  }>;
  correlationDecisions: Array<{
    id: string;
    outcome: string;
    matchedBy: string;
    actor: string;
    reason: string;
    provenance: string;
    relationshipId: string | null;
    createdAt: string | null;
  }>;
};

type ActivityHistoryAccount = {
  principalId: string;
  accountId: string;
  user: { name: string; email: string };
};

type ActivityHistoryDependencies = {
  db: Database;
  releaseIdentity: string;
  getAccount(headers: Headers): Promise<ActivityHistoryAccount | null>;
  renderDocument(bootstrap: ActivityHistoryBootstrap): Promise<string>;
};

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

export function createDashboardActivityHistoryHandler(
  dependencies: ActivityHistoryDependencies,
): Handler {
  const { db, getAccount, releaseIdentity, renderDocument } = dependencies;

  return async (context) => {
    const account = await getAccount(context.req.raw.headers);
    if (!account)
      return context.redirect(`/?next=${encodeURIComponent(context.req.path)}`);

    const activityId = internalId("act", context.req.param("activityId") ?? "");
    if (!activityId) return context.notFound();

    const activity = await db.query<any>(
      `SELECT a.id,a.activity_key,a.title,a.status,a.detail,a.progress,a.symbol,a.style,a.privacy,
         a.accent_color,a.state,a.generation,a.sequence,a.target_device_ids,a.expires_at,a.stale_at,
         a.created_at,a.updated_at,a.ended_at,a.requester_service_id,a.requester_credential_id,
         a.lifecycle_provider,a.lifecycle_run_id,
         CASE WHEN a.requester_service_id IS NOT NULL THEN 'Service - '||COALESCE(s.title,'revoked')
              WHEN a.requester_credential_id IS NOT NULL THEN 'Client - '||COALESCE(k.label,'revoked')
              ELSE 'Dashboard' END AS requester_label
       FROM live_activities a LEFT JOIN webhook_services s ON s.id=a.requester_service_id
       LEFT JOIN principal_api_keys k ON k.id=a.requester_credential_id
       WHERE a.id=$1 AND a.principal_id=$2`,
      [activityId, account.principalId],
    );
    if (!activity.rowCount) return context.notFound();

    const row = activity.rows[0];
    const externalId = publicId("act", row.id);
    const [operations, events, devices, relationships, correlationDecisions] = await Promise.all([
      db.query<any>(
        `SELECT operation,resulting_sequence,delivery_summary,dismiss_after_seconds,
           companion_activity_id,created_at
         FROM live_activity_operations WHERE live_activity_id=$1
         ORDER BY resulting_sequence,created_at`,
        [activityId],
      ),
      db.query<any>(
        `SELECT id,kind,title,state,created_at FROM notification_events
         WHERE principal_id=$1 AND payload#>>'{liveActivity,activityId}'=$2
         ORDER BY created_at,id`,
        [account.principalId, externalId],
      ),
      db.query<any>(
        `SELECT id,name,last_seen_at FROM devices
         WHERE principal_id=$1 AND id=ANY($2::uuid[]) ORDER BY name,id`,
        [account.principalId, row.target_device_ids ?? []],
      ),
      db.query<any>(
        `SELECT relationship.id,relationship.kind,relationship.actor,relationship.reason,
           relationship.provenance,relationship.created_at,
           predecessor.id AS predecessor_id,predecessor.title AS predecessor_title,
           predecessor.state AS predecessor_state,predecessor.generation AS predecessor_generation,
           successor.id AS successor_id,successor.title AS successor_title,
           successor.state AS successor_state,successor.generation AS successor_generation
         FROM activity_relationships relationship
         JOIN live_activities predecessor ON predecessor.id=relationship.predecessor_activity_id
           AND predecessor.principal_id=relationship.principal_id
         JOIN live_activities successor ON successor.id=relationship.successor_activity_id
           AND successor.principal_id=relationship.principal_id
         WHERE relationship.principal_id=$1
           AND (relationship.predecessor_activity_id=$2 OR relationship.successor_activity_id=$2)
         ORDER BY relationship.created_at,relationship.id`,
        [account.principalId, activityId],
      ),
      db.query<any>(
        `SELECT id,outcome,matched_by,actor,reason,provenance,relationship_id,created_at
         FROM activity_correlation_decisions
         WHERE principal_id=$1 AND activity_id=$2
         ORDER BY created_at,id`,
        [account.principalId, activityId],
      ),
    ]);

    const bootstrap: ActivityHistoryBootstrap = {
      version: 1,
      kind: "activity-history",
      route: {
        path: context.req.path,
        backHref: `/dashboard/testing/runs/${encodeURIComponent(externalId)}`,
      },
      shell: {
        title: row.title,
        description: `Read-only lifecycle ${externalId}. Request payloads, credentials, and idempotency keys are intentionally not displayed.`,
        active: "testing",
        releaseIdentity,
        account: {
          id: account.accountId,
          initial: account.user.name.trim().charAt(0).toUpperCase() || "K",
          name: account.user.name,
          email: account.user.email,
        },
      },
      activity: {
        id: externalId,
        key: String(row.activity_key),
        title: String(row.title),
        status: String(row.status),
        detail: row.detail == null ? null : String(row.detail),
        progress: row.progress == null ? null : Number(row.progress),
        symbol: String(row.symbol),
        style: String(row.style),
        privacy: String(row.privacy),
        accentColor: String(row.accent_color),
        state: String(row.state),
        generation: Math.max(1, count(row.generation)),
        sequence: count(row.sequence),
        lifecycle: row.lifecycle_provider && row.lifecycle_run_id
          ? { provider: String(row.lifecycle_provider),runId: String(row.lifecycle_run_id) }
          : null,
        requesterLabel: String(row.requester_label),
        expiresAt: isoDate(row.expires_at),
        staleAt: isoDate(row.stale_at),
        createdAt: isoDate(row.created_at),
        updatedAt: isoDate(row.updated_at),
        endedAt: isoDate(row.ended_at),
      },
      targetDevices: devices.rows.map((device) => ({
        id: publicId("dev", String(device.id)),
        name: String(device.name),
        lastSeenAt: isoDate(device.last_seen_at),
      })),
      operations: operations.rows.map((operation) => ({
        operation: String(operation.operation),
        resultingSequence: count(operation.resulting_sequence),
        durableCommands: count(operation.delivery_summary?.durableCommands),
        apnsJobs: count(operation.delivery_summary?.apnsJobs),
        dismissAfterSeconds:
          operation.dismiss_after_seconds == null
            ? null
            : count(operation.dismiss_after_seconds),
        companionActivityId: operation.companion_activity_id
          ? publicId("act", String(operation.companion_activity_id))
          : null,
        createdAt: isoDate(operation.created_at),
      })),
      events: events.rows.map((event) => ({
        id: publicId("ntf", String(event.id)),
        kind: String(event.kind),
        title: String(event.title),
        state: String(event.state),
        createdAt: isoDate(event.created_at),
      })),
      relationships: relationships.rows.map((relationship) => {
        const outgoing = String(relationship.predecessor_id) === activityId;
        return {
          id: `rel_${String(relationship.id)}`,
          kind: String(relationship.kind),
          direction: outgoing ? "successor" as const : "predecessor" as const,
          relatedActivity: {
            id: publicId("act", String(outgoing
              ? relationship.successor_id
              : relationship.predecessor_id)),
            title: String(outgoing
              ? relationship.successor_title
              : relationship.predecessor_title),
            state: String(outgoing
              ? relationship.successor_state
              : relationship.predecessor_state),
            generation: Math.max(1, count(outgoing
              ? relationship.successor_generation
              : relationship.predecessor_generation)),
          },
          actor: String(relationship.actor),
          reason: String(relationship.reason),
          provenance: String(relationship.provenance),
          createdAt: isoDate(relationship.created_at),
        };
      }),
      correlationDecisions: correlationDecisions.rows.map((decision) => ({
        id: `cor_${String(decision.id)}`,
        outcome: String(decision.outcome),
        matchedBy: String(decision.matched_by),
        actor: String(decision.actor),
        reason: String(decision.reason),
        provenance: String(decision.provenance),
        relationshipId: decision.relationship_id
          ? `rel_${String(decision.relationship_id)}`
          : null,
        createdAt: isoDate(decision.created_at),
      })),
    };

    return secureHtml(context, await renderDocument(bootstrap));
  };
}
