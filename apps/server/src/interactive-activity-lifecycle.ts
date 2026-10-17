import { expireLockedRequest } from "./interactions/store.js";
import { settleQuestionCopies } from "./interactions/settle-copies.js";
import { lockDecisionActivity } from "./decision-lock.js";
import { withdrawQuestionFallbacks } from "./activity-commands/question-fallback.js";
import { retireUnsentActivityFrames } from "./activity-delivery-frame.js";
import { randomUUID } from "node:crypto";
import { cancelPendingActivityInteractions,activityProviderTimestamp,activityStartedAt,createActivityCommands,serializeTaskActivity, taskActivityRequestHash, type ApnsMode } from "./activities.js";
import type { Database } from "./db.js";
import { internalId } from "./ids.js";
import {
  canonicalPresentation,
  persistedPresentationColumns,
  presentationCommandProjection,
  terminalPresentationColumnsFromRow,
} from "./presentation-runtime.js";

type Queryable = { query: (text: string, values?: unknown[]) => Promise<any> };
export type InteractiveTerminalState = "approved" | "denied" | "yes" | "no" | "replied" | "canceled" | "expired";

export async function settleInteractiveLiveActivity(
  query: Queryable,
  input: {
    principalId: string; notificationEventId: string;
    responseState: InteractiveTerminalState; apnsMode: ApnsMode;
  },
): Promise<void> {
  // The caller holds its request lock. Keep the head's admission receipt immutable;
  // current projections join this status with that head's exact identity.
  await query.query(`UPDATE notification_relevance nr
    SET relevance=jsonb_set(nr.relevance,'{status}','"settled"'::jsonb)
    FROM interaction_requests r WHERE r.notification_event_id=nr.notification_event_id
      AND r.notification_event_id=$1 AND r.principal_id=$2
      AND r.state IN ('approved','denied','yes','no','replied','canceled')
      AND nr.superseded_at IS NULL AND nr.relevance#>>'{deadlines,kind}'='decision'`,
    [input.notificationEventId,input.principalId]);
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
  // A choice ends showing the option the owner picked.
  const chosenLabel = input.responseState === "replied" ? (await query.query(
    "SELECT response->>'label' AS label FROM interaction_requests WHERE notification_event_id=$1 AND principal_id=$2",
    [input.notificationEventId,input.principalId],
  )).rows[0]?.label as string | undefined : undefined;
  const status = chosenLabel ?? ({
    approved: "Approved", denied: "Denied", yes: "Yes", no: "No", replied: "Replied",
    canceled: "Canceled", expired: "No answer",
  } as const)[input.responseState];
  const current = await query.query(
    `SELECT * FROM live_activities
     WHERE id=$1 AND principal_id=$2 AND state='active' FOR UPDATE`,
    [activityId,input.principalId],
  );
  if (!current.rowCount) return;
  // A work card that carried this question: any outcome (answered, canceled, expired) restores the
  // declared work and keeps the card open. A question never ends work (1.10); an unanswered one is
  // "missed" in the derived owner state.
  if (current.rows[0].resume_presentation) {
    await resumeFoldedQuestionCard(query,{ ...input,row: current.rows[0],sourceName: source.rows[0].source,status });
    return;
  }
  // A question-only card (system.interactive.*) is a message: it ends with its answer.
  // Legacy custom presentations stored one request per device. The activity lock
  // arbitrates their common decision; no sibling prompt may survive its winner. On expiry the
  // siblings share the deadline: they expire too (so a late answer from any phone is kept as a fact),
  // whichever copy the expiry pass happened to reach first.
  if (input.responseState === "expired") await settleQuestionCopies(query,{
    scope: { activity: { principalId: input.principalId,activityId } },
    winner: { notificationEventId: input.notificationEventId,principalId: input.principalId },
    outcome: { state: "expired" },deadline: "own",
  });
  await cancelPendingActivityInteractions(query,input.principalId,activityId);
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
    sequence: Number(ended.rows[0].sequence), providerTimestamp: activityProviderTimestamp(ended.rows[0]),
    startedAt: activityStartedAt(ended.rows[0]), dismissAfterSeconds: 5,
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
      new Date(Date.now()+3_600_000),source.rows[0].origin_hash ?? null],
  );
  await query.query(
    `INSERT INTO notification_event_targets(notification_event_id,device_id)
     SELECT $1,unnest($2::uuid[]) ON CONFLICT DO NOTHING`,
    [terminal.rows[0].id,deviceIds],
  );
  const remote = input.apnsMode === "disabled" ? { rowCount: 0 } : await query.query(
    `INSERT INTO delivery_jobs(notification_event_id,device_id,transport,live_activity_id)
     SELECT $1,d.id,'live_activity_update',$3 FROM devices d
     WHERE d.id=ANY($2::uuid[]) AND d.principal_id=$4 AND d.revoked_at IS NULL
       AND d.apns_environment=$5::apns_environment ON CONFLICT DO NOTHING`,
    [terminal.rows[0].id,deviceIds,activityId,input.principalId,input.apnsMode],
  );
  await query.query(
    "UPDATE notification_events SET delivery_summary=$2::jsonb WHERE id=$1",
    [terminal.rows[0].id,{ eligibleDevices: deviceIds.length, durableCommands: deviceIds.length,
      apnsJobs: remote.rowCount ?? 0 }],
  );
  for (const deviceId of deviceIds) {
    await retireUnsentActivityFrames(query,activityId,deviceId,
      Number(ended.rows[0].generation),Number(ended.rows[0].sequence));
  }
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

