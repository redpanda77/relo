import { inboxReadItemsRequestSchema,inboxReadItemsResponseSchema,type InboxReadItemsResponse } from "@relo/notification-contracts";
import type { Database } from "../db.js";
import type { InboxActor } from "../pending-inventory.js";
import { visibilityDeviceId } from "../owner-overview.js";

/** Exact captured IDs only. Locking targets makes concurrent retries report
 * read/already_read accurately; counts use the same statement visibility plus
 * this statement's updates, never a later independent snapshot. $4 is the device whose delivery
 * targets bound what it may mark (none for an overview device: owner-overview.ts).
 */
export async function markReadItems(db: Database, actor: InboxActor, notificationIds: string[]): Promise<InboxReadItemsResponse> {
  const input=inboxReadItemsRequestSchema.parse({notificationIds});
  const ids=[...new Set(input.notificationIds)].map(id=>id.slice(4));
  const result=await db.query<{results: InboxReadItemsResponse["results"];unread: InboxReadItemsResponse["unread"]}>(`
    WITH requested AS MATERIALIZED (SELECT id,ordinality FROM unnest($3::uuid[]) WITH ORDINALITY AS ids(id,ordinality)),
    target AS MATERIALIZED (
      SELECT e.id,e.read_at FROM notification_events e JOIN requested r ON r.id=e.id
      WHERE e.principal_id=$1
        AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM devices d WHERE d.id=$2 AND d.principal_id=$1 AND d.revoked_at IS NULL))
        AND ($4::uuid IS NULL OR e.target_mode='broadcast' OR EXISTS (
          SELECT 1 FROM notification_event_targets t WHERE t.notification_event_id=e.id AND t.device_id=$4))
      ORDER BY e.id FOR UPDATE OF e
    ), updated AS (
      UPDATE notification_events SET read_at=statement_timestamp(),updated_at=clock_timestamp()
      WHERE id IN (SELECT id FROM target) AND read_at IS NULL RETURNING id
    ), unread AS (
      SELECT e.project_resource_id,count(*)::int AS count FROM notification_events e
      WHERE e.principal_id=$1 AND e.read_at IS NULL AND e.withdrawn_at IS NULL
        AND e.id NOT IN (SELECT id FROM target)
        AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM devices d WHERE d.id=$2 AND d.principal_id=$1 AND d.revoked_at IS NULL))
        AND ($4::uuid IS NULL OR e.target_mode='broadcast' OR EXISTS (
          SELECT 1 FROM notification_event_targets t WHERE t.notification_event_id=e.id AND t.device_id=$4))
      GROUP BY e.project_resource_id
    ) SELECT
      (SELECT jsonb_agg(jsonb_build_object('notificationId','ntf_'||r.id::text,'outcome',
        CASE WHEN u.id IS NOT NULL THEN 'read' WHEN t.id IS NOT NULL THEN 'already_read' ELSE 'not_found' END)
        ORDER BY r.ordinality) FROM requested r LEFT JOIN target t ON t.id=r.id LEFT JOIN updated u ON u.id=r.id) AS results,
      jsonb_build_object('account',COALESCE((SELECT sum(count)::int FROM unread),0),
        'projects',COALESCE((SELECT jsonb_object_agg(COALESCE('prj_'||project_resource_id::text,'direct'),count) FROM unread),'{}'::jsonb)) AS unread
  `,[actor.principalId,actor.deviceId ?? null,ids,visibilityDeviceId(actor) ?? null]);
  return inboxReadItemsResponseSchema.parse(result.rows[0]);
}
