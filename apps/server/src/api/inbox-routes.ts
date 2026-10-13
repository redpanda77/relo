import { loadInboxSnapshot } from "../inbox/queries.js";
import { markReadItems } from "../inbox/read-service.js";
import { inboxReadItemsRequestSchema } from "@relo/notification-contracts";
import { boundedIntegerQuery } from "../request-bounds.js";
import { decodePendingCursor,loadPendingInteractions } from "../pending-inventory.js";
import { decodeCurrentCursor,loadCurrentState } from "../current-state.js";
import { currentStateStream } from "../current-state-stream.js";
import { Hono } from "hono";
import {
  expireDueActivities } from "../activities.js";
import { currentSubjectIdSchema } from "@relo/notification-contracts";
import {  requireScope } from "../auth.js";
import { internalId, publicId } from "../ids.js";
import { loadDeliveryEvidence } from "../delivery-evidence.js";
import { mobileInboxHistoryWindow,inboxReadMetadata,encodeInboxHistoryCursor,decodeInboxHistoryCursor,projectedInboxLiveActivity,inboxActivityProjectionSql,inboxActivityJoinSql,inboxItemResource } from "./resources.js";
import type { ApiRouteContext } from "./route-context.js";

/** The phone inbox read API: change stream, current state, pending decisions, history and read state. */
export function registerInboxRoutes(app: Hono, shared: ApiRouteContext): void {
  const { db,apnsMode,dependencies,integratedDependencies,notificationContentCipher } = shared;
  app.get("/api/inbox/events",requireScope("inbox:read"),context=>currentStateStream(context,db,dependencies?.currentChanges));

  app.get("/api/inbox/current", requireScope("inbox:read"), async (context) => {
    context.header("Cache-Control","no-store");
    const actor = context.get("auth");
    const limit = boundedIntegerQuery(context.req.query("limit"),50,1,50);
    if (limit === null) return context.json({ error: "invalid_limit" },400);
    const requestedIds = context.req.queries("id");
    const after = context.req.query("after");
    if (requestedIds && (requestedIds.length>50 || after!==undefined || context.req.query("limit")!==undefined
      || requestedIds.some(id=>!currentSubjectIdSchema.safeParse(id).success))) {
      return context.json({ error: "invalid_subject_selection" },400);
    }
    const cursor = after===undefined ? undefined : decodeCurrentCursor(after,actor);
    if (cursor===null) return context.json({ error: "cursor_expired" },410);
    return context.json(await loadCurrentState(db,actor,{ limit,
      ...(requestedIds ? { ids:[...new Set(requestedIds)] } : {}),...(cursor ? { after:cursor } : {}),
    }));
  });

  app.get("/api/inbox/pending", requireScope("inbox:read"), async (context) => {
    context.header("Cache-Control","no-store");
    const actor = context.get("auth");
    const limit = boundedIntegerQuery(context.req.query("limit"),50,1,100);
    if (limit === null) return context.json({ error: "invalid_limit" },400);
    const after = context.req.query("after");
    const cursor = after === undefined ? undefined : decodePendingCursor(after,actor);
    if (cursor === null) return context.json({ error: "cursor_expired" },410);
    return context.json(await loadPendingInteractions(db,actor,{ limit,...(cursor ? { after: cursor } : {}) }));
  });

  app.get("/api/inbox/snapshot", requireScope("inbox:read"), async (context) => {
    context.header("Cache-Control", "no-store");
    const auth = context.get("auth");
    return context.json(await loadInboxSnapshot(db, {
      principalId: auth.principalId, ...(auth.deviceId ? { deviceId: auth.deviceId } : {}),
    }));
  });

  app.get("/api/inbox/history", requireScope("inbox:read"), async (context) => {
    const auth = context.get("auth");
    const rawLimit = context.req.query("limit");
    const limit = rawLimit === undefined ? 20 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (rawLimit !== undefined && !/^\d+$/.test(rawLimit))) {
      return context.json({ error: "invalid_limit" },400);
    }
    const before = context.req.query("before");
    const cursor = decodeInboxHistoryCursor(before);
    if (before !== undefined && !cursor) return context.json({ error: "cursor_expired" },410);

    const queryValues: unknown[] = [
      auth.principalId,
      cursor?.createdAt ?? null,
      cursor?.id ?? null,
    ];
    if (auth.deviceId) queryValues.push(auth.deviceId);
    const result = await db.query<any>(
      `WITH scoped AS MATERIALIZED (
         SELECT retained.id,retained.created_at FROM (
           SELECT e.id,e.created_at
           FROM notification_events e
           WHERE e.principal_id=$1
             ${auth.deviceId ? `AND (e.target_mode='broadcast' OR EXISTS (
               SELECT 1 FROM notification_event_targets target
               WHERE target.notification_event_id=e.id AND target.device_id=$4
             ))` : ""}
           ORDER BY e.created_at DESC,e.id DESC
           LIMIT ${mobileInboxHistoryWindow}
         ) retained
       ), metadata AS (
         SELECT count(*)::int AS total,
           ($2::timestamptz IS NULL OR EXISTS (
             SELECT 1 FROM scoped anchor WHERE (anchor.created_at,anchor.id)=($2::timestamptz,$3::uuid)
           )) AS cursor_valid
         FROM scoped
       ), page AS (
         SELECT e.*,
           ${inboxActivityProjectionSql},
           to_char(visible.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_iso,
           to_char(visible.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS history_cursor_at,
           r.id AS interaction_id,r.kind AS interaction_kind,r.prompt AS interaction_prompt,
           r.state AS interaction_state,r.expires_at AS interaction_expires_at,
           r.responded_at AS interaction_responded_at,
           (SELECT CASE WHEN j.provider_outcome_category='invalid-recipient' THEN 'token_invalid' ELSE j.state END
             FROM delivery_jobs j WHERE j.notification_event_id=e.id
             ${auth.deviceId ? "AND j.device_id=$4" : ""} ORDER BY j.updated_at DESC LIMIT 1) AS delivery_state,
           (SELECT accepted_at FROM delivery_jobs j WHERE j.notification_event_id=e.id
             ${auth.deviceId ? "AND j.device_id=$4" : ""} ORDER BY j.updated_at DESC LIMIT 1) AS accepted_at,
           (SELECT created_at FROM interactions i WHERE i.notification_event_id=e.id AND i.kind='received'
             ORDER BY created_at DESC LIMIT 1) AS received_at,
           (SELECT created_at FROM interactions i WHERE i.notification_event_id=e.id AND i.kind='opened'
             ORDER BY created_at DESC LIMIT 1) AS opened_at
         FROM scoped visible
         JOIN notification_events e ON e.id=visible.id
         ${inboxActivityJoinSql}
         LEFT JOIN interaction_requests r ON r.notification_event_id=e.id
         WHERE ($2::timestamptz IS NULL OR (visible.created_at,visible.id)<($2::timestamptz,$3::uuid))
         ORDER BY visible.created_at DESC,visible.id DESC
         LIMIT ${limit + 1}
       )
       SELECT page.*,metadata.total,metadata.cursor_valid
       FROM metadata LEFT JOIN page ON metadata.cursor_valid
       ORDER BY page.created_at DESC,page.id DESC`,
      queryValues,
    );
    const metadata = result.rows[0] as { id: string | null; total: number; cursor_valid: boolean } | undefined;
    if (!metadata?.cursor_valid) return context.json({ error: "cursor_expired" },410);
    const pageRows = result.rows.filter((row: any) => row.id !== null);
    const hasMore = pageRows.length > limit;
    const rows = pageRows.slice(0,limit);
    const last = rows.at(-1);
    const readMetadata = await inboxReadMetadata(db,auth.principalId,auth.deviceId);
    return context.json({
      items: rows.map((row: any) => inboxItemResource(
        row,auth,integratedDependencies?.credentialDerivationSecret,notificationContentCipher ?? undefined,
      )),
      cursor: hasMore && last ? encodeInboxHistoryCursor(last.history_cursor_at,last.id) : null,
      hasMore,
      total: metadata.total,
      serverTime: new Date().toISOString(),
      ...readMetadata,
    });
  });

  app.post("/api/inbox/read-items", requireScope("inbox:read"), async (context) => {
    context.header("Cache-Control", "no-store");
    const auth=context.get("auth");
    const input=inboxReadItemsRequestSchema.parse(await context.req.json());
    return context.json(await markReadItems(db,{principalId:auth.principalId,
      ...(auth.deviceId ? {deviceId:auth.deviceId} : {})},input.notificationIds));
  });

  app.get("/api/inbox/live-activities/active", requireScope("inbox:read"), async (context) => {
    const auth = context.get("auth");
    await expireDueActivities(db,apnsMode);
    const values: unknown[] = [auth.principalId];
    if (auth.deviceId) values.push(auth.deviceId);
    const result = await db.query<any>(
      `SELECT activity.id AS active_id,activity.generation,
         event.id,event.principal_id,event.payload,
         to_char(event.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_iso,
         interaction.id AS interaction_id,interaction.kind AS interaction_kind,
         interaction.state AS interaction_state,interaction.expires_at AS interaction_expires_at,
         ${auth.deviceId ? `(SELECT job.state FROM delivery_jobs job
           WHERE job.notification_event_id=event.id AND job.device_id=$2
           ORDER BY job.updated_at DESC LIMIT 1)` : "NULL"} AS delivery_state
       FROM live_activities activity
       LEFT JOIN LATERAL (
         SELECT candidate.* FROM notification_events candidate
         WHERE candidate.principal_id=activity.principal_id
           AND candidate.kind='live_activity'
           AND candidate.payload#>>'{liveActivity,activityId}'=('act_'||activity.id::text)
           AND candidate.payload#>>'{liveActivity,generation}'=activity.generation::text
           ${auth.deviceId ? `AND (candidate.target_mode='broadcast' OR EXISTS (
             SELECT 1 FROM notification_event_targets target
             WHERE target.notification_event_id=candidate.id AND target.device_id=$2
           ))` : ""}
         ORDER BY candidate.created_at DESC,candidate.id DESC
         LIMIT 1
       ) event ON true
       LEFT JOIN interaction_requests interaction ON interaction.notification_event_id=event.id
       WHERE activity.principal_id=$1 AND activity.state='active'
       ORDER BY activity.id,activity.generation`,
      values,
    );
    return context.json({ activities: result.rows.map((row) => ({
      id: publicId("act",row.active_id),generation: Number(row.generation),
      eventId: row.id ? publicId("ntf",row.id) : null,
      createdAt: row.created_at_iso ?? null,
      command: row.id ? projectedInboxLiveActivity(
        row.payload,row,auth.deviceId,auth.deviceCredentialVersion,
        integratedDependencies?.credentialDerivationSecret,
      ) : null,
    })) });
  });

  app.get("/api/inbox/:notificationId", requireScope("inbox:read"), async (context) => {
    const auth = context.get("auth");
    const eventId = internalId("ntf",context.req.param("notificationId") ?? "");
    if (!eventId) return context.json({ error: "not_found" },404);
    const values: unknown[] = [eventId,auth.principalId];
    if (auth.deviceId) values.push(auth.deviceId);
    const result = await db.query<any>(
      `SELECT e.*,${inboxActivityProjectionSql},
        to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_iso,
        r.id AS interaction_id,r.kind AS interaction_kind,r.prompt AS interaction_prompt,
        r.state AS interaction_state,r.expires_at AS interaction_expires_at,
        r.responded_at AS interaction_responded_at,
        (SELECT CASE WHEN j.provider_outcome_category='invalid-recipient' THEN 'token_invalid' ELSE j.state END
          FROM delivery_jobs j WHERE j.notification_event_id=e.id
          ${auth.deviceId ? "AND j.device_id=$3" : ""} ORDER BY j.updated_at DESC LIMIT 1) AS delivery_state,
        (SELECT accepted_at FROM delivery_jobs j WHERE j.notification_event_id=e.id
          ${auth.deviceId ? "AND j.device_id=$3" : ""} ORDER BY j.updated_at DESC LIMIT 1) AS accepted_at,
        (SELECT created_at FROM interactions i WHERE i.notification_event_id=e.id AND i.kind='received'
          ORDER BY created_at DESC LIMIT 1) AS received_at,
        (SELECT created_at FROM interactions i WHERE i.notification_event_id=e.id AND i.kind='opened'
          ORDER BY created_at DESC LIMIT 1) AS opened_at
       FROM notification_events e ${inboxActivityJoinSql}
       LEFT JOIN interaction_requests r ON r.notification_event_id=e.id
       WHERE e.id=$1 AND e.principal_id=$2
         ${auth.deviceId ? `AND (e.target_mode='broadcast' OR EXISTS (
           SELECT 1 FROM notification_event_targets target
           WHERE target.notification_event_id=e.id AND target.device_id=$3
         ))` : ""}`,
      values,
    );
    if (!result.rowCount) return context.json({ error: "not_found" },404);
    const [deliveries,interactions,withdrawals,timeline] = await Promise.all([
      db.query<any>(
        `SELECT id,device_id,transport,state,attempt_count,provider_outcome_category,
           last_error_code,accepted_at,created_at,updated_at
         FROM delivery_jobs WHERE notification_event_id=$1
           ${auth.deviceId ? "AND device_id=$2" : ""} ORDER BY created_at,id`,
        auth.deviceId ? [eventId,auth.deviceId] : [eventId],
      ),
      db.query<any>(
        `SELECT kind,created_at FROM interactions WHERE notification_event_id=$1
           ${auth.deviceId ? "AND device_id=$2" : ""} ORDER BY created_at,id`,
        auth.deviceId ? [eventId,auth.deviceId] : [eventId],
      ),
      db.query<any>(
        `SELECT device_id,outcome,detail_code,created_at FROM notification_withdrawal_evidence
         WHERE notification_event_id=$1 ${auth.deviceId ? "AND (device_id IS NULL OR device_id=$2)" : ""}
         ORDER BY created_at,id`,auth.deviceId ? [eventId,auth.deviceId] : [eventId],
      ),
      loadDeliveryEvidence(db,auth.principalId,{
        notificationId: publicId("ntf",eventId),deviceId: auth.deviceId ?? null,limit: 100,
      }),
    ]);
    return context.json({
      item: inboxItemResource(result.rows[0],auth,integratedDependencies?.credentialDerivationSecret,
        notificationContentCipher ?? undefined),
      evidence: {
        version: timeline.version,
        timeline: timeline.items,
        deliveries: deliveries.rows.map((row) => ({
          id: publicId("job",row.id),
          deviceId: row.device_id ? publicId("dev",row.device_id) : null,
          transport: row.transport,state: row.state,attemptCount: Number(row.attempt_count),
          providerOutcome: row.provider_outcome_category ?? null,
          errorCode: row.last_error_code ?? null,acceptedAt: row.accepted_at ?? null,
          createdAt: row.created_at,updatedAt: row.updated_at,
        })),
        interactions: interactions.rows.map((row) => ({
          kind: row.kind,createdAt: row.created_at,
        })),
        withdrawals: withdrawals.rows.map((row) => ({
          deviceId: row.device_id ? publicId("dev",row.device_id) : null,
          outcome: row.outcome,detailCode: row.detail_code ?? null,createdAt: row.created_at,
        })),
      },
    });
  });

}
