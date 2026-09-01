import type { Database } from "./db.js";

export type NotificationRetentionPolicy = {
  cutoff: Date;
  maximumEventsPerPrincipal: number;
  batchSize: number;
  tombstoneDays: number;
  releaseIdentity: string;
};

export type NotificationRetentionPreview = {
  eligibleEvents: number;
  protectedPendingEvents: number;
  protectedActiveActivityEvents: number;
  expiredTombstones: number;
};

export type NotificationRetentionBatch = {
  runId: string;
  eventsPruned: number;
  tombstonesExpired: number;
};

export type ContextResourceRetentionPolicy = {
  cutoff: Date;
  batchSize: number;
  releaseIdentity: string;
};

export type ContextResourceRetentionPreview = { eligibleProjects: number };
export type ContextResourceRetentionBatch = {
  runId: string;
  aliasesPruned: number;
  projectsPruned: number;
};

function validateContextResourceRetentionPolicy(policy: ContextResourceRetentionPolicy): void {
  if (!Number.isFinite(policy.cutoff.getTime()) || policy.cutoff.getTime()>Date.now()
    || !Number.isInteger(policy.batchSize) || policy.batchSize<1 || policy.batchSize>5_000
    || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(policy.releaseIdentity)) {
    throw new Error("invalid_context_resource_retention_policy");
  }
}

export async function previewContextResourceRetention(
  db: Pick<Database,"query">,
  policy: ContextResourceRetentionPolicy,
): Promise<ContextResourceRetentionPreview> {
  validateContextResourceRetentionPolicy(policy);
  const result = await db.query<{ eligible_projects:number }>(
    `SELECT count(*)::int eligible_projects FROM resource_projects project
     WHERE project.deleted_at<$1 AND project.is_direct=false AND project.merged_into_project_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM notification_events event WHERE event.project_resource_id=project.id)
       AND NOT EXISTS (SELECT 1 FROM live_activities activity WHERE activity.project_resource_id=project.id)
       AND NOT EXISTS (SELECT 1 FROM activity_conversations conversation WHERE conversation.project_resource_id=project.id)
       AND NOT EXISTS (SELECT 1 FROM resource_project_aliases alias WHERE alias.project_id=project.id AND alias.deleted_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM resource_projects merged WHERE merged.merged_into_project_id=project.id)`,
    [policy.cutoff],
  );
  return { eligibleProjects:Number(result.rows[0]!.eligible_projects) };
}

export async function executeContextResourceRetention(
  db: Pick<Database,"query">,
  policy: ContextResourceRetentionPolicy,
): Promise<ContextResourceRetentionBatch> {
  validateContextResourceRetentionPolicy(policy);
  const result = await db.query<{ run_id:string;aliases_pruned:number;projects_pruned:number }>(
    "SELECT * FROM run_context_resource_gc($1,$2,$3)",
    [policy.cutoff,policy.batchSize,policy.releaseIdentity],
  );
  const row = result.rows[0]!;
  return { runId:row.run_id,aliasesPruned:Number(row.aliases_pruned),projectsPruned:Number(row.projects_pruned) };
}

export async function previewNotificationRetention(
  db: Pick<Database,"query">,
  policy: NotificationRetentionPolicy,
): Promise<NotificationRetentionPreview> {
  validateNotificationRetentionPolicy(policy);
  const result = await db.query<{
    eligible_events: number; protected_pending_events: number;
    protected_active_activity_events: number; expired_tombstones: number;
  }>(
    `SELECT
       count(*) FILTER (WHERE eligibility.terminal_eligible AND (
         eligibility.created_at<$1 OR eligibility.history_rank>$2
       ))::int AS eligible_events,
       count(*) FILTER (WHERE NOT eligibility.terminal_eligible AND EXISTS (
         SELECT 1 FROM interaction_requests request
         WHERE request.notification_event_id=eligibility.id AND request.state='pending'
       ))::int AS protected_pending_events,
       count(*) FILTER (WHERE NOT eligibility.terminal_eligible AND EXISTS (
         SELECT 1 FROM live_activities activity
         JOIN notification_events event ON event.id=eligibility.id
         WHERE activity.principal_id=event.principal_id AND activity.state='active'
           AND event.payload#>>'{liveActivity,activityId}'='act_'||activity.id::text
       ))::int AS protected_active_activity_events,
       (SELECT count(*)::int FROM notification_idempotency_tombstones WHERE expires_at<=now())
         AS expired_tombstones
     FROM notification_retention_eligibility eligibility`,
    [policy.cutoff,policy.maximumEventsPerPrincipal],
  );
  const row = result.rows[0]!;
  return {
    eligibleEvents: Number(row.eligible_events),
    protectedPendingEvents: Number(row.protected_pending_events),
    protectedActiveActivityEvents: Number(row.protected_active_activity_events),
    expiredTombstones: Number(row.expired_tombstones),
  };
}

export async function executeNotificationRetentionBatch(
  db: Pick<Database,"query">,
  policy: NotificationRetentionPolicy,
): Promise<NotificationRetentionBatch> {
  validateNotificationRetentionPolicy(policy);
  const result = await db.query<{
    run_id: string; events_pruned: number; tombstones_expired: number;
  }>(
    `SELECT * FROM run_notification_retention($1,$2,$3,$4::text::interval,$5)`,
    [policy.cutoff,policy.maximumEventsPerPrincipal,policy.batchSize,
      `${policy.tombstoneDays} days`,policy.releaseIdentity],
  );
  const row = result.rows[0]!;
  return {
    runId: row.run_id,
    eventsPruned: Number(row.events_pruned),
    tombstonesExpired: Number(row.tombstones_expired),
  };
}

export function validateNotificationRetentionPolicy(policy: NotificationRetentionPolicy): void {
  if (!Number.isFinite(policy.cutoff.getTime()) || policy.cutoff.getTime()>Date.now()
    || !Number.isInteger(policy.maximumEventsPerPrincipal) || policy.maximumEventsPerPrincipal<1
    || !Number.isInteger(policy.batchSize) || policy.batchSize<1 || policy.batchSize>5_000
    || !Number.isInteger(policy.tombstoneDays) || policy.tombstoneDays<1
    || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(policy.releaseIdentity)) {
    throw new Error("invalid_notification_retention_policy");
  }
}