/** Retains its existing entry point while settling ordinary and ActivityKit decisions alike. */
export async function expireDueInteractiveActivities(
  db: Database, apnsMode: ApnsMode, limit = 100,
): Promise<number> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid_expiry_batch_limit");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const due = await client.query<{ id: string; principal_id: string; notification_event_id: string }>(
      `SELECT r.id,r.principal_id,r.notification_event_id
       FROM interaction_requests r
       WHERE r.state='pending' AND r.expires_at<=clock_timestamp()
       ORDER BY r.expires_at,r.id LIMIT $1`,
      [limit],
    );
    let settled = 0;
    for (const row of due.rows) {
      if (!await lockDecisionActivity(client,row.principal_id,row.notification_event_id,true)) continue;
      const locked = await client.query(
        `SELECT r.id FROM interaction_requests r WHERE r.id=$1 AND r.state='pending'
           AND r.expires_at<=clock_timestamp() FOR UPDATE OF r SKIP LOCKED`,[row.id]);
      if (!locked.rowCount) continue;
      if (!await expireLockedRequest(client,row)) continue;
      settled += 1;
      await settleInteractiveLiveActivity(client,{
        principalId: row.principal_id, notificationEventId: row.notification_event_id,
        responseState: "expired", apnsMode,
      });
    }
    await client.query("COMMIT");
    return settled;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

/**
 * A question folded into a running card settles back into that card: the working presentation
 * returns with the answer in its status line, and the agent's next update replaces it.
 */
async function resumeFoldedQuestionCard(query: Queryable, input: {
  principalId: string; apnsMode: ApnsMode; row: any; sourceName: string; status: string;
  notificationEventId: string; responseState: InteractiveTerminalState;
}): Promise<void> {
  await settleFoldedQuestionCopies(query,input);
  const working = canonicalPresentation(input.row.resume_presentation);
  // A card that `relo ask` started for the question has no work status of its own to return to.
  const line = input.responseState === "expired" ? working.content.status
    : working.content.status === "Needs you" ? input.status : `${input.status} · ${working.content.status}`;
  const resumed = persistedPresentationColumns({
    ...working,
    content: { ...working.content,status: Array.from(line).length > 60 ? input.status : line },
  });
  const updated = await query.query(
    `UPDATE live_activities SET title=$3,status=$4,detail=$5,progress=$6,symbol=$7,style=$8,
       privacy=$9,accent_color=$10,presentation=$11,presentation_sha256=$12,
       resume_presentation=NULL,question_fallback_at=NULL,
       sequence=sequence+1,updated_at=statement_timestamp()
     WHERE id=$1 AND principal_id=$2 AND state='active' RETURNING *`,
    [input.row.id,input.principalId,resumed.title,resumed.status,resumed.detail,resumed.progress,resumed.symbol,
      resumed.style,resumed.privacy,resumed.accentColor,resumed.presentation,resumed.presentationHash],
  );
  if (!updated.rowCount) return;
  await createActivityCommands(query,{
    principalId: input.principalId,sourceName: input.sourceName,activity: updated.rows[0],
    operation: "update",apnsMode: input.apnsMode,priority: 10,
  });
}

async function settleFoldedQuestionCopies(query: Queryable, input: {
  principalId: string; row: any; notificationEventId: string; responseState: InteractiveTerminalState;
}): Promise<void> {
  // One question, one copy per phone: every copy takes the outcome, so a caller waiting on any
  // copy sees the real answer and no copy can settle the card a second time. The copies are made together
  // with one deadline, so the first copy's expiry is the question's: they all expire.
  // Each copy also names the copy that was answered (docs/ENCRYPTION-PROTOCOL.md, "Answers on another
  // copy"): its evidence says which phone answered and its ids are what that phone signed. A copy
  // settled from elsewhere (a long question answered in Relo) passes on the copy it names.
  await settleQuestionCopies(query,{
    scope: { activity: { principalId: input.principalId,activityId: input.row.id } },
    winner: { notificationEventId: input.notificationEventId,principalId: input.principalId },
    outcome: { state: input.responseState },deadline: "shared",
  });
  await cancelPendingActivityInteractions(query,input.principalId,input.row.id);
  await withdrawQuestionFallbacks(query,{ principalId: input.principalId,activityId: input.row.id });
}
