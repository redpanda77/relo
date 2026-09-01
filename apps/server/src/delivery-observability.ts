import type { Hono } from "hono";
import { z } from "zod";
import { loadActivityDiagnosis } from "./activity-diagnosis.js";
import { safeDiagnosticCode } from "./apns-observability.js";
import type { ApnsMode } from "./activities.js";
import { requireScope } from "./auth.js";
import type { Database } from "./db.js";
import {
  DeliveryEvidenceError,loadDeliveryEvidence,loadDeliveryEvidenceMetrics,
} from "./delivery-evidence.js";
import {
  DeliveryReconciliationError,deliveryReconciliationActions,reconcileDeliveryJob,
} from "./delivery-reconciliation.js";
import { internalId,publicId } from "./ids.js";

const deliveryStatuses = [
  "queued","sending","accepted_by_apns","retryable","rejected","token_invalid",
  "reconciliation_required","canceled",
] as const;
const deliveryStatusSchema = z.enum(deliveryStatuses);

type DeliveryCursor = {
  createdAt: string;
  id: string;
  notificationId: string | null;
  deviceId: string | null;
  status: typeof deliveryStatuses[number] | null;
};

type AttemptCursor = { createdAt: string; id: string; deliveryId: string };

export function registerDeliveryObservabilityRoutes(app: Hono,db: Database,apnsMode: ApnsMode): void {
  app.get("/api/live-activities/:activityId/diagnosis",requireScope("devices:read"),async (context) => {
    const auth = context.get("auth");
    if (auth.credentialKind !== "principal") return context.json({ error: "forbidden" },403);
    const activityId = internalId("act",context.req.param("activityId") ?? "");
    if (!activityId) return context.json({ error: "activity_not_found" },404);
    const diagnosis = await loadActivityDiagnosis(db,auth.principalId,activityId,apnsMode);
    if (!diagnosis) return context.json({ error: "activity_not_found" },404);
    context.header("cache-control","private, no-store");
    return context.json(diagnosis);
  });

  app.get("/api/evidence/timeline",requireScope("devices:read"),async (context) => {
    const auth = context.get("auth");
    if (auth.credentialKind !== "principal") return context.json({ error: "forbidden" },403);
    const params = new URL(context.req.url).searchParams;
    const limitValues = params.getAll("limit");
    const notificationValues = params.getAll("notificationId");
    const cursorValues = params.getAll("cursor");
    if (limitValues.length > 1 || notificationValues.length > 1 || cursorValues.length > 1) {
      return context.json({ error: "invalid_filter" },400);
    }
    const rawLimit = limitValues[0];
    const limit = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (rawLimit && !/^\d+$/u.test(rawLimit))) {
      return context.json({ error: "invalid_filter" },400);
    }
    try {
      const result = await loadDeliveryEvidence(db,auth.principalId,{
        notificationId: notificationValues[0] ?? null,cursor: cursorValues[0] ?? null,limit,
      });
      context.header("cache-control","private, no-store");
      return context.json(result);
    } catch (error) {
      if (error instanceof DeliveryEvidenceError) return context.json({ error: error.code },error.status);
      throw error;
    }
  });

  app.get("/api/evidence/metrics",requireScope("devices:read"),async (context) => {
    const auth = context.get("auth");
    if (auth.credentialKind !== "principal") return context.json({ error: "forbidden" },403);
    context.header("cache-control","private, no-store");
    return context.json(await loadDeliveryEvidenceMetrics(db,auth.principalId));
  });

  app.get("/api/deliveries/status",requireScope("devices:read"),(context) => {
    const auth = context.get("auth");
    if (auth.credentialKind !== "principal") return context.json({ error: "forbidden" },403);
    context.header("cache-control","private, no-store");
    return context.json({ apns: apnsTransportTruth(apnsMode) });
  });

  app.post("/api/deliveries/:deliveryId/reconcile",requireScope("activities:write"),async (context) => {
    const auth = context.get("auth");
    if (auth.credentialKind !== "principal" || !auth.credentialId) {
      return context.json({ error: "forbidden" },403);
    }
    const deliveryJobId = internalId("job",context.req.param("deliveryId") ?? "");
    if (!deliveryJobId) return context.json({ error: "delivery_not_found" },404);
    const parsed = z.object({ action: z.enum(deliveryReconciliationActions) }).strict()
      .safeParse(await context.req.json());
    if (!parsed.success) return context.json({ error: "invalid_reconciliation_action" },400);
    try {
      return context.json(await reconcileDeliveryJob(db,{
        principalId: auth.principalId,deliveryJobId,action: parsed.data.action,
        actor: { kind: "credential",credentialId: auth.credentialId },
      }));
    } catch (error) {
      if (error instanceof DeliveryReconciliationError) {
        return context.json({ error: error.code },error.status);
      }
      throw error;
    }
  });

  app.get("/api/deliveries",requireScope("devices:read"),async (context) => {
    const auth = context.get("auth");
    if (auth.credentialKind !== "principal") return context.json({ error: "forbidden" },403);
    const params = new URL(context.req.url).searchParams;
    const parsedLimit = parseLimit(params,50);
    if (!parsedLimit.ok) return context.json({ error: "invalid_limit" },400);
    const parsedFilters = parseDeliveryFilters(params);
    if (!parsedFilters.ok) return context.json({ error: "invalid_filter" },400);
    const rawCursors = params.getAll("cursor");
    const cursor = decodeDeliveryCursor(rawCursors[0]);
    if (rawCursors.length > 1 || (rawCursors.length === 1 && !cursor)
      || (cursor && !sameFilters(cursor,parsedFilters))) {
      return context.json({ error: "cursor_expired" },410);
    }
    const stateClause = parsedFilters.status ? statusSql(parsedFilters.status) : "TRUE";
    const rows = await db.query<any>(
      `WITH scoped AS MATERIALIZED (
         SELECT j.id,j.notification_event_id,j.device_id,j.transport,j.state,j.attempt_count,
           j.available_at,j.provider_message_id,j.accepted_at,j.provider_outcome_category,
           j.provider_status,j.provider_transport_code,j.last_error_code,j.provider_attempts_used,
           j.provider_retry_started_at,j.provider_retry_attempt_cap,j.provider_retry_horizon_at,
           j.provider_next_attempt_not_before,j.last_provider_attempt_at,j.created_at,j.updated_at,
           j.first_claimed_at,j.last_claimed_at,j.last_dispatch_started_at,j.apns_priority,
           j.canonical_intent_sha256,j.device_projection_sha256,
           j.apns_payload_sha256,
           e.id AS event_id,e.created_at AS event_created_at,d.name AS device_name,
           to_char(j.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at,
           receipt.received_at,receipt.opened_at,latest.provider_reason,latest.invalidated_at
         FROM delivery_jobs j
         JOIN notification_events e ON e.id=j.notification_event_id
         JOIN devices d ON d.id=j.device_id AND d.principal_id=e.principal_id
         LEFT JOIN LATERAL (
           SELECT min(i.created_at) FILTER (WHERE i.kind='received') AS received_at,
             min(i.created_at) FILTER (WHERE i.kind='opened') AS opened_at
           FROM interactions i WHERE i.notification_event_id=e.id AND i.device_id=j.device_id
             AND i.principal_id=e.principal_id
         ) receipt ON true
         LEFT JOIN LATERAL (
           SELECT a.provider_reason,a.invalidated_at FROM delivery_attempts a
           WHERE a.delivery_job_id=j.id ORDER BY a.created_at DESC,a.id DESC LIMIT 1
         ) latest ON true
         WHERE e.principal_id=$1
           AND ($4::uuid IS NULL OR e.id=$4::uuid)
           AND ($5::uuid IS NULL OR d.id=$5::uuid)
           AND ${stateClause}
       ), metadata AS (
         SELECT ($2::timestamptz IS NULL OR EXISTS (
           SELECT 1 FROM scoped anchor
           WHERE (anchor.created_at,anchor.id)=($2::timestamptz,$3::uuid)
         )) AS cursor_valid
       ), page AS (
         SELECT scoped.* FROM scoped,metadata WHERE metadata.cursor_valid
           AND ($2::timestamptz IS NULL OR (scoped.created_at,scoped.id)<($2::timestamptz,$3::uuid))
         ORDER BY scoped.created_at DESC,scoped.id DESC LIMIT ${parsedLimit.limit + 1}
       )
       SELECT page.*,metadata.cursor_valid FROM metadata LEFT JOIN page ON metadata.cursor_valid
       ORDER BY page.created_at DESC,page.id DESC`,
      [
        auth.principalId,cursor?.createdAt ?? null,cursor?.id ?? null,
        parsedFilters.notificationInternalId,parsedFilters.deviceInternalId,
      ],
    );
    const metadata = rows.rows[0] as { id: string | null; cursor_valid: boolean } | undefined;
    if (!metadata?.cursor_valid) return context.json({ error: "cursor_expired" },410);
    const pageRows = rows.rows.filter((row: any) => row.id !== null);
    const hasMore = pageRows.length > parsedLimit.limit;
    const page = pageRows.slice(0,parsedLimit.limit);
    const last = page.at(-1);
    context.header("cache-control","private, no-store");
    return context.json({
      apns: apnsTransportTruth(apnsMode),
      deliveries: page.map(deliveryResource),
      cursor: hasMore && last ? encodeDeliveryCursor({
        createdAt: last.cursor_created_at,id: last.id,
        notificationId: parsedFilters.notificationId,deviceId: parsedFilters.deviceId,
        status: parsedFilters.status,
      }) : null,
      hasMore,
    });
  });

  app.get("/api/deliveries/:deliveryId/attempts",requireScope("devices:read"),async (context) => {
    const auth = context.get("auth");
    if (auth.credentialKind !== "principal") return context.json({ error: "forbidden" },403);
    const externalDeliveryId = context.req.param("deliveryId") ?? "";
    const deliveryId = internalId("job",externalDeliveryId);
    if (!deliveryId) return context.json({ error: "not_found" },404);
    const params = new URL(context.req.url).searchParams;
    const parsedLimit = parseLimit(params,50);
    if (!parsedLimit.ok) return context.json({ error: "invalid_limit" },400);
    const rawCursors = params.getAll("cursor");
    const cursor = decodeAttemptCursor(rawCursors[0]);
    if (rawCursors.length > 1 || (rawCursors.length === 1 && !cursor)
      || (cursor && cursor.deliveryId !== externalDeliveryId)) {
      return context.json({ error: "cursor_expired" },410);
    }
    const owned = await db.query(
      `SELECT 1 FROM delivery_jobs j JOIN notification_events e ON e.id=j.notification_event_id
       JOIN devices d ON d.id=j.device_id AND d.principal_id=e.principal_id
       WHERE j.id=$1 AND e.principal_id=$2`,
      [deliveryId,auth.principalId],
    );
    if (!owned.rowCount) return context.json({ error: "not_found" },404);
    const rows = await db.query<any>(
      `WITH scoped AS MATERIALIZED (
         SELECT a.id,a.job_attempt,a.provider_attempts,a.outcome_category,a.provider_status,
           a.provider_reason,a.provider_message_id,a.transport_code,a.invalidated_at,
           a.provider_first_attempt_at,a.created_at,
           to_char(a.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
         FROM delivery_attempts a WHERE a.delivery_job_id=$1
       ), metadata AS (
         SELECT ($2::timestamptz IS NULL OR EXISTS (
           SELECT 1 FROM scoped anchor
           WHERE (anchor.created_at,anchor.id)=($2::timestamptz,$3::uuid)
         )) AS cursor_valid
       ), page AS (
         SELECT scoped.* FROM scoped,metadata WHERE metadata.cursor_valid
           AND ($2::timestamptz IS NULL OR (scoped.created_at,scoped.id)<($2::timestamptz,$3::uuid))
         ORDER BY scoped.created_at DESC,scoped.id DESC LIMIT ${parsedLimit.limit + 1}
       )
       SELECT page.*,metadata.cursor_valid FROM metadata LEFT JOIN page ON metadata.cursor_valid
       ORDER BY page.created_at DESC,page.id DESC`,
      [deliveryId,cursor?.createdAt ?? null,cursor?.id ?? null],
    );
    const metadata = rows.rows[0] as { id: string | null; cursor_valid: boolean } | undefined;
    if (!metadata?.cursor_valid) return context.json({ error: "cursor_expired" },410);
    const pageRows = rows.rows.filter((row: any) => row.id !== null);
    const hasMore = pageRows.length > parsedLimit.limit;
    const page = pageRows.slice(0,parsedLimit.limit);
    const last = page.at(-1);
    context.header("cache-control","private, no-store");
    return context.json({
      apns: apnsTransportTruth(apnsMode),
      deliveryId: externalDeliveryId,
      attempts: page.map((row: any) => attemptResource(row,externalDeliveryId)),
      cursor: hasMore && last ? encodeAttemptCursor({
        createdAt: last.cursor_created_at,id: last.id,deliveryId: externalDeliveryId,
      }) : null,
      hasMore,
    });
  });
}

