import { cardOwner } from "./card-owner.js";
import { sealedAlertFor,storedSealedCard,type SealedNotice } from "../sealed-content.js";
import { createHash,randomUUID } from "node:crypto";
import { isQuestionBehavior } from "../choice-questions.js";
import { persistNotificationContent,type NotificationContentCipher,type PreparedNotificationContent } from "../notification-content.js";
import type { ActivityDeliverySummary,ApnsMode } from "../activities.js";
import { retireUnsentActivityFrames } from "../activity-delivery-frame.js";
import { syncActivityPresentationLease } from "../activity-presentation-leases.js";
import type { Database } from "../db.js";
import { publicId } from "../ids.js";
import {
persistedPresentationColumns,presentationCommandProjection,
presentationFromRow,
terminalPresentationColumnsFromRow
} from "../presentation-runtime.js";
import { independentSubjectKey,lockSubjectAdmission } from "../relevance/commands.js";
import { relevanceDeliveryGuard } from "../relevance/delivery.js";
import { recordNativeMutation } from "../relevance/native-occurrence.js";
import { admitOrdinaryEvent } from "../relevance/ordinary-admission.js";
import type { ActivityRow } from "./types.js";
import { stableJson } from "../stable-json.js";

type Queryable = { query: (text: string, values?: unknown[]) => Promise<any> };
const DEFAULT_ACCENT_COLOR = "#5ED8B7";

export function boundedPresentationText(value: string | undefined,maximum: number): string | undefined {
  if (!value) return undefined;
  const characters = Array.from(value);
  if (characters.length <= maximum) return value;
  return `${characters.slice(0,maximum-1).join("").trimEnd()}…`;
}

type EligibleDevice = {
  id: string;
  apns_token: string | null;
  apns_environment: "production" | "sandbox";
  live_activity_push_to_start_token: string | null;
  live_activity_authorization: string;
  notification_authorization: string;
  revoked_at: Date | null;
};

export function serializeTaskActivity(row: ActivityRow) {
  const presentation = presentationFromRow(row);
  const presentationHash = row.presentation_sha256
    ?? persistedPresentationColumns(presentation).presentationHash;
  return {
    id: publicId("act",row.id), generation: Number(row.generation ?? 1),
    ownerKind: row.lifecycle_provider && row.lifecycle_run_id
      ? "provider_run"
      : row.requester_service_id
        ? "service_run"
        : row.requester_credential_id
          ? row.activity_key ? "manual_key" : "credential_session"
          : "dashboard_test",
    key: row.activity_key ?? null, title: row.title,
    status: row.status, detail: row.detail, progress: row.progress,
    symbol: row.symbol ?? "terminal", style: row.style ?? "standard",
    privacy: row.privacy, privacyMode: row.privacy,
    accentColor: row.accent_color ?? DEFAULT_ACCENT_COLOR, state: row.state,
    sequence: Number(row.sequence), createdAt: row.created_at,
    expiresAt: row.expires_at, staleAt: row.stale_at,
    updatedAt: row.updated_at, endedAt: row.ended_at,
    terminalReason: row.terminal_reason ?? null,
    terminalActor: row.terminal_actor ?? null,
    terminalPolicy: row.terminal_policy ?? null,
    terminalTransitionAt: row.terminal_transition_at ?? null,
    context: row.context ?? null,
    originThreadId: row.origin_hash ?? null,
    lifecycle: row.lifecycle_provider && row.lifecycle_run_id
      ? { provider: row.lifecycle_provider,runId: row.lifecycle_run_id }
      : null,
    presentation,
    presentationHash,
    presentationPresetId: row.presentation_preset_id ?? row.presentation_policy?.presetId ?? null,
    presentationPresetRevision: row.presentation_preset_revision
      ?? row.presentation_policy?.presetRevision ?? null,
  };
}

export function taskActivityRequestHash(operation: string, value: unknown): string {
  return createHash("sha256")
    .update(`relo:live-activity:${operation}\n${stableJson(value)}`)
    .digest("hex");
}


