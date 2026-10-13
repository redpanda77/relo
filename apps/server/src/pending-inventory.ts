import { sealedForDevice } from "./sealed-content.js";
import type { ChoiceOption } from "@relo/notification-contracts";
import type { QuestionKind } from "./interactions/types.js";
import { z } from "zod";
import type { Database } from "./db.js";
import { publicId } from "./ids.js";
import { actorCursorScope,decodeCursor,encodeCursor } from "./cursor.js";

export type InboxActor = { principalId: string; deviceId?: string };
export type PendingCursor = { urgencyRank: 0; expiresAt: string; id: string };
export type PendingInteractionSummary = {
  subjectId: string;
  notificationId: string;
  version: { generation: number; revision: number } | null;
  kind: "decision";
  title: string;
  summary: string;
  source: string;
  createdAt: string;
  readAt: string | null;
  urgencyRank: 0;
  interaction: { id: string; type: QuestionKind; state: "pending"; expiresAt: string; options?: ChoiceOption[] };
};
export type PendingInteractionPage = {
  items: PendingInteractionSummary[];
  total: number;
  hasMore: boolean;
  cursor: string | null;
  nextExpiryAt: string | null;
  serverTime: string;
};

// Use the exact same joins and validity predicate for inventory and APNs badge.
// Delivery TTL is deliberately absent: an undeliverable alert can still contain
// an actionable decision. Native decisions also require their original parent.
export const decisionActivityJoin = `LEFT JOIN live_activities activity ON activity.principal_id=e.principal_id AND activity.id=
    CASE WHEN e.payload#>>'{liveActivity,activityId}' ~ '^act_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN substring(e.payload#>>'{liveActivity,activityId}' FROM 5)::uuid END`;
export const pendingDecisionJoins = `
  JOIN notification_events e ON e.id=r.notification_event_id AND e.principal_id=r.principal_id
  LEFT JOIN notification_relevance nr ON nr.notification_event_id=e.id
  LEFT JOIN relevance_subjects subject ON subject.id=nr.subject_id AND subject.principal_id=e.principal_id
  ${decisionActivityJoin}`;

export function pendingRequestValidity(now: string, deviceVisibility: string): string {
  return `r.state='pending' AND r.expires_at>${now}
    AND e.state='active' AND e.withdrawn_at IS NULL
    AND (e.expires_at IS NULL OR e.expires_at>${now})
    AND (${deviceVisibility})`;
}

/** One decision shown in several places counts once: as the member that waits longest. */
export function decisionGroupRepresentative(request: string, now: string): string {
  return `(${request}.decision_group_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM interaction_requests sibling
      JOIN notification_events sibling_event ON sibling_event.id=sibling.notification_event_id
      WHERE sibling.decision_group_id=${request}.decision_group_id AND sibling.id<>${request}.id
        AND sibling.state='pending' AND sibling.expires_at>${now}
        AND sibling_event.state='active' AND sibling_event.withdrawn_at IS NULL
        AND (sibling.expires_at,sibling.id)>(${request}.expires_at,${request}.id)
    ))`;
}

export function pendingDecisionPredicate(now: string, deviceVisibility: string): string {
  return `${pendingRequestValidity(now,deviceVisibility)}
    AND (nr.notification_event_id IS NULL OR (
      subject.current_event_id=e.id AND subject.generation=nr.generation AND subject.revision=nr.revision
      AND nr.superseded_at IS NULL AND nr.relevance->>'status'='active'
      AND nr.relevance#>>'{deadlines,kind}'='decision'
      AND nr.action_expires_at>${now}
    ))
    AND (e.payload#>>'{liveActivity,activityId}' IS NULL OR (
      activity.state='active'
      AND activity.generation::text=COALESCE(e.payload#>>'{liveActivity,generation}','1')
      AND (activity.expires_at IS NULL OR activity.expires_at>${now})
      AND (activity.lifecycle_provider IS NULL OR activity.stale_at IS NULL OR activity.stale_at>${now})
    ))
    AND ${decisionGroupRepresentative("r",now)}`;
}

export const pendingDeviceVisibility = `e.target_mode='broadcast' OR EXISTS (
  SELECT 1 FROM notification_event_targets t WHERE t.notification_event_id=e.id AND t.device_id=d.id
)`;

// Materialize the small decision set before optional relevance/parent joins.
// Otherwise their selective estimates can make the planner scan all history.
export function pendingRequestCandidates(principal: string, now: string): string {
  return `SELECT id,principal_id,notification_event_id,kind,state,expires_at,decision_group_id
    FROM interaction_requests WHERE principal_id=${principal} AND state='pending' AND expires_at>${now}`;
}

const cursorSchema = z.tuple([z.literal("pending-v1"),z.string().regex(/^[a-f0-9]{64}$/),
  z.literal(0),z.iso.datetime(),z.uuid()]);

export function decodePendingCursor(value: string, actor: InboxActor): PendingCursor | null {
  const decoded = decodeCursor(value,cursorSchema);
  if (!decoded || decoded[1] !== actorCursorScope(actor)) return null;
  return { urgencyRank: decoded[2],expiresAt: decoded[3],id: decoded[4] };
}

