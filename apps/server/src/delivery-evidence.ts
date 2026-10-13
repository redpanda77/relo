import {
  DELIVERY_EVIDENCE_STAGE_ORDER,DELIVERY_EVIDENCE_VERSION,
  type DeliveryEvidenceItem,type DeliveryEvidenceMetrics,type DeliveryEvidenceResponse,
  type DeliveryEvidenceStage,
} from "@relo/notification-contracts";
import { z } from "zod";
import { safeDiagnosticCode } from "./apns-observability.js";
import type { Database } from "./db.js";
import { internalId,publicId } from "./ids.js";
import { decodeCursor,encodeCursor } from "./cursor.js";

type EvidenceCursor = {
  occurredAt: string;
  stageOrder: number;
  sortKey: string;
  notificationId: string | null;
};

export class DeliveryEvidenceError extends Error {
  constructor(readonly code: "invalid_filter" | "cursor_expired",readonly status: 400 | 410) {
    super(code);
  }
}

export async function loadDeliveryEvidence(
  db: Database,
  principalId: string,
  input: {
    notificationId?: string | null;
    deviceId?: string | null;
    cursor?: string | null;
    limit?: number;
  } = {},
): Promise<DeliveryEvidenceResponse> {
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new DeliveryEvidenceError("invalid_filter",400);
  }
  const notificationId = input.notificationId ?? null;
  const notificationInternalId = notificationId ? internalId("ntf",notificationId) : null;
  if (notificationId && !notificationInternalId) throw new DeliveryEvidenceError("invalid_filter",400);
  const cursor = decodeEvidenceCursor(input.cursor ?? undefined);
  if (input.cursor && (!cursor || cursor.notificationId !== notificationId)) {
    throw new DeliveryEvidenceError("cursor_expired",410);
  }
  const rows = await db.query<any>(evidenceSql(limit + 1),[
    principalId,notificationInternalId,cursor?.occurredAt ?? null,cursor?.stageOrder ?? null,
    cursor?.sortKey ?? null,input.deviceId ?? null,
  ]);
  const metadata = rows.rows[0] as { cursor_valid: boolean; sort_key: string | null } | undefined;
  if (!metadata?.cursor_valid) throw new DeliveryEvidenceError("cursor_expired",410);
  const pageRows = rows.rows.filter((row: any) => row.sort_key !== null);
  const hasMore = pageRows.length > limit;
  const page = pageRows.slice(0,limit);
  const last = page.at(-1);
  return {
    version: DELIVERY_EVIDENCE_VERSION,
    order: "newest_first",
    items: page.map(evidenceItem),
    cursor: hasMore && last ? encodeEvidenceCursor({
      occurredAt: String(last.cursor_occurred_at),
      stageOrder: Number(last.stage_order),
      sortKey: String(last.sort_key),
      notificationId,
    }) : null,
    hasMore,
  };
}

