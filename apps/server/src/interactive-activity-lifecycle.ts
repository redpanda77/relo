import { randomUUID } from "node:crypto";
import { serializeTaskActivity, taskActivityRequestHash, type ApnsMode } from "./activities.js";
import type { Database } from "./db.js";
import { internalId } from "./ids.js";
import {
  presentationCommandProjection,
  terminalPresentationColumnsFromRow,
} from "./presentation-runtime.js";

type Queryable = { query: (text: string, values?: unknown[]) => Promise<any> };
export type InteractiveTerminalState = "approved" | "denied" | "yes" | "no" | "canceled" | "expired";

export async function settleInteractiveLiveActivity(
  query: Queryable,
  input: {
    principalId: string; notificationEventId: string;
    responseState: InteractiveTerminalState; apnsMode: ApnsMode;
  },
): Promise<void> {
  const source = await query.query(
    `SELECT e.source,e.title,e.body,e.payload,e.expires_at,e.origin_hash,
       e.requester_credential_id,e.requester_service_id
     FROM notification_events e WHERE e.id=$1 AND e.principal_id=$2`,
    [input.notificationEventId,input.principalId],
  );
  const command = source.rows[0]?.payload?.liveActivity;
  if (!command || typeof command.activityId !== "string" || typeof command.targetDeviceId !== "string") return;
  const activityId = internalId("act",command.activityId);
  if (!activityId) return;
  const activityState = input.responseState === "expired" ? "expired" : "ended";
  const status = ({
    approved: "Approved", denied: "Denied", yes: "Yes", no: "No",
    canceled: "Canceled", expired: "Expired",
  } as const)[input.responseState];
  const current = await query.query(
    `SELECT * FROM live_activities
     WHERE id=$1 AND principal_id=$2 AND state='active' FOR UPDATE`,
    [activityId,input.principalId],
  );
  if (!current.rowCount) return;
  const stored = terminalPresentationColumnsFromRow(current.rows[0],status,
    input.responseState === "approved" || input.responseState === "yes" ? "success" : "warning");
  const ended = await query.query(
    `UPDATE live_activities SET state=$3::live_activity_state,title=$4,status=$5,detail=$6,
       progress=$7,symbol=$8,privacy=$9,accent_color=$10,style=$11,presentation=$12,presentation_sha256=$13,
       sequence=sequence+1,
       ended_at=now(),updated_at=now()
     WHERE id=$1 AND principal_id=$2 AND state='active'
       AND presentation IS NOT NULL RETURNING *`,
    [activityId,input.principalId,activityState,stored.title,stored.status,stored.detail,stored.progress,
      stored.symbol,stored.privacy,stored.accentColor,stored.style,stored.presentation,stored.presentationHash],
  );
  if (!ended.rowCount) return;
  const deviceIds = ended.rows[0].target_device_ids as string[];
  if (!deviceIds.length) return;
  const terminalProjection = presentationCommandProjection(stored.presentation);
  const endCommand = {
    ...command, operation: "end", ...terminalProjection,
    sequence: Number(ended.rows[0].sequence), dismissAfterSeconds: 5,
    alertOwner: "none", interaction: null,
  };
  const terminal = await query.query(
    `INSERT INTO notification_events(
       principal_id,requester_credential_id,requester_service_id,source,kind,title,body,payload,
       idempotency_key,target_mode,expires_at,origin_hash
     ) VALUES ($1,$2,$3,$4,'live_activity',$5,$6,$7,$8,'explicit',$9,$10) RETURNING id`,
    [input.principalId,source.rows[0].requester_credential_id,source.rows[0].requester_service_id,
      source.rows[0].source,source.rows[0].title,source.rows[0].body,
      { liveActivity: endCommand },`server:${randomUUID()}`,
      source.rows[0].expires_at ?? new Date(Date.now()+10*60*1_000),source.rows[0].origin_hash ?? null],
  );
  await query.query(
    `INSERT INTO notification_event_targets(notification_event_id,device_id)
     SELECT $1,unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
    [terminal.rows[0].id,deviceIds],
  );
  const remote = input.apnsMode === "disabled" ? { rowCount: 0 } : await query.query(
    `INSERT INTO delivery_jobs(notification_event_id,device_id,transport,live_activity_id)
     SELECT $1,d.id,'live_activity_update',$3 FROM devices d
     JOIN live_activity_update_tokens t ON t.device_id=d.id AND t.live_activity_id=$3
       AND t.generation=$6
     WHERE d.id=ANY($2::uuid[]) AND d.principal_id=$4 AND d.revoked_at IS NULL
       AND d.apns_environment=$5::apns_environment ON CONFLICT DO NOTHING`,
    [terminal.rows[0].id,deviceIds,activityId,input.principalId,input.apnsMode,Number(ended.rows[0].generation)],
  );
  await query.query(
    "UPDATE notification_events SET delivery_summary=$2::jsonb WHERE id=$1",
    [terminal.rows[0].id,{ eligibleDevices: deviceIds.length, durableCommands: deviceIds.length,
      apnsJobs: remote.rowCount ?? 0 }],
  );
  const snapshot = serializeTaskActivity(ended.rows[0]);
  await query.query(
    `INSERT INTO live_activity_operations(
       live_activity_id,principal_id,requester_service_id,requester_credential_id,
       idempotency_key,operation,resulting_sequence,request_hash,delivery_summary,activity_snapshot
     ) VALUES ($1,$2,$3,$4,$5,'respond',$6,$7,$8,$9)`,
    [activityId,input.principalId,ended.rows[0].requester_service_id ?? null,
      ended.rows[0].requester_credential_id ?? null,`server:${randomUUID()}:respond`,ended.rows[0].sequence,
      taskActivityRequestHash("respond",{ responseState: input.responseState }),
      { eligibleDevices: deviceIds.length, durableCommands: deviceIds.length, apnsJobs: remote.rowCount ?? 0 },
      snapshot],
  );
}

export async function expireDueInteractiveActivities(db: Database, apnsMode: ApnsMode): Promise<number> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const due = await client.query<any>(
      `SELECT r.id,r.principal_id,r.notification_event_id
       FROM interaction_requests r
       JOIN notification_events e ON e.id=r.notification_event_id
       JOIN live_activities a ON ('act_'||a.id::text)=e.payload#>>'{liveActivity,activityId}'
       WHERE r.state='pending' AND r.expires_at<=now() AND a.state='active'
         AND (a.presentation#>>'{behavior,type}' IN ('approval','yes_no')
           OR a.style IN ('approval','shell','verdict','signal'))
       ORDER BY r.expires_at FOR UPDATE OF r,a SKIP LOCKED LIMIT 100`,
    );
    for (const row of due.rows) {
      const expired = await client.query(
        `UPDATE interaction_requests SET state='expired',responded_at=now()
         WHERE id=$1 AND state='pending' RETURNING id`,
        [row.id],
      );
      if (!expired.rowCount) continue;
      await client.query(
        "UPDATE notification_events SET state='expired',updated_at=now() WHERE id=$1",
        [row.notification_event_id],
      );
      await settleInteractiveLiveActivity(client,{
        principalId: row.principal_id, notificationEventId: row.notification_event_id,
        responseState: "expired", apnsMode,
      });
    }
    await client.query("COMMIT");
    return due.rows.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