function encodePendingCursor(cursor: PendingCursor, actor: InboxActor): string {
  return encodeCursor(["pending-v1",actorCursorScope(actor),cursor.urgencyRank,cursor.expiresAt,cursor.id]);
}

type PendingRow = {
  id: string | null; event_id: string; subject_id: string | null; generation: string; revision: string;
  kind: QuestionKind; options: ChoiceOption[] | null; title: string; summary: string; source: string;
  created_at_iso: string; read_at: Date | null; expires_at_iso: string;
  total: number; next_expiry_at: Date | null; server_time: Date; sealed: unknown;
};

export async function loadPendingInteractions(
  db: Database, actor: InboxActor, input: { limit: number; after?: PendingCursor },
): Promise<PendingInteractionPage> {
  // One statement supplies the page, full inventory count and one server clock.
  // Keep microseconds in ordering keys; JS Date truncates them and repeats ties.
  const result = await db.query<PendingRow>(`WITH clock AS MATERIALIZED (SELECT statement_timestamp() AS at),
    requests AS MATERIALIZED (${pendingRequestCandidates("$1","(SELECT at FROM clock)")}),
    eligible AS MATERIALIZED (
      SELECT r.id,r.notification_event_id AS event_id,r.kind,r.expires_at,
        nr.subject_id,nr.generation,nr.revision,activity.privacy AS activity_privacy,
        LEAST(r.expires_at,e.expires_at,nr.action_expires_at,activity.expires_at,
          CASE WHEN activity.lifecycle_provider IS NOT NULL THEN activity.stale_at END) AS effective_expiry
      FROM requests r ${pendingDecisionJoins}
      LEFT JOIN devices d ON d.id=$2 AND d.principal_id=e.principal_id AND d.revoked_at IS NULL
      CROSS JOIN clock
      WHERE r.principal_id=$1 AND ($2::uuid IS NULL OR d.id IS NOT NULL)
        AND ${pendingDecisionPredicate("clock.at",`$2::uuid IS NULL OR (${pendingDeviceVisibility})`)}
    ), metadata AS (
      SELECT count(*)::int AS total,min(effective_expiry) AS next_expiry_at FROM eligible
    ), page AS (
      SELECT * FROM eligible WHERE $3::timestamptz IS NULL OR (expires_at,id)>($3::timestamptz,$4::uuid)
      ORDER BY expires_at,id LIMIT $5
    )
    SELECT page.id,page.event_id,page.kind,page.subject_id,page.generation,page.revision,
      left(e.title,200) AS title,left(e.source,200) AS source,request_detail.options,
      CASE WHEN e.payload->>'privacy'='private' OR page.activity_privacy='private' THEN 'Private notification'
        ELSE left(request_detail.prompt,240) END AS summary,
      to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_iso,
      e.read_at,to_char(page.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS expires_at_iso,
      metadata.total,metadata.next_expiry_at,clock.at AS server_time,
      COALESCE(e.payload->'sealed',activity_row.sealed) AS sealed
    FROM metadata CROSS JOIN clock LEFT JOIN page ON true
    LEFT JOIN notification_events e ON e.id=page.event_id
    LEFT JOIN interaction_requests request_detail ON request_detail.id=page.id
    LEFT JOIN live_activities activity_row ON activity_row.principal_id=e.principal_id
      AND e.payload#>>'{liveActivity,activityId}'='act_'||activity_row.id::text
    ORDER BY page.expires_at,page.id`,
  [actor.principalId,actor.deviceId ?? null,input.after?.expiresAt ?? null,input.after?.id ?? null,input.limit+1]);
  const metadata = result.rows[0]!;
  const candidates = result.rows.filter((row): row is PendingRow & { id: string } => row.id !== null);
  const hasMore = candidates.length > input.limit;
  const rows = candidates.slice(0,input.limit);
  const last = rows.at(-1);
  return {
    items: rows.map(row => ({
      subjectId: row.subject_id ? `sub_${row.subject_id}` : publicId("ntf",row.event_id),
      notificationId: publicId("ntf",row.event_id),
      version: row.subject_id ? { generation: Number(row.generation),revision: Number(row.revision) } : null,
      kind: "decision",title: row.title,summary: row.summary,source: row.source,
      createdAt: row.created_at_iso,readAt: row.read_at?.toISOString() ?? null,urgencyRank: 0,
      interaction: { id: publicId("int",row.id),type: row.kind,state: "pending",expiresAt: row.expires_at_iso,
        ...(row.kind === "choice" && row.options ? { options: row.options } : {}) },
      // A sealed question's text for this phone; title and summary are placeholders.
      ...(() => { const sealed = sealedForDevice({ sealed: row.sealed },actor.deviceId ? publicId("dev",actor.deviceId) : undefined);
        return sealed ? { sealed } : {}; })(),
    })),
    total: metadata.total,hasMore,
    cursor: hasMore && last ? encodePendingCursor({ urgencyRank: 0,expiresAt: last.expires_at_iso,id: last.id },actor) : null,
    nextExpiryAt: metadata.next_expiry_at?.toISOString() ?? null,serverTime: metadata.server_time.toISOString(),
  };
}