export async function loadDeliveryEvidenceMetrics(
  db: Database,principalId: string,
): Promise<DeliveryEvidenceMetrics> {
  const result = await db.query<any>(
    `SELECT now() AS generated_at,
       count(*) FILTER (WHERE j.state IN ('pending','retry'))::int AS pending_jobs,
       round(max(EXTRACT(EPOCH FROM (now()-j.created_at))*1000)
         FILTER (WHERE j.state IN ('pending','retry')))::bigint AS oldest_age_ms,
       round(max(EXTRACT(EPOCH FROM (now()-j.available_at))*1000)
         FILTER (WHERE j.state IN ('pending','retry') AND j.available_at<now()))::bigint AS worker_lag_ms,
       COALESCE((SELECT count(*) FILTER (WHERE a.provider_attempts>1)::double precision
         / NULLIF(count(*),0) FROM delivery_attempts a
         JOIN delivery_jobs owned_job ON owned_job.id=a.delivery_job_id
         JOIN notification_events owned_event ON owned_event.id=owned_job.notification_event_id
         WHERE owned_event.principal_id=$1 AND a.created_at>=now()-interval '1 hour'),0) AS retry_rate_1h,
       (SELECT count(*)::int FROM delivery_jobs ambiguous
         JOIN notification_events ambiguous_event ON ambiguous_event.id=ambiguous.notification_event_id
         WHERE ambiguous_event.principal_id=$1 AND ambiguous.state='reconciliation_required'
           AND ambiguous.updated_at>=now()-interval '1 hour') AS ambiguous_outcomes_1h,
       (SELECT count(*)::int FROM delivery_attempts invalidated
         JOIN delivery_jobs invalidated_job ON invalidated_job.id=invalidated.delivery_job_id
         JOIN notification_events invalidated_event ON invalidated_event.id=invalidated_job.notification_event_id
         WHERE invalidated_event.principal_id=$1 AND invalidated.invalidated_at>=now()-interval '24 hours')
         AS invalidated_tokens_24h,
       (SELECT round(percentile_cont(0.95) WITHIN GROUP (
           ORDER BY EXTRACT(EPOCH FROM (receipt.received_at-receipt_job.accepted_at))*1000))::bigint
         FROM delivery_jobs receipt_job
         JOIN notification_events receipt_event ON receipt_event.id=receipt_job.notification_event_id
         JOIN LATERAL (SELECT min(i.created_at) AS received_at FROM interactions i
           WHERE i.principal_id=receipt_event.principal_id
             AND i.notification_event_id=receipt_event.id AND i.device_id=receipt_job.device_id
             AND i.kind='received') receipt ON receipt.received_at IS NOT NULL
         WHERE receipt_event.principal_id=$1 AND receipt_job.accepted_at IS NOT NULL
           AND receipt.received_at>=receipt_job.accepted_at
           AND receipt.received_at>=now()-interval '24 hours') AS receipt_latency_p95_ms
     FROM delivery_jobs j JOIN notification_events e ON e.id=j.notification_event_id
     WHERE e.principal_id=$1`,
    [principalId],
  );
  const row = result.rows[0] ?? {};
  return {
    version: DELIVERY_EVIDENCE_VERSION,
    generatedAt: iso(row.generated_at),
    queue: {
      pendingJobs: number(row.pending_jobs),
      oldestAgeMs: nullableNumber(row.oldest_age_ms),
    },
    worker: { lagMs: nullableNumber(row.worker_lag_ms) },
    delivery: {
      retryRate1h: Math.min(1,Math.max(0,Number(row.retry_rate_1h ?? 0))),
      ambiguousOutcomes1h: number(row.ambiguous_outcomes_1h),
      invalidatedTokens24h: number(row.invalidated_tokens_24h),
      receiptLatencyP95Ms24h: nullableNumber(row.receipt_latency_p95_ms),
    },
  };
}

function evidenceItem(row: any): DeliveryEvidenceItem {
  const stage = row.stage as DeliveryEvidenceStage;
  return {
    id: `evd_${stage}_${String(row.source_id)}`,
    notificationId: publicId("ntf",String(row.notification_event_id)),
    deliveryId: row.delivery_job_id ? publicId("job",String(row.delivery_job_id)) : null,
    attemptId: row.delivery_attempt_id ? `att_${String(row.delivery_attempt_id)}` : null,
    deviceId: row.device_id ? publicId("dev",String(row.device_id)) : null,
    activityId: row.live_activity_id ? publicId("act",String(row.live_activity_id)) : null,
    stage,
    stageOrder: DELIVERY_EVIDENCE_STAGE_ORDER[stage],
    state: row.evidence_state,
    detailCode: safeDiagnosticCode(row.detail_code),
    serialization: row.canonical_intent_sha256 === null
      && row.device_projection_sha256 === null
      && row.apns_payload_sha256 === null ? null : {
      canonicalIntent: shortHash(row.canonical_intent_sha256),
      deviceProjection: shortHash(row.device_projection_sha256),
      providerBytes: shortHash(row.apns_payload_sha256),
    },
    occurredAt: iso(row.occurred_at),
  };
}