function deliveryResource(row: any) {
  return {
    id: publicId("job",row.id),notificationId: publicId("ntf",row.event_id),
    device: { id: publicId("dev",row.device_id),name: row.device_name },
    transport: row.transport,status: externalDeliveryStatus(row),
    jobAttemptCount: Number(row.attempt_count),
    provider: {
      outcome: safeDiagnosticCode(row.provider_outcome_category),
      status: row.provider_status === null ? null : Number(row.provider_status),
      reason: safeDiagnosticCode(row.provider_reason),
      messageId: safeDiagnosticCode(row.provider_message_id),
      transportCode: safeDiagnosticCode(row.provider_transport_code),
      priority: row.apns_priority === null ? null : Number(row.apns_priority),
      acceptedAt: row.accepted_at ?? null,
      lastAttemptAt: row.last_provider_attempt_at ?? null,
    },
    receipt: { receivedAt: row.received_at ?? null,openedAt: row.opened_at ?? null },
    retry: {
      providerAttemptsUsed: Number(row.provider_attempts_used),
      firstAttemptAt: row.provider_retry_started_at ?? null,
      attemptCap: row.provider_retry_attempt_cap === null ? null : Number(row.provider_retry_attempt_cap),
      horizonAt: row.provider_retry_horizon_at ?? null,
      nextAttemptNotBefore: row.provider_next_attempt_not_before ?? null,
      jobAvailableAt: row.available_at,
    },
    serialization: {
      canonicalIntent: shortHash(row.canonical_intent_sha256),
      deviceProjection: shortHash(row.device_projection_sha256),
      providerBytes: shortHash(row.apns_payload_sha256),
    },
    tokenInvalidatedAt: row.invalidated_at ?? null,
    reconciliation: {
      required: row.state === "reconciliation_required",
      code: row.state === "reconciliation_required" ? safeDiagnosticCode(row.last_error_code) : null,
    },
    timeline: {
      apiCommittedAt: row.event_created_at,
      jobEnqueuedAt: row.created_at,
      firstWorkerClaimedAt: row.first_claimed_at ?? null,
      lastWorkerClaimedAt: row.last_claimed_at ?? null,
      dispatchFenceAt: row.last_dispatch_started_at ?? null,
      apnsRequestStartedAt: row.provider_retry_started_at ?? null,
      acceptedByApnsAt: row.accepted_at ?? null,
      deviceReceivedAt: row.received_at ?? null,
      deviceOpenedAt: row.opened_at ?? null,
    },
    latencyMs: {
      commitToEnqueue: elapsed(row.event_created_at,row.created_at),
      enqueueToFirstClaim: elapsed(row.created_at,row.first_claimed_at),
      firstClaimToApnsRequest: elapsed(row.first_claimed_at,row.provider_retry_started_at),
      apnsRequestToAcceptance: elapsed(row.provider_retry_started_at,row.accepted_at),
      commitToAcceptance: elapsed(row.event_created_at,row.accepted_at),
      acceptanceToDeviceReceipt: elapsed(row.accepted_at,row.received_at),
    },
    errorCode: safeDiagnosticCode(row.last_error_code),
    createdAt: row.created_at,updatedAt: row.updated_at,
  };
}

