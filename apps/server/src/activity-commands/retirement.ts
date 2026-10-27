import { createHash,randomUUID } from "node:crypto";
import { LOCK_SCREEN_MAX_CARDS,OWNER_STATE_TIMING,type OwnerStateResult } from "@relo/notification-contracts";
import { loadOwnerStateInputs } from "../derive/load.js";
import { loadIslandCounts } from "../api/now-routes.js";
import type { IslandCounts } from "../derive/now-summary.js";
import { deriveOwnerState } from "../derive/owner-state.js";
import type { Database } from "../db.js";
import { publicId } from "../ids.js";
import { activityProviderTimestamp,activityStartedAt } from "./runtime.js";
import type { ApnsMode } from "../activities.js";
import { prepareNotificationContent,type NotificationContentCipher } from "../notification-content.js";
import { createNotification } from "../notifications/commands.js";

/** Display retirement reasons (F.10 VISIBILITY_REASONS). */
export type RetirementReason = "retired_no_signal" | "retired_stopped_responding" | "retired_paused"
  | "retired_waiting_on_you" | "retired_left_unfinished" | "over_card_limit" | "activitykit_limit"
  | "activitykit_limit_replaced";

type Candidate = {
  activity_id: string; principal_id: string; device_id: string; sequence: string; generation: string;
  reason: RetirementReason;
  /** The card still needs the owner at the ActivityKit limit: end it and start a fresh one, quietly. */
  owner?: OwnerStateResult;
};

type Shown = {
  activity_id: string; principal_id: string; device_id: string; sequence: string; generation: string;
  presented_at: Date; stale_date_pushed: Date | null;
};

export type RetirementPass = { retired: number; restaled: number; woken: number; nextAt: Date | null };

/** A staleDate refresh is pushed only when it moved at least this far past the last pushed one. */
const RESTALE_MIN_MS = 10 * 60 * 1000;

function reasonFor(owner: OwnerStateResult): RetirementReason {
  switch (owner.state) {
    case "paused": return "retired_paused";
    case "waiting_on_you": return "retired_waiting_on_you";
    case "stopped_responding": return "retired_stopped_responding";
    case "left_unfinished": return "retired_left_unfinished";
    default: return "retired_no_signal";
  }
}

/**
 * Display retirement on a server timer, by derived policy (spec 6.4; plan 1.7, 1.5d, 2.17).
 * Retirement is display only: it ends the card on one phone and marks that lease not_presented. It
 * never writes a column of live_activities or works (never a declared outcome); the next producer
 * write finds the lease not_presented and restarts it. A card holding a pending question
 * (resume_presentation) is never retired.
 * Per device: derive() says lockScreen "none" → retired with the state's reason; beyond
 * LOCK_SCREEN_MAX_CARDS by derived relevance (stable: earlier presented keeps its slot) →
 * over_card_limit; presented longer than T_history → activitykit_limit (a card whose work still needs
 * you is replaced instead: ended and started again quietly, activitykit_limit_replaced). A shown card whose staleDate
 * moved ≥ 10 min past the last pushed one gets a priority-5 update carrying the new staleDate; a card
 * whose derived state differs from the last pushed one (a hook moved it: your turn, waiting) gets an
 * update carrying the new state, so the Lock Screen follows sessions without a producer write.
 * A shown card whose island count (`islandCounts`: the satellites) differs from the one it last carried
 * gets a priority-5 update carrying the new count, so the island follows other sessions starting and ending.
 * `since` (the previous pass) wakes each account whose derived state changed by time alone in
 * between (1.5d). Returns the earliest next change so the worker sleeps until then.
 */
