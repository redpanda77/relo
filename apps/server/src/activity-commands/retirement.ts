import { randomUUID } from "node:crypto";
import { LOCK_SCREEN_MAX_CARDS,OWNER_STATE_TIMING,type OwnerStateResult } from "@relo/notification-contracts";
import { loadOwnerStateInputs } from "../derive/load.js";
import { deriveOwnerState } from "../derive/owner-state.js";
import type { Database } from "../db.js";
import { publicId } from "../ids.js";
import { activityProviderTimestamp,activityStartedAt } from "./runtime.js";
import type { ApnsMode } from "../activities.js";

/** Display retirement reasons (F.10 VISIBILITY_REASONS). */
export type RetirementReason = "retired_no_signal" | "retired_stopped_responding" | "retired_paused"
  | "retired_waiting_on_you" | "retired_left_unfinished" | "over_card_limit" | "activitykit_limit";

type Candidate = {
  activity_id: string; principal_id: string; device_id: string; sequence: string; generation: string;
  reason: RetirementReason;
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
 * over_card_limit; presented longer than T_history → activitykit_limit. A shown card whose staleDate
 * moved ≥ 10 min past the last pushed one gets a priority-5 update carrying the new staleDate.
 * `since` (the previous pass) wakes each account whose derived state changed by time alone in
 * between (1.5d). Returns the earliest next change so the worker sleeps until then.
 */
export async function retireByPolicy(db: Database,apnsMode: ApnsMode,limit = 200,
  options: { now?: Date; since?: Date | null } = {}): Promise<RetirementPass> {
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
    const restale: Array<Shown & { owner: OwnerStateResult }> = [];
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
            due.push({ ...base,reason: "activitykit_limit" }); continue;
          }
          if (owner.lockScreen === "none") { due.push({ ...base,reason: reasonFor(owner) }); continue; }
          slot += 1;
          if (slot > LOCK_SCREEN_MAX_CARDS && owner.state !== "needs_you") { due.push({ ...base,reason: "over_card_limit" }); continue; }
          const pushed = row.stale_date_pushed?.valueOf() ?? null;
          if (pushed !== null && Date.parse(owner.staleDate) - pushed >= RESTALE_MIN_MS) restale.push({ ...row,owner });
        }
      }
    }
    let retired = 0;
    for (const row of due.slice(0,limit)) {
      const lease = await client.query(
        `UPDATE live_activity_presentation_leases SET state='not_presented',reason=$3,updated_at=clock_timestamp()
         WHERE live_activity_id=$1 AND device_id=$2 AND state IN ('eligible','foreground','background','pending_token')
         RETURNING live_activity_id`,
        [row.activity_id,row.device_id,row.reason],
      );
      if (!lease.rowCount) continue;
      await enqueueDisplayCommand(client,apnsMode,row,"end");
      retired += 1;
    }
    let restaled = 0;
    for (const row of restale) {
      await client.query(`UPDATE live_activity_presentation_leases SET stale_date_pushed=$3
        WHERE live_activity_id=$1 AND device_id=$2`,[row.activity_id,row.device_id,row.owner.staleDate]);
      const { changed: _changed,...owner } = row.owner as OwnerStateResult & { changed?: boolean };
      await enqueueDisplayCommand(client,apnsMode,{ ...row,reason: "retired_no_signal" },"update",owner);
      restaled += 1;
    }
    await client.query("COMMIT");
    return { retired,restaled,woken,nextAt: nextAt === null ? null : new Date(nextAt) };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * A display command for one device carrying the card's current content: an end dismissed at once,
 * or a priority-5 update with a refreshed staleDate. The card row is untouched: same sequence, same
 * declared fields.
 */
async function enqueueDisplayCommand(
  query: { query: (text: string, values?: unknown[]) => Promise<any> },apnsMode: ApnsMode,row: Candidate,
  operation: "end" | "update",owner?: OwnerStateResult,
): Promise<void> {
  const latest = await query.query(
    `SELECT e.source,e.title,e.body,e.payload,e.origin_hash,e.requester_credential_id,e.requester_service_id
     FROM notification_events e
     WHERE e.principal_id=$1 AND e.payload#>>'{liveActivity,activityId}'=$2
       AND e.payload#>>'{liveActivity,targetDeviceId}'=$3
     ORDER BY e.created_at DESC,e.id DESC LIMIT 1`,
    [row.principal_id,publicId("act",row.activity_id),row.device_id],
  );
  const source = latest.rows[0];
  const command = source?.payload?.liveActivity;
  if (!command) return;
  const activity = (await query.query("SELECT * FROM live_activities WHERE id=$1",[row.activity_id])).rows[0];
  const endCommand = operation === "end" ? {
    ...command,operation: "end",sequence: Number(row.sequence),
    providerTimestamp: activityProviderTimestamp(activity),startedAt: activityStartedAt(activity),
    dismissAfterSeconds: 0,alertOwner: "none",interaction: null,retirement: row.reason,
  } : {
    ...command,operation: "update",sequence: Number(row.sequence),
    providerTimestamp: activityProviderTimestamp(activity),startedAt: activityStartedAt(activity),
    alertOwner: "none",interaction: null,...(owner ? { owner: { ...command.owner,...owner } } : {}),
  };
  const event = await query.query(
    `INSERT INTO notification_events(
       principal_id,requester_credential_id,requester_service_id,source,kind,title,body,payload,
       idempotency_key,target_mode,expires_at,origin_hash
     ) VALUES ($1,$2,$3,$4,'live_activity',$5,$6,$7,$8,'explicit',$9,$10) RETURNING id`,
    [row.principal_id,source.requester_credential_id,source.requester_service_id,source.source,source.title,source.body,
      { liveActivity: endCommand },`server:${randomUUID()}:${operation === "end" ? "retire" : "restale"}`,new Date(Date.now()+3_600_000),source.origin_hash ?? null],
  );
  await query.query(
    "INSERT INTO notification_event_targets(notification_event_id,device_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
    [event.rows[0].id,row.device_id],
  );
  const remote = apnsMode === "disabled" ? { rowCount: 0 } : await query.query(
    `INSERT INTO delivery_jobs(notification_event_id,device_id,transport,live_activity_id)
     SELECT $1,d.id,'live_activity_update',$3 FROM devices d
     WHERE d.id=$2 AND d.principal_id=$4 AND d.revoked_at IS NULL
       AND d.apns_environment=$5::apns_environment ON CONFLICT DO NOTHING`,
    [event.rows[0].id,row.device_id,row.activity_id,row.principal_id,apnsMode],
  );
  await query.query("UPDATE notification_events SET delivery_summary=$2::jsonb WHERE id=$1",
    [event.rows[0].id,{ eligibleDevices: 1,durableCommands: 1,apnsJobs: remote.rowCount ?? 0 }]);
}