function shortHash(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
    ? `sha256:${value.slice(0,12)}`
    : null;
}

export function apnsTransportTruth(mode: ApnsMode) {
  return mode === "disabled" ? {
    mode,
    remoteEnqueueEnabled: false,
    providerCredentialActive: false,
    deliverySemantics: "durable_inbox_refresh_only",
  } : {
    mode,
    remoteEnqueueEnabled: true,
    providerCredentialActive: null,
    deliverySemantics: "worker_direct_apns",
  };
}

function elapsed(from: unknown,to: unknown): number | null {
  if (!from || !to) return null;
  const start = new Date(from as string | number | Date).getTime();
  const end = new Date(to as string | number | Date).getTime();
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end-start : null;
}

function attemptResource(row: any,deliveryId: string) {
  return {
    id: `att_${row.id}`,deliveryId,jobAttempt: Number(row.job_attempt),
    providerAttempts: Number(row.provider_attempts),
    outcome: safeDiagnosticCode(row.outcome_category) ?? "unknown",
    providerStatus: row.provider_status === null ? null : Number(row.provider_status),
    providerReason: safeDiagnosticCode(row.provider_reason),
    providerMessageId: safeDiagnosticCode(row.provider_message_id),
    transportCode: safeDiagnosticCode(row.transport_code),
    tokenInvalidatedAt: row.invalidated_at ?? null,
    providerFirstAttemptAt: row.provider_first_attempt_at ?? null,
    recordedAt: row.created_at,
  };
}

