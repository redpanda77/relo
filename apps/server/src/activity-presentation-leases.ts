import { LOCK_SCREEN_MAX_CARDS,OWNER_STATE_SURFACES,ownerStateSchema } from "@relo/notification-contracts";

type Queryable = { query: (text: string, values?: unknown[]) => Promise<any> };

export function activityPresentationScopeKey(activity: any): string {
  const project = String(activity.context?.project ?? "").trim().toLowerCase();
  const thread = String(activity.context?.threadName ?? "").trim().toLowerCase();
  if (thread) return `thread:${project ? `${project}:` : ""}${thread}`;
  if (project) return `project:${project}`;
  if (activity.conversation_id) return `conversation:${activity.conversation_id}`;
  if (activity.origin_hash) return `origin:${activity.origin_hash}`;
  return `activity:${activity.id}`;
}

export type ActivityPresentationLeaseState =
  | "eligible"
  | "foreground"
  | "background"
  | "pending_token"
  | "not_presented"
  | "ending"
  | "ended"
  | "unknown";

export type ActivityPresentationLeaseDecision = {
  state: ActivityPresentationLeaseState;
  relevanceScore: number;
  otherActiveCount: number;
  restartRequired: boolean;
};

/**
 * Lease relevance is the derived owner state's relevance from the contract table (spec 6.2), never
 * status text. `activity.owner` is the deriveOwnerState result the command builder attached; a card
 * without one counts as a pending question when it carries one, else as moving.
 */
export function activityRelevanceScore(activity: any,operation: "start" | "update" | "end"): number {
  if (operation === "end" || activity.state !== "active") return 0;
  const owner = ownerStateSchema.safeParse(activity.owner?.state);
  if (owner.success) return OWNER_STATE_SURFACES[owner.data].relevance;
  const behavior = activity.presentation?.behavior?.type;
  return behavior === "approval" || behavior === "yes_no" || behavior === "choice" || behavior === "text"
    ? OWNER_STATE_SURFACES.needs_you.relevance
    : OWNER_STATE_SURFACES.moving.relevance;
}