export async function retireByPolicy(db: Database,apnsMode: ApnsMode,limit = 200,
  options: { now?: Date; since?: Date | null; contentCipher?: NotificationContentCipher | null } = {}): Promise<RetirementPass> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const now = options.now ?? (await client.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now;
    const shown = (await client.query<Shown>(
      `SELECT a.id AS activity_id,a.principal_id,l.device_id,a.sequence,a.generation,
         COALESCE(l.presented_at,l.selected_at,l.created_at) AS presented_at,l.stale_date_pushed
       FROM live_activities a
       JOIN live_activity_presentation_leases l ON l.live_activity_id=a.id
       WHERE a.state='active' AND a.presentation IS NOT NULL AND a.resume_presentation IS NULL
         AND l.state IN ('eligible','foreground','background','pending_token')
       ORDER BY a.principal_id,l.device_id,a.id
       LIMIT $1 FOR UPDATE OF l SKIP LOCKED`,[limit * LOCK_SCREEN_MAX_CARDS])).rows;
    const byPrincipal = new Map<string,Shown[]>();
    for (const row of shown) byPrincipal.set(row.principal_id,[...(byPrincipal.get(row.principal_id) ?? []),row]);
    const due: Candidate[] = [];
    const restale: Array<Shown & { owner: OwnerStateResult; stateChanged: boolean; counts: IslandCounts }> = [];
    let nextAt: number | null = null;
    let woken = 0;
    for (const [principalId,rows] of byPrincipal) {
      const ids = [...new Set(rows.map((row) => row.activity_id))];
      const loaded = await loadOwnerStateInputs(client,principalId,ids,now);
      const owners = new Map<string,OwnerStateResult>();
      let changed = false;
      for (const work of loaded) {
        const owner = deriveOwnerState(work.input);
        owners.set(work.id.replace(/^act_/,""),owner);
        if (owner.nextChangeAt) nextAt = Math.min(nextAt ?? Infinity,Date.parse(owner.nextChangeAt));
        if (options.since && options.since < now) {
          const before = deriveOwnerState({ ...work.input,now: options.since.toISOString() });
          if (before.nextChangeAt && Date.parse(before.nextChangeAt) <= now.valueOf()) changed = true;
        }
      }
      // The state last pushed per card: a hook can move a card (your turn, waiting) with no producer write.
      // And the island count it last carried: another session starting or ending changes every card's satellites.
      const counts = await loadIslandCounts(client,principalId);
      const lastPushed = new Map<string,string>();
      const lastLive = new Map<string,string | null>();
      for (const row of (await client.query<{ activity: string; state: string | null; live: string | null }>(
        `SELECT DISTINCT ON (payload#>>'{liveActivity,activityId}') payload#>>'{liveActivity,activityId}' AS activity,
           payload#>>'{liveActivity,owner,state}' AS state,payload#>>'{liveActivity,owner,live}' AS live
         FROM notification_events WHERE principal_id=$1 AND kind='live_activity'
           AND payload#>>'{liveActivity,activityId}'=ANY($2::text[])
         ORDER BY payload#>>'{liveActivity,activityId}',created_at DESC,id DESC`,
        [principalId,ids.map((id) => publicId("act",id))])).rows) {
        if (row.state) lastPushed.set(row.activity,row.state);
        lastLive.set(row.activity,row.live);
      }
      if (changed) {
        // 1.5d: phones refetch when derived state changes by time alone (no client timers).
        await client.query("SELECT pg_notify('relo_current_changes',json_build_object('principalId',$1::uuid,'subjectId',NULL)::text)",[principalId]);
        woken += 1;
      }
      const byDevice = new Map<string,Shown[]>();
      for (const row of rows) byDevice.set(row.device_id,[...(byDevice.get(row.device_id) ?? []),row]);
      for (const deviceRows of byDevice.values()) {
        const ranked = deviceRows.filter((row) => owners.has(row.activity_id)).sort((a,b) =>
          owners.get(b.activity_id)!.relevance - owners.get(a.activity_id)!.relevance
          || a.presented_at.valueOf() - b.presented_at.valueOf() || a.activity_id.localeCompare(b.activity_id));
        let slot = 0;
        for (const row of ranked) {
          const owner = owners.get(row.activity_id)!;
          const base = { activity_id: row.activity_id,principal_id: row.principal_id,device_id: row.device_id,
            sequence: row.sequence,generation: row.generation };
          if (now.valueOf() - row.presented_at.valueOf() >= OWNER_STATE_TIMING.historySeconds * 1000) {
            // A card that still needs the owner is replaced by a new one (plan 14, section 4); the 8 h
            // clock restarts at the replacement, so a work gets at most one per 8 h. Other work ends.
            due.push({ ...base,reason: "activitykit_limit",...(owner.state === "needs_you" ? { owner } : {}) }); continue;
          }
          if (owner.lockScreen === "none") { due.push({ ...base,reason: reasonFor(owner) }); continue; }
          slot += 1;
          if (slot > LOCK_SCREEN_MAX_CARDS && owner.state !== "needs_you") { due.push({ ...base,reason: "over_card_limit" }); continue; }
          const pushed = row.stale_date_pushed?.valueOf() ?? null;
          const last = lastPushed.get(publicId("act",row.activity_id));
          const stateChanged = last !== undefined && last !== owner.state;
          const live = lastLive.get(publicId("act",row.activity_id));
          const countChanged = live !== undefined && live !== String(counts.live);
          if (stateChanged || countChanged || (pushed !== null && Date.parse(owner.staleDate) - pushed >= RESTALE_MIN_MS)) {
            restale.push({ ...row,owner,stateChanged,counts });
          }
        }
      }
    }
    let retired = 0;
    const generations = new Map<string,number>();
    const waiting: Candidate[] = [];
    for (const row of due.slice(0,limit)) {
      if (row.owner) {
        if (await replaceAtLimit(client,apnsMode,row,now,generations)) { retired += 1; continue; }
        waiting.push(row);
      }
      const lease = await client.query(
        `UPDATE live_activity_presentation_leases SET state='not_presented',reason=$3,presented_at=NULL,updated_at=clock_timestamp()
         WHERE live_activity_id=$1 AND device_id=$2 AND state IN ('eligible','foreground','background','pending_token')
         RETURNING live_activity_id`,
        [row.activity_id,row.device_id,row.reason],
      );
      if (!lease.rowCount) continue;
      await enqueueDisplayCommand(client,apnsMode,row,"end");
      retired += 1;
    }
    // A card retired while its work did not need the owner (a slept Mac's silent permission wait) and
    // that needs the owner again: the same card returns as a quiet restart (new generation, no buzz).
    const generationsRestart = new Map<string,number>();
    for (const row of await comeBack(client,now,limit)) {
      await replaceAtLimit(client,apnsMode,row,now,generationsRestart,"restarted_still_waiting",["not_presented"]);
    }
    let restaled = 0;
    for (const row of restale) {
      await client.query(`UPDATE live_activity_presentation_leases SET stale_date_pushed=$3
        WHERE live_activity_id=$1 AND device_id=$2`,[row.activity_id,row.device_id,row.owner.staleDate]);
      const { changed: _changed,...owner } = row.owner as OwnerStateResult & { changed?: boolean };
      // A moved state is a change the owner should see now (high priority); a staleDate refresh is not.
      await enqueueDisplayCommand(client,apnsMode,{ ...row,reason: "retired_no_signal" },"update",
        { ...owner,...row.counts,...(row.stateChanged ? { changed: true } : {}) } as OwnerStateResult);
      restaled += 1;
    }
    await client.query("COMMIT");
    // A waiting card that could not be replaced: one quiet notification, so the question is not lost.
    for (const row of waiting) await notifyStillWaiting(db,apnsMode,row,now,options.contentCipher ?? null);
    return { retired,restaled,woken,nextAt: nextAt === null ? null : new Date(nextAt) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Reasons whose retirement was derived from the work's state (not the owner's dismissal, not a slot or limit). */
const COME_BACK_REASONS = ["retired_no_signal","retired_stopped_responding","retired_paused","retired_waiting_on_you",
  "retired_left_unfinished"];

/** Retired cards (this phone) whose work derives needs_you again: the permission prompt is still waiting. */
async function comeBack(
  client: { query: (text: string, values?: unknown[]) => Promise<any> },now: Date,limit: number,
): Promise<Candidate[]> {
  const gone = (await client.query(
    `SELECT a.id AS activity_id,a.principal_id,l.device_id,a.sequence,a.generation
     FROM live_activities a
     JOIN live_activity_presentation_leases l ON l.live_activity_id=a.id
     WHERE a.state='active' AND a.presentation IS NOT NULL AND a.resume_presentation IS NULL
       AND l.state='not_presented' AND l.reason=ANY($2::text[])
     ORDER BY a.principal_id,l.device_id,a.id
     LIMIT $1 FOR UPDATE OF l SKIP LOCKED`,[limit,COME_BACK_REASONS])).rows as Array<Omit<Candidate,"reason">>;
  const byPrincipal = new Map<string,typeof gone>();
  for (const row of gone) byPrincipal.set(row.principal_id,[...(byPrincipal.get(row.principal_id) ?? []),row]);
  const back: Candidate[] = [];
  for (const [principalId,rows] of byPrincipal) {
    const loaded = await loadOwnerStateInputs(client as any,principalId,[...new Set(rows.map((r) => r.activity_id))],now);
    const owners = new Map(loaded.map((work) => [work.id.replace(/^act_/,""),deriveOwnerState(work.input)] as const));
    for (const row of rows) {
      const owner = owners.get(row.activity_id);
      if (owner?.state === "needs_you" && owner.lockScreen !== "none") {
        back.push({ ...row,reason: "activitykit_limit_replaced",owner });
      }
    }
  }
  return back;
}

/**
 * Replaces a card that reached the ActivityKit limit while its work still needs the owner. The card
 * becomes a new generation (same work, plan and question; no new work, no new question): the old
 * generation's update token is deleted and only a push-to-start is sent, since the old frames are
 * superseded and ActivityKit ended the old activity itself at the limit. The lease records
 * `activitykit_limit_replaced` and restarts presented_at, so the next limit is 8 h away.
 * Apple requires an alert on a push-to-start: the start is marked `quietRestart` so it carries no
 * sound and goes at the lowest allowed priority; the command's `alertOwner` stays "none" (the
 * server never counts it as a new alert or question). Returns false (the caller retires plainly)
 * when the phone cannot take a push-to-start.
 */
async function replaceAtLimit(
  client: { query: (text: string, values?: unknown[]) => Promise<any> },apnsMode: ApnsMode,row: Candidate,now: Date,
  generations: Map<string,number>,
  reason: "activitykit_limit_replaced" | "restarted_still_waiting" = "activitykit_limit_replaced",
  fromStates: string[] = ["eligible","foreground","background","pending_token"],
): Promise<boolean> {
  if (apnsMode === "disabled") return false;
  const device = await client.query(
    `SELECT 1 FROM devices WHERE id=$1 AND principal_id=$2 AND revoked_at IS NULL
       AND apns_environment=$3::apns_environment AND live_activity_authorization='authorized'
       AND live_activity_push_to_start_token IS NOT NULL`,[row.device_id,row.principal_id,apnsMode]);
  if (!device.rowCount) return false;
  const lease = await client.query(
    `UPDATE live_activity_presentation_leases
     SET state='background',reason=$4,presented_at=$3,selected_at=NULL,
       stale_date_pushed=NULL,updated_at=clock_timestamp()
     WHERE live_activity_id=$1 AND device_id=$2 AND state=ANY($5::text[])
     RETURNING live_activity_id`,[row.activity_id,row.device_id,now,reason,fromStates]);
  if (!lease.rowCount) return false;
  let generation = generations.get(row.activity_id);
  if (generation === undefined) {
    // One new generation per activity per pass, past every generation of its origin (unique index).
    generation = Number((await client.query(
      `UPDATE live_activities a SET generation=GREATEST(a.generation,COALESCE((
           SELECT max(o.generation) FROM live_activities o
           WHERE a.origin_hash IS NOT NULL AND o.principal_id=a.principal_id AND o.origin_hash=a.origin_hash),0))+1
       WHERE a.id=$1 RETURNING a.generation`,[row.activity_id])).rows[0].generation);
    generations.set(row.activity_id,generation);
  }
  await client.query(
    "DELETE FROM live_activity_update_tokens WHERE live_activity_id=$1 AND device_id=$2 AND generation<$3",
    [row.activity_id,row.device_id,generation]);
  await enqueueDisplayCommand(client,apnsMode,{ ...row,reason: "activitykit_limit_replaced" },"start",row.owner,generation);
  return true;
}

/** One quiet ordinary notification when a waiting card cannot be replaced (no push-to-start). */
async function notifyStillWaiting(db: Database,apnsMode: ApnsMode,row: Candidate,now: Date,
  contentCipher: NotificationContentCipher | null): Promise<void> {
  const activity = (await db.query(
    `SELECT id,title,privacy,context,target_device_ids,requester_credential_id,requester_service_id,work_id
     FROM live_activities WHERE id=$1`,[row.activity_id])).rows[0];
  if (!activity) return;
  const actor = activity.requester_credential_id
    ? { kind: "credential" as const,principalId: row.principal_id,credentialId: activity.requester_credential_id }
    : activity.requester_service_id
      ? { kind: "service" as const,principalId: row.principal_id,serviceId: activity.requester_service_id }
      : { kind: "owner" as const,principalId: row.principal_id };
  // Per work per 8 h: the key names the work and the 8 h window.
  const window = Math.floor(now.valueOf() / (OWNER_STATE_TIMING.historySeconds * 1000));
  const idempotencyKey = `limit-waiting:${activity.work_id ?? activity.id}:${window}`;
  const sealed = activity.privacy === "private";
  await createNotification(db,actor,{
    idempotencyKey,
    requestHash: createHash("sha256").update(idempotencyKey).digest("hex"),
    sourceName: "Relo",
    title: sealed ? "Relo" : `Still waiting for you: ${activity.title}`,
    content: prepareNotificationContent({ body: sealed ? "Still waiting for you. Open Relo." : "Open Relo to answer under Needs you." }),
    imageUrl: null,deepLink: null,
    payload: activity.context ? { context: activity.context } : {},
    deviceIds: activity.target_device_ids?.length ? activity.target_device_ids : null,
    originHash: null,
  },{ apnsMode,contentCipher });
}

/**
 * A display command for one device carrying the card's current content: an end dismissed at once,
 * or a priority-5 update with a refreshed staleDate. The card row is untouched: same sequence, same
 * declared fields.
 */
async function enqueueDisplayCommand(
  query: { query: (text: string, values?: unknown[]) => Promise<any> },apnsMode: ApnsMode,row: Candidate,
  operation: "end" | "update" | "start",owner?: OwnerStateResult,generation?: number,
): Promise<void> {
  const latest = await query.query(
    `SELECT e.source,e.title,e.body,e.payload,e.origin_hash,e.requester_credential_id,e.requester_service_id
     FROM notification_events e
     WHERE e.principal_id=$1 AND e.payload#>>'{liveActivity,activityId}'=$2
       AND e.payload#>>'{liveActivity,targetDeviceId}'=$3
     ORDER BY e.created_at DESC,e.id DESC LIMIT 1`,
    [row.principal_id,publicId("act",row.activity_id),publicId("dev",row.device_id)],
  );
  const source = latest.rows[0];
  const { retirement: _retirement,dismissAfterSeconds: _dismiss,...command } = source?.payload?.liveActivity ?? {};
  if (!source?.payload?.liveActivity) return;
  const activity = (await query.query("SELECT * FROM live_activities WHERE id=$1",[row.activity_id])).rows[0];
  const endCommand = operation === "end" ? {
    ...command,operation: "end",sequence: Number(row.sequence),
    providerTimestamp: activityProviderTimestamp(activity),startedAt: activityStartedAt(activity),
    dismissAfterSeconds: 0,alertOwner: "none",interaction: null,retirement: row.reason,
  } : operation === "start" ? {
    ...command,operation: "start",sequence: Number(row.sequence),
    providerTimestamp: activityProviderTimestamp(activity),startedAt: activityStartedAt(activity),
    alertOwner: "none",interaction: null,presentationState: "background",quietRestart: true,
    ...(generation === undefined ? {} : { generation }),
    ...(owner ? { owner: { ...command.owner,...owner } } : {}),
  } : {
    ...command,operation: "update",sequence: Number(row.sequence),
    providerTimestamp: activityProviderTimestamp(activity),startedAt: activityStartedAt(activity),
    alertOwner: "none",interaction: null,...(owner ? { owner: { ...command.owner,...owner } } : {}),
  };
  const event = await query.query(
    `INSERT INTO notification_events(
       principal_id,requester_credential_id,requester_service_id,source,kind,title,body,payload,
       idempotency_key,target_mode,expires_at,origin_hash,created_at
     ) VALUES ($1,$2,$3,$4,'live_activity',$5,$6,$7,$8,'explicit',$9,$10,clock_timestamp()) RETURNING id`,
    [row.principal_id,source.requester_credential_id,source.requester_service_id,source.source,source.title,source.body,
      { liveActivity: endCommand },`server:${randomUUID()}:${operation === "end" ? "retire" : operation === "start" ? "replace" : "restale"}`,new Date(Date.now()+3_600_000),source.origin_hash ?? null],
  );
  await query.query(
    "INSERT INTO notification_event_targets(notification_event_id,device_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
    [event.rows[0].id,row.device_id],
  );
  const remote = apnsMode === "disabled" ? { rowCount: 0 } : await query.query(
    `INSERT INTO delivery_jobs(notification_event_id,device_id,transport,live_activity_id)
     SELECT $1,d.id,$6,$3 FROM devices d
     WHERE d.id=$2 AND d.principal_id=$4 AND d.revoked_at IS NULL
       AND d.apns_environment=$5::apns_environment ON CONFLICT DO NOTHING`,
    [event.rows[0].id,row.device_id,row.activity_id,row.principal_id,apnsMode,
      operation === "start" ? "live_activity_start" : "live_activity_update"],
  );
  await query.query("UPDATE notification_events SET delivery_summary=$2::jsonb WHERE id=$1",
    [event.rows[0].id,{ eligibleDevices: 1,durableCommands: 1,apnsJobs: remote.rowCount ?? 0 }]);
}