function externalDeliveryStatus(row: any): typeof deliveryStatuses[number] {
  if (row.provider_outcome_category === "invalid-recipient") return "token_invalid";
  return ({
    pending: "queued",processing: "sending",accepted: "accepted_by_apns",retry: "retryable",
    permanently_failed: "rejected",reconciliation_required: "reconciliation_required",canceled: "canceled",
    token_invalid: "token_invalid",
  } as const)[row.state as string] ?? "rejected";
}

function statusSql(status: typeof deliveryStatuses[number]): string {
  if (status === "token_invalid") {
    return "(j.state='token_invalid' OR j.provider_outcome_category='invalid-recipient')";
  }
  const state = ({
    queued: "pending",sending: "processing",accepted_by_apns: "accepted",retryable: "retry",
    rejected: "permanently_failed",reconciliation_required: "reconciliation_required",canceled: "canceled",
  } as const)[status as Exclude<typeof status,"token_invalid">];
  return `j.state='${state}'`;
}

function parseLimit(params: URLSearchParams,defaultLimit: number): { ok: true; limit: number } | { ok: false } {
  const values = params.getAll("limit");
  const raw = values[0];
  const limit = raw === undefined ? defaultLimit : Number(raw);
  return values.length <= 1 && Number.isInteger(limit) && limit >= 1 && limit <= 100
    && (raw === undefined || /^\d+$/.test(raw)) ? { ok: true,limit } : { ok: false };
}