export async function syncActivityPresentationLease(
  query: Queryable,
  input: {
    principalId: string;
    activity: any;
    deviceId: string;
    operation: "start" | "update" | "end";
  },
): Promise<ActivityPresentationLeaseDecision> {
  const relevanceScore = activityRelevanceScore(input.activity,input.operation);
  const scopeKey = activityPresentationScopeKey(input.activity);
  await query.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))",
    [`activity-presentation:${input.principalId}:${input.deviceId}`],
  );
  const previous = await query.query(
    `SELECT state FROM live_activity_presentation_leases
     WHERE live_activity_id=$1 AND device_id=$2`,
    [input.activity.id,input.deviceId],
  );
  const restartRequired = input.operation === "update"
    && previous.rows[0]?.state === "not_presented";
  const tokenReady = input.operation !== "update" || Boolean((await query.query(
    `SELECT 1 FROM live_activity_update_tokens
     WHERE live_activity_id=$1 AND device_id=$2 AND generation=$3 LIMIT 1`,
    [input.activity.id,input.deviceId,Number(input.activity.generation)],
  )).rows[0]);
  const terminal = input.operation === "end" || input.activity.state !== "active";
  await query.query(
    `INSERT INTO live_activity_presentation_leases(
       live_activity_id,principal_id,device_id,scope_key,state,reason,relevance_score,last_command_sequence,
       ended_at,updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
     ON CONFLICT (live_activity_id,device_id) DO UPDATE SET
       scope_key=EXCLUDED.scope_key,state=EXCLUDED.state,reason=EXCLUDED.reason,
       relevance_score=EXCLUDED.relevance_score,
       last_command_sequence=GREATEST(
         live_activity_presentation_leases.last_command_sequence,EXCLUDED.last_command_sequence
       ),ended_at=EXCLUDED.ended_at,updated_at=now()`,
    [input.activity.id,input.principalId,input.deviceId,scopeKey,
      terminal ? "ending" : tokenReady || restartRequired ? "background" : "pending_token",
      terminal ? "terminal_command_pending"
        : restartRequired ? "presentation_restart_pending"
        : tokenReady ? "selection_pending" : "activity_token_pending",
      relevanceScore,Number(input.activity.sequence),terminal ? new Date() : null],
  );
  await query.query(
    `UPDATE live_activity_presentation_leases
     SET state='background',reason='device_slot_policy',updated_at=now()
     WHERE principal_id=$1 AND device_id=$2 AND state='foreground'`,
    [input.principalId,input.deviceId],
  );
  await query.query(
    `WITH ranked AS (
       SELECT l.live_activity_id,
         ROW_NUMBER() OVER (
           PARTITION BY l.scope_key
           ORDER BY l.relevance_score DESC,a.updated_at DESC,a.created_at DESC,a.id DESC
         ) AS scope_rank
       FROM live_activity_presentation_leases l
       JOIN live_activities a ON a.id=l.live_activity_id AND a.principal_id=l.principal_id
       WHERE l.principal_id=$1 AND l.device_id=$2 AND a.state='active'
         AND l.state NOT IN ('pending_token','ending','ended','not_presented')
     ), device_ranked AS (
       -- At most LOCK_SCREEN_MAX_CARDS per device, by relevance (a visibility rule, never an end).
       -- Stable: among equal relevance the card already shown keeps its slot. Relevance 0 is
       -- a state with no Lock Screen placement.
       SELECT r.live_activity_id,
         ROW_NUMBER() OVER (
           ORDER BY l.relevance_score DESC,l.selected_at ASC NULLS LAST,r.live_activity_id ASC
         ) AS device_rank
       FROM ranked r
       JOIN live_activity_presentation_leases l ON l.live_activity_id=r.live_activity_id AND l.device_id=$2
       WHERE r.scope_rank=1 AND l.relevance_score>0
     ), selected AS (
       SELECT live_activity_id FROM device_ranked WHERE device_rank<=$3
     )
     UPDATE live_activity_presentation_leases l
     SET state='foreground',reason='scope_relevance_policy',selected_at=COALESCE(l.selected_at,now()),updated_at=now()
     FROM selected WHERE l.live_activity_id=selected.live_activity_id AND l.device_id=$2`,
    [input.principalId,input.deviceId,LOCK_SCREEN_MAX_CARDS],
  );
  // A card that lost its slot loses its seniority; the shown ones keep it for stable ranking.
  await query.query(
    `UPDATE live_activity_presentation_leases SET selected_at=NULL
     WHERE principal_id=$1 AND device_id=$2 AND state<>'foreground' AND selected_at IS NOT NULL`,
    [input.principalId,input.deviceId],
  );
  const selected = await query.query(
    `SELECT state FROM live_activity_presentation_leases
     WHERE live_activity_id=$1 AND device_id=$2`,
    [input.activity.id,input.deviceId],
  );
  const count = await query.query(
    `SELECT count(*)::int AS count FROM live_activity_presentation_leases l
     JOIN live_activities a ON a.id=l.live_activity_id AND a.principal_id=l.principal_id
     WHERE l.principal_id=$1 AND l.device_id=$2 AND a.state='active'
       AND l.live_activity_id<>$3`,
    [input.principalId,input.deviceId,input.activity.id],
  );
  return {
    state: selected.rows[0]?.state ?? (terminal ? "ending" : "unknown"),
    relevanceScore,
    otherActiveCount: Number(count.rows[0]?.count ?? 0),
    restartRequired,
  };
}

export async function markActivityPresentationApplied(
  query: Queryable,
  input: {
    principalId: string;
    activityId: string;
    deviceId: string;
    operation: "start" | "update" | "end";
    sequence: number;
  },
): Promise<void> {
  await query.query(
    `UPDATE live_activity_presentation_leases SET
       state=CASE WHEN $5='end' THEN 'ended' ELSE state END,
       reason=CASE WHEN $5='end' THEN 'device_terminal_receipt' ELSE 'device_applied_receipt' END,
       last_command_sequence=GREATEST(last_command_sequence,$4),last_applied_at=now(),
       ended_at=CASE WHEN $5='end' THEN now() ELSE ended_at END,updated_at=now()
     WHERE principal_id=$1 AND live_activity_id=$2 AND device_id=$3`,
    [input.principalId,input.activityId,input.deviceId,input.sequence,input.operation],
  );
}