function evidenceSql(limit: number): string {
  return `WITH owned_events AS MATERIALIZED (
      SELECT e.id,e.created_at,e.payload FROM notification_events e
      WHERE e.principal_id=$1 AND ($2::uuid IS NULL OR e.id=$2::uuid)
    ), owned_jobs AS MATERIALIZED (
      SELECT j.* FROM delivery_jobs j JOIN owned_events e ON e.id=j.notification_event_id
      WHERE ($6::uuid IS NULL OR j.device_id=$6::uuid)
    ), evidence AS MATERIALIZED (
      SELECT 'event-accepted-'||e.id AS sort_key,e.id::text AS source_id,e.id AS notification_event_id,
        NULL::uuid AS delivery_job_id,NULL::uuid AS delivery_attempt_id,NULL::uuid AS device_id,
        NULL::uuid AS live_activity_id,'accepted'::text AS stage,10 AS stage_order,
        'recorded'::text AS evidence_state,NULL::text AS detail_code,
        NULL::text AS canonical_intent_sha256,NULL::text AS device_projection_sha256,
        NULL::text AS apns_payload_sha256,e.created_at AS occurred_at
      FROM owned_events e
      UNION ALL
      SELECT 'event-canonicalized-'||e.id,e.id::text,e.id,NULL,NULL,NULL,NULL,'canonicalized',20,
        'recorded',NULL,NULL,NULL,NULL,e.created_at FROM owned_events e
      UNION ALL
      SELECT 'job-queued-'||j.id,j.id::text,e.id,j.id,NULL,j.device_id,j.live_activity_id,'queued',30,
        'recorded',NULL,j.canonical_intent_sha256,j.device_projection_sha256,
        j.apns_payload_sha256,j.created_at
      FROM owned_jobs j JOIN owned_events e ON e.id=j.notification_event_id
      UNION ALL
      SELECT 'attempt-started-'||a.id,a.id::text,e.id,j.id,a.id,j.device_id,j.live_activity_id,'attempted',40,
        'recorded',NULL,j.canonical_intent_sha256,j.device_projection_sha256,
        j.apns_payload_sha256,COALESCE(a.provider_first_attempt_at,a.created_at)
      FROM delivery_attempts a JOIN owned_jobs j ON j.id=a.delivery_job_id
      JOIN owned_events e ON e.id=j.notification_event_id
      UNION ALL
      SELECT 'attempt-outcome-'||a.id,a.id::text,e.id,j.id,a.id,j.device_id,j.live_activity_id,
        CASE WHEN a.outcome_category='accepted' THEN 'provider_accepted'
          WHEN j.state='reconciliation_required' OR a.outcome_category LIKE 'ambiguous-%'
            THEN 'provider_ambiguous' ELSE 'provider_rejected' END,
        CASE WHEN a.outcome_category='accepted' THEN 50
          WHEN j.state='reconciliation_required' OR a.outcome_category LIKE 'ambiguous-%' THEN 70 ELSE 60 END,
        CASE WHEN a.outcome_category='accepted' THEN 'accepted'
          WHEN j.state='reconciliation_required' OR a.outcome_category LIKE 'ambiguous-%'
            THEN 'ambiguous' ELSE 'rejected' END,
        a.outcome_category,j.canonical_intent_sha256,j.device_projection_sha256,
        j.apns_payload_sha256,a.created_at
      FROM delivery_attempts a JOIN owned_jobs j ON j.id=a.delivery_job_id
      JOIN owned_events e ON e.id=j.notification_event_id
      UNION ALL
      SELECT 'interaction-applied-'||i.id,i.id::text,e.id,j.id,NULL,i.device_id,j.live_activity_id,
        'device_applied',80,'applied',NULL,j.canonical_intent_sha256,
        j.device_projection_sha256,j.apns_payload_sha256,i.created_at
      FROM interactions i
      JOIN owned_events e ON e.id=i.notification_event_id
      JOIN owned_jobs j ON j.notification_event_id=e.id AND j.device_id=i.device_id
        AND j.live_activity_id IS NOT NULL
      WHERE i.kind='received' AND ($6::uuid IS NULL OR i.device_id=$6::uuid)
      UNION ALL
      SELECT 'interaction-'||i.kind||'-'||i.id,i.id::text,e.id,NULL,NULL,i.device_id,NULL,
        CASE WHEN i.kind='received' THEN 'device_received' WHEN i.kind='opened' THEN 'opened'
          ELSE 'responded' END,
        CASE WHEN i.kind='received' THEN 90 WHEN i.kind='opened' THEN 100 ELSE 110 END,
        CASE WHEN i.kind='received' THEN 'received' WHEN i.kind='opened' THEN 'opened'
          ELSE 'responded' END,i.kind::text,NULL,NULL,NULL,i.created_at
      FROM interactions i JOIN owned_events e ON e.id=i.notification_event_id
      WHERE ($6::uuid IS NULL OR i.device_id=$6::uuid)
      UNION ALL
      SELECT 'withdrawal-'||w.id,w.id::text,e.id,w.delivery_job_id,NULL,w.device_id,NULL,'withdrawn',120,
        'withdrawn',COALESCE(w.detail_code,w.outcome),NULL,NULL,NULL,w.created_at
      FROM notification_withdrawal_evidence w JOIN owned_events e ON e.id=w.notification_event_id
      WHERE ($6::uuid IS NULL OR w.device_id IS NULL OR w.device_id=$6::uuid)
      UNION ALL
      SELECT 'reconciliation-'||r.id,r.id::text,e.id,j.id,NULL,j.device_id,j.live_activity_id,'reconciled',130,
        'reconciled',r.action,NULL,NULL,NULL,r.created_at
      FROM delivery_reconciliation_resolutions r JOIN owned_jobs j ON j.id=r.delivery_job_id
      JOIN owned_events e ON e.id=j.notification_event_id
    ), metadata AS (
      SELECT ($3::timestamptz IS NULL OR EXISTS (
        SELECT 1 FROM evidence anchor WHERE
          (anchor.occurred_at,anchor.stage_order,anchor.sort_key)=($3::timestamptz,$4::int,$5::text)
      )) AS cursor_valid
    ), page AS (
      SELECT evidence.*,to_char(evidence.occurred_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_occurred_at
      FROM evidence,metadata WHERE metadata.cursor_valid AND ($3::timestamptz IS NULL OR
        (evidence.occurred_at,evidence.stage_order,evidence.sort_key)<($3::timestamptz,$4::int,$5::text))
      ORDER BY evidence.occurred_at DESC,evidence.stage_order DESC,evidence.sort_key DESC LIMIT ${limit}
    )
    SELECT page.*,metadata.cursor_valid FROM metadata LEFT JOIN page ON metadata.cursor_valid
    ORDER BY page.occurred_at DESC,page.stage_order DESC,page.sort_key DESC`;
}

export function shortHash(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value)
    ? `sha256:${value.slice(0,12)}` : null;
}

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error("Delivery evidence timestamp is invalid");
  return date.toISOString();
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : 0;
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : number(value);
}

const evidenceCursorSchema = z.tuple([
  z.literal("delivery-evidence-v1"),z.iso.datetime(),z.number().int().positive(),
  z.string().min(1).max(200),z.string().nullable(),
]);

function encodeEvidenceCursor(value: EvidenceCursor): string {
  return encodeCursor(["delivery-evidence-v1",value.occurredAt,value.stageOrder,value.sortKey,value.notificationId]);
}

function decodeEvidenceCursor(value: string | undefined): EvidenceCursor | undefined {
  const parsed = decodeCursor(value,evidenceCursorSchema);
  return parsed && { occurredAt: parsed[1],stageOrder: parsed[2],sortKey: parsed[3],notificationId: parsed[4] };
}