function parseDeliveryFilters(params: URLSearchParams): {
  ok: true;
  notificationId: string | null;
  notificationInternalId: string | null;
  deviceId: string | null;
  deviceInternalId: string | null;
  status: typeof deliveryStatuses[number] | null;
} | { ok: false } {
  const notificationValues = params.getAll("notificationId");
  const deviceValues = params.getAll("deviceId");
  const statusValues = params.getAll("status");
  if (notificationValues.length > 1 || deviceValues.length > 1 || statusValues.length > 1) return { ok: false };
  const notificationId = notificationValues[0] ?? null;
  const deviceId = deviceValues[0] ?? null;
  const status = statusValues[0] ?? null;
  const notificationInternalId = notificationId ? internalId("ntf",notificationId) : null;
  const deviceInternalId = deviceId ? internalId("dev",deviceId) : null;
  const parsedStatus = status ? deliveryStatusSchema.safeParse(status) : null;
  if ((notificationId && !notificationInternalId) || (deviceId && !deviceInternalId)
    || (parsedStatus && !parsedStatus.success)) return { ok: false };
  return {
    ok: true,notificationId,notificationInternalId: notificationInternalId ?? null,
    deviceId,deviceInternalId: deviceInternalId ?? null,
    status: parsedStatus?.success ? parsedStatus.data : null,
  };
}

function sameFilters(cursor: DeliveryCursor,filters: ReturnType<typeof parseDeliveryFilters> & { ok: true }): boolean {
  return cursor.notificationId === filters.notificationId
    && cursor.deviceId === filters.deviceId && cursor.status === filters.status;
}

function encodeDeliveryCursor(value: DeliveryCursor): string {
  return Buffer.from(JSON.stringify([
    "deliveries-v1",value.createdAt,value.id,value.notificationId,value.deviceId,value.status,
  ]),"utf8").toString("base64url");
}

function decodeDeliveryCursor(value: string | undefined): DeliveryCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = z.tuple([
      z.literal("deliveries-v1"),z.iso.datetime(),z.uuid(),
      z.string().nullable(),z.string().nullable(),deliveryStatusSchema.nullable(),
    ]).safeParse(JSON.parse(Buffer.from(value,"base64url").toString("utf8")));
    return parsed.success ? {
      createdAt: parsed.data[1],id: parsed.data[2],notificationId: parsed.data[3],
      deviceId: parsed.data[4],status: parsed.data[5],
    } : undefined;
  } catch { return undefined; }
}

function encodeAttemptCursor(value: AttemptCursor): string {
  return Buffer.from(JSON.stringify([
    "delivery-attempts-v1",value.createdAt,value.id,value.deliveryId,
  ]),"utf8").toString("base64url");
}

function decodeAttemptCursor(value: string | undefined): AttemptCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = z.tuple([
      z.literal("delivery-attempts-v1"),z.iso.datetime(),z.uuid(),z.string().regex(/^job_[A-Za-z0-9-]{36}$/),
    ]).safeParse(JSON.parse(Buffer.from(value,"base64url").toString("utf8")));
    return parsed.success ? { createdAt: parsed.data[1],id: parsed.data[2],deliveryId: parsed.data[3] } : undefined;
  } catch { return undefined; }
}