export async function eligibleDevices(
  query: Queryable,
  principalId: string,
  requestedIds: string[] | null,
): Promise<EligibleDevice[]> {
  const result = await query.query(
    `SELECT id,apns_token,apns_environment,live_activity_push_to_start_token,
       live_activity_authorization,notification_authorization,revoked_at FROM devices
     WHERE principal_id=$1 AND revoked_at IS NULL AND live_activity_authorization='authorized'
       AND ($2::uuid[] IS NULL OR id=ANY($2::uuid[]))
     ORDER BY id`,
    [principalId,requestedIds],
  );
  return result.rows;
}

async function immutableActivityTargets(
  query: Queryable,
  principalId: string,
  targetIds: string[],
): Promise<EligibleDevice[]> {
  if (!targetIds.length) return [];
  const result = await query.query(
    `SELECT id,apns_token,apns_environment,live_activity_push_to_start_token,
       live_activity_authorization,notification_authorization,revoked_at FROM devices
     WHERE principal_id=$1 AND id=ANY($2::uuid[]) ORDER BY id`,
    [principalId,targetIds],
  );
  return result.rows;
}

export async function cancelPendingActivityInteractions(
  query: Queryable,
  principalId: string,
  activityId: string,
): Promise<number> {
  const canceled = await query.query(
    `UPDATE interaction_requests r SET state='canceled',responded_at=now()
     FROM notification_events e
     WHERE r.notification_event_id=e.id AND r.state='pending'
       AND e.principal_id=$1 AND e.payload#>>'{liveActivity,activityId}'=$2
     RETURNING e.id`,
    [principalId,publicId("act",activityId)],
  );
  const eventIds = canceled.rows.map((row: { id: string }) => row.id);
  if (eventIds.length) {
    await query.query(
      "UPDATE notification_events SET state='canceled',updated_at=now() WHERE id=ANY($1::uuid[])",
      [eventIds],
    );
    await query.query(`UPDATE notification_relevance
      SET relevance=jsonb_set(relevance,'{status}','"settled"'::jsonb)
      WHERE notification_event_id=ANY($1::uuid[]) AND superseded_at IS NULL
        AND relevance#>>'{deadlines,kind}'='decision'`,[eventIds]);
    await query.query(`UPDATE delivery_jobs SET state='canceled',last_error_code='interaction_canceled',
      last_error_message='The activity no longer accepts this decision',
      claim_token=NULL,claim_started_at=NULL,claim_phase=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
      WHERE notification_event_id=ANY($1::uuid[]) AND (state IN ('pending','retry')
        OR (state='processing' AND claim_phase='preparing'))`,[eventIds]);
  }
  return eventIds.length;
}

/** Epoch seconds the activity was created; lets the Lock Screen tick an elapsed timer. */
export function activityStartedAt(activity: { created_at: Date | string }): number {
  const created = Math.floor(new Date(activity.created_at).getTime()/1_000);
  if (!Number.isSafeInteger(created) || created < 0) throw new Error("invalid durable Live Activity chronology");
  return created;
}

export function activityProviderTimestamp(activity: {
  created_at: Date | string;
  updated_at?: Date | string | null;
  sequence: number | string;
}): number {
  const created = Math.floor(new Date(activity.created_at).getTime()/1_000);
  const updated = activity.updated_at == null
    ? created
    : Math.floor(new Date(activity.updated_at).getTime()/1_000);
  const sequence = Number(activity.sequence);
  if (!Number.isSafeInteger(created) || created < 0
    || !Number.isSafeInteger(updated) || updated < 0
    || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error("invalid durable Live Activity chronology");
  }
  return updated;
}

/** Keeps a sealed card's latest envelopes on its row; the caller passes the row it updated. */
export async function storeSealedCard(query: Queryable,activity: ActivityRow,sealed: SealedNotice | undefined): Promise<ActivityRow> {
  if (!sealed) return activity;
  await query.query("UPDATE live_activities SET sealed=$2 WHERE id=$1",[activity.id,sealed]);
  return { ...activity,sealed } as ActivityRow;
}

export async function createActivityCommands(
  query: Queryable,
  input: {
    principalId: string;
    sourceName: string;
    activity: ActivityRow;
    operation: "start" | "update" | "end";
    apnsMode: ApnsMode;
    dismissAfterSeconds?: number | null;
    priority?: 5 | 10;
    requestedDeviceIds?: string[] | null;
    occurredAt?: string | undefined;
    /** A question folded into a running card answers sooner than the card itself expires. */
    decisionSeconds?: number | undefined;
    /** Alert the owner on an update: a question has just landed on this card. */
    alert?: boolean | undefined;
    /** End-to-end sealed question text, stored on each phone's question event (E4.1). */
    sealed?: SealedNotice | undefined;
    /** The question's longer detail, stored encrypted with each question event and shown in Relo. */
    decisionDetail?: { content: PreparedNotificationContent; cipher: NotificationContentCipher } | undefined;
  },
): Promise<ActivityDeliverySummary> {
  const freshness = await recordNativeMutation(query,{ activityId: input.activity.id,
    sequence: Number(input.activity.sequence),operation: input.operation,occurredAt: input.occurredAt,
    mutationTime: input.activity.updated_at ?? input.activity.created_at });
  const targetIds = input.requestedDeviceIds ?? input.activity.target_device_ids;
  const devices = targetIds === null || targetIds === undefined
    ? await eligibleDevices(query,input.principalId,null)
    : await immutableActivityTargets(query,input.principalId,targetIds);
  const canonical = presentationFromRow(input.activity);
  const canonicalColumns = persistedPresentationColumns(canonical);
  // An agent's card names the agent that sent it (Claude Code, Codex), not the login it used.
  const provider = input.activity.requester_credential_id && !input.activity.requester_service_id
    ? (input.activity.context as { providerName?: unknown } | null)?.providerName : undefined;
  const sourceName = typeof provider === "string" && provider.trim() ? provider.trim() : input.sourceName;
  const decisionKind = input.operation !== "end" && isQuestionBehavior(canonical.behavior.type)
    ? canonical.behavior.type : null;
  const decisionOptions = canonical.behavior.type === "choice" ? canonical.behavior.options : undefined;
  // Native decisions keep their parent's absolute deadline. Device projections
  // remain separate, but only this native owner can admit their subject keys.
  // No producer-controlled ordinary subject can contend in this namespace.
  const decisionActor = { principalId: input.principalId,sourceId: `native:${input.activity.id}` };
  const decisionOccurredAt = (freshness.occurred_at ?? freshness.accepted_at).toISOString();
  const decisionSeconds = Math.max(1,Math.min(input.decisionSeconds ?? Number.MAX_SAFE_INTEGER,Math.ceil(
    (new Date(input.activity.expires_at).getTime()-Date.parse(decisionOccurredAt))/1_000)));
  let durableCommands = 0;
  let apnsJobs = 0;
  const owner = await cardOwner(query,input.activity,input.operation);
  // One question at a time: a card update that asks again retires the question it replaces.
  if (decisionKind && input.operation === "update") {
    await cancelPendingActivityInteractions(query,input.principalId,input.activity.id);
  }
  for (const device of devices) {
    const lease = await syncActivityPresentationLease(query,{
      principalId: input.principalId,
      activity: { ...input.activity,owner },
      deviceId: device.id,
      operation: input.operation,
    });
    const command = presentationCommandProjection(canonical);
    const remoteActivityEligible = input.apnsMode !== "disabled"
      && device.apns_environment === input.apnsMode
      && !device.revoked_at
      && device.live_activity_authorization === "authorized";
    const transport = input.operation === "start" || lease.restartRequired
      ? (remoteActivityEligible && device.live_activity_push_to_start_token ? "live_activity_start" : null)
      : (remoteActivityEligible ? "live_activity_update" : null);
    const startAlertEligible = freshness.deliver_until.getTime() > Date.now();
    const apnsOwnsStartAlert = transport === "live_activity_start" && startAlertEligible;
    const eventKey = `activity:${input.activity.id}:${input.activity.sequence}:${input.operation}:${device.id}`;
    if (decisionKind) await lockSubjectAdmission(query,decisionActor,independentSubjectKey(eventKey));
    let event = await query.query(
      `INSERT INTO notification_events(
         principal_id,requester_credential_id,requester_service_id,source,kind,title,body,payload,
         idempotency_key,target_mode,expires_at,origin_hash
       ) VALUES ($1,$2,$3,$4,'live_activity',$5,$6,$7,$8,'explicit',$9,$10)
      ON CONFLICT DO NOTHING RETURNING id,payload,created_at`,
      [input.principalId,input.activity.requester_credential_id ?? null,
        input.activity.requester_service_id ?? null,sourceName,canonical.content.title,
        canonical.content.subtitle ?? "",{
        ...(input.activity.context ? { context: input.activity.context } : {}),
        privacy: canonical.privacy,
        ...(input.sealed ? { sealed: input.sealed } : {}),
        liveActivity: {
          operation: input.operation,
          activityId: publicId("act",input.activity.id),
          generation: Number(input.activity.generation),
          targetDeviceId: publicId("dev",device.id),
          ...command,
          style: canonicalColumns.style,
          sourceName,
          privacy: canonical.privacy,
          expiresAt: input.activity.expires_at ?? null,
          staleAt: input.activity.stale_at ?? null,
          alertOwner: !startAlertEligible ? "none" : apnsOwnsStartAlert ? "apns" : input.operation === "start" ? "app"
            : input.alert && input.operation === "update" && canonical.privacy === "standard" ? "apns" : "none",
          sequence: Number(input.activity.sequence),
          providerTimestamp: activityProviderTimestamp(input.activity),
          startedAt: activityStartedAt(input.activity),
          relevanceScore: lease.relevanceScore,
          presentationState: lease.state,
          otherActiveCount: lease.otherActiveCount,
          priority: 10,
          dismissAfterSeconds: input.dismissAfterSeconds ?? null,
          owner,
          interaction: null,
          // This phone's sealed card or question text; the widget opens it on the phone (E5).
          ...(canonical.privacy === "standard"
            ? sealedAlertFor(input.sealed ?? storedSealedCard(input.activity),publicId("dev",device.id)) : {}),
        },
      },eventKey,input.operation === "end"
        ? new Date(Date.now()+3_600_000)
        : (input.activity.expires_at ?? null),input.activity.origin_hash ?? null],
    );
    const inserted = Boolean(event.rowCount);
    if (!event.rowCount) {
      event = await query.query(
        `SELECT id,payload FROM notification_events WHERE principal_id=$1 AND idempotency_key=$2
         AND requester_credential_id IS NOT DISTINCT FROM $3::uuid
         AND requester_service_id IS NOT DISTINCT FROM $4::uuid`,
        [input.principalId,eventKey,input.activity.requester_credential_id ?? null,
          input.activity.requester_service_id ?? null],
      );
    }
    if (!event.rowCount) throw new Error("activity command persistence failed");
    await query.query(
      `INSERT INTO notification_event_targets(notification_event_id,device_id)
       VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [event.rows[0]!.id,device.id],
    );
    await query.query("UPDATE notification_events SET activity_mutation_id=$2 WHERE id=$1",
      [event.rows[0]!.id,freshness.id]);
    if (decisionKind && inserted && input.decisionDetail) {
      await persistNotificationContent(query,input.decisionDetail.cipher,event.rows[0]!.id,input.decisionDetail.content);
    }
    if (decisionKind && inserted) {
      const admission = await admitOrdinaryEvent(query,decisionActor,{
        kind: "decision",apnsMode: input.apnsMode,eventId: event.rows[0]!.id,
        createdAt: decisionOccurredAt,idempotencyKey: eventKey,
        intentHash: taskActivityRequestHash("native-decision",{
          activityId: input.activity.id,sequence: input.activity.sequence,deviceId: device.id,
          presentation: canonical,expiresAt: input.activity.expires_at,
        }),
        actionDeadlineCap: input.activity.expires_at,
        interaction: { kind: decisionKind,prompt: canonical.content.subtitle ?? canonical.content.status,
          actionSeconds: decisionSeconds,options: decisionOptions },
      });
      if (admission.kind === "duplicate") throw new Error("unexpected_native_decision_replay");
      if (admission.request?.state === "expired") {
        const terminal = terminalPresentationColumnsFromRow(input.activity,"Expired","warning");
        const expired = await query.query(
          `UPDATE live_activities SET state='expired',ended_at=clock_timestamp(),updated_at=clock_timestamp(),
             title=$3,status=$4,detail=$5,progress=$6,symbol=$7,privacy=$8,accent_color=$9,style=$10,
             presentation=$11,presentation_sha256=$12,terminal_reason='action_deadline',
             terminal_actor='server',terminal_policy='canonical_decision',terminal_transition_at=clock_timestamp()
           WHERE id=$1 AND principal_id=$2 RETURNING *`,
          [input.activity.id,input.principalId,terminal.title,terminal.status,terminal.detail,terminal.progress,
            terminal.symbol,terminal.privacy,terminal.accentColor,terminal.style,terminal.presentation,terminal.presentationHash],
        );
        Object.assign(input.activity,expired.rows[0]);
        const endedLease = await syncActivityPresentationLease(query,{
          principalId: input.principalId,activity: input.activity,deviceId: device.id,operation: "end",
        });
        await query.query(`UPDATE notification_events SET payload=jsonb_set(payload,'{liveActivity}',$2::jsonb) WHERE id=$1`,
          [event.rows[0]!.id,{ ...event.rows[0]!.payload.liveActivity,
            ...presentationCommandProjection(terminal.presentation),operation: "end",alertOwner: "none",
            presentationState: endedLease.state,otherActiveCount: endedLease.otherActiveCount }]);
      }
    }
    if (decisionKind && !(await query.query(
      `SELECT 1 FROM notification_events e WHERE e.id=$1 AND e.state='active' AND ${relevanceDeliveryGuard("e")}`,
      [event.rows[0]!.id],
    )).rowCount) {
      await retireUnsentActivityFrames(query,input.activity.id,device.id,
        Number(input.activity.generation),Number(input.activity.sequence));
      continue;
    }
    durableCommands += 1;
    if (!transport) continue;
    await query.query(
      `INSERT INTO delivery_jobs(notification_event_id,device_id,transport,live_activity_id)
       SELECT $1,$2,$3,$4 FROM notification_events e
       WHERE e.id=$1 AND ${relevanceDeliveryGuard("e")}
       ON CONFLICT (notification_event_id,device_id) DO NOTHING`,
      [event.rows[0]!.id,device.id,transport,input.activity.id],
    );
    const job = await query.query(
      "SELECT 1 FROM delivery_jobs WHERE notification_event_id=$1 AND device_id=$2",
      [event.rows[0]!.id,device.id],
    );
    apnsJobs += job.rowCount ? 1 : 0;
    await retireUnsentActivityFrames(query,input.activity.id,device.id,
      Number(input.activity.generation),Number(input.activity.sequence));
  }
  return { eligibleDevices: devices.length, durableCommands, apnsJobs };
}

export async function cleanupUndeliverableTerminalTokens(query: Queryable, activityId: string): Promise<void> {
  await query.query(
    `DELETE FROM live_activity_update_tokens t
     WHERE t.live_activity_id=$1 AND NOT EXISTS (
       SELECT 1 FROM delivery_jobs j JOIN notification_events e ON e.id=j.notification_event_id
       WHERE j.live_activity_id=t.live_activity_id AND j.device_id=t.device_id
         AND j.transport='live_activity_update'
         AND e.payload#>>'{liveActivity,operation}'='end'
     )`,
    [activityId],
  );
}


export async function recordTerminalOperation(
  query: Queryable,
  input: {
    principalId: string;
    sourceName: string;
    activity: ActivityRow;
    state: "expired" | "replaced" | "ended";
    apnsMode: ApnsMode;
  },
): Promise<void> {
  await cancelPendingActivityInteractions(query,input.principalId,input.activity.id);
  const delivery = await createActivityCommands(query,{
    principalId: input.principalId,
    sourceName: input.sourceName,
    activity: input.activity,
    operation: "end",
    apnsMode: input.apnsMode,
    dismissAfterSeconds: 0,
  });
  await cleanupUndeliverableTerminalTokens(query,input.activity.id);
  const snapshot = serializeTaskActivity(input.activity);
  await query.query(
    `INSERT INTO live_activity_operations(
       live_activity_id,principal_id,requester_service_id,requester_credential_id,
       idempotency_key,operation,resulting_sequence,request_hash,
       delivery_summary,dismiss_after_seconds,activity_snapshot
     ) VALUES ($1,$2,$3,$4,$5,'end',$6,$7,$8,0,$9)`,
    [input.activity.id,input.principalId,input.activity.requester_service_id ?? null,
      input.activity.requester_credential_id ?? null,`server:${input.state}:${randomUUID()}`,input.activity.sequence,
      taskActivityRequestHash(input.state,{ activityId: publicId("act",input.activity.id), sequence: Number(input.activity.sequence) }),
      delivery,snapshot],
  );
}

/** Operator action: end every active card with a real end push, so no phone keeps a card the
 * server no longer tracks. Run this before any manual data removal (a wipe, a restore). */
export async function endAllActiveActivities(db: Database,apnsMode: ApnsMode): Promise<number> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const active = await client.query<ActivityRow>(
      "SELECT * FROM live_activities WHERE state='active' ORDER BY created_at FOR UPDATE",
    );
    let ended = 0;
    for (const current of active.rows) {
      const stored = terminalPresentationColumnsFromRow(current,"Ended","warning");
      const row = (await client.query<ActivityRow>(
        `UPDATE live_activities SET state='ended',title=$2,status=$3,detail=$4,progress=$5,
           symbol=$6,privacy=$7,accent_color=$8,style=$9,presentation=$10,presentation_sha256=$11,
           terminal_reason='operator_end',terminal_actor='operator',terminal_policy='operator_end_all',
           terminal_transition_at=statement_timestamp(),
           sequence=sequence+1,ended_at=statement_timestamp(),updated_at=statement_timestamp()
         WHERE id=$1 AND state='active' RETURNING *`,
        [current.id,stored.title,stored.status,stored.detail,stored.progress,stored.symbol,
          stored.privacy,stored.accentColor,stored.style,stored.presentation,stored.presentationHash],
      )).rows[0];
      if (!row) continue;
      await recordTerminalOperation(client,{
        principalId: row.principal_id,sourceName: "Relo Operator",activity: row,state: "ended",apnsMode,
      });
      ended += 1;
    }
    await client.query("COMMIT");
    return ended;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function replaceBlockingTaskActivities(
  query: Queryable,
  input: {
    principalId: string;
    sourceName: string;
    blockerIds: string[];
    apnsMode: ApnsMode;
  },
): Promise<number> {
  if (!input.blockerIds.length) return 0;
  const blockers = await query.query(
    `SELECT * FROM live_activities
     WHERE principal_id=$1 AND id=ANY($2::uuid[]) AND state='active'
       AND presentation IS NOT NULL
     ORDER BY created_at FOR UPDATE`,
    [input.principalId,input.blockerIds],
  );
  for (const blocker of blockers.rows) {
    const stored = terminalPresentationColumnsFromRow(blocker,"Replaced","warning");
    const ended = (await query.query(
      `UPDATE live_activities SET state='replaced',title=$2,status=$3,detail=$4,progress=$5,
         symbol=$6,privacy=$7,accent_color=$8,style=$9,presentation=$10,presentation_sha256=$11,
         terminal_reason='explicit_replace',terminal_actor='producer',
         terminal_policy='replacement',terminal_transition_at=now(),
         sequence=sequence+1,ended_at=now(),updated_at=now()
       WHERE id=$1 AND state='active' RETURNING *`,
      [blocker.id,stored.title,stored.status,stored.detail,stored.progress,stored.symbol,
        stored.privacy,stored.accentColor,stored.style,stored.presentation,stored.presentationHash],
    )).rows[0];
    if (ended) await recordTerminalOperation(query,{
      principalId: input.principalId,
      sourceName: input.sourceName,
      activity: ended,
      state: "replaced",
      apnsMode: input.apnsMode,
    });
  }
  return blockers.rows.length;
}


