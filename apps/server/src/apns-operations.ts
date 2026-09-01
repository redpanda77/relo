import type { Database } from "./db.js";
import { safeDiagnosticCode } from "./apns-observability.js";
import { quarantineAbandonedProcessingClaims } from "./apns-worker-state.js";

type OperationDatabase = Pick<Database,"connect" | "query">;

export type ApnsBacklogReport = {
  cutoverAt: string | null;
  jobs: Array<{
    transport: string;
    state: string;
    errorCode: string | null;
    count: number;
    beforeCutover: number;
  }>;
  attempts: Array<{ outcome: string; count: number }>;
};

export type ApnsQuarantineResult = {
  operation: "cutover_quarantine" | "rollback_quarantine";
  cutoverAt: string;
  configurationGeneration: string;
  alreadyApplied: boolean;
  counts: Record<string,number>;
};

type AuditRow = {
  operation: "cutover_quarantine" | "rollback_quarantine";
  cutover_at: Date;
  configuration_generation: string;
  counts: Record<string,number>;
};

export class ApnsOperationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ApnsOperationError";
  }
}

export async function recountApnsBacklog(
  db: Pick<Database,"query">,
  cutoverAt?: Date,
): Promise<ApnsBacklogReport> {
  const [jobs,attempts] = await Promise.all([
    db.query<{
      transport: string; state: string; error_code: string | null;
      count: number; before_cutover: number;
    }>(
      `SELECT j.transport,j.state,j.last_error_code AS error_code,count(*)::int AS count,
         count(*) FILTER (WHERE $1::timestamptz IS NOT NULL AND e.created_at<$1)::int AS before_cutover
       FROM delivery_jobs j JOIN notification_events e ON e.id=j.notification_event_id
       GROUP BY j.transport,j.state,j.last_error_code
       ORDER BY j.transport,j.state,j.last_error_code NULLS FIRST`,
      [cutoverAt ?? null],
    ),
    db.query<{ outcome_category: string; count: number }>(
      `SELECT outcome_category,count(*)::int AS count FROM delivery_attempts
       GROUP BY outcome_category ORDER BY outcome_category`,
    ),
  ]);
  return {
    cutoverAt: cutoverAt?.toISOString() ?? null,
    jobs: jobs.rows.map((row) => ({
      transport: safeDiagnosticCode(row.transport) ?? "unknown",
      state: safeDiagnosticCode(row.state) ?? "unknown",
      errorCode: safeDiagnosticCode(row.error_code),
      count: Number(row.count),beforeCutover: Number(row.before_cutover),
    })),
    attempts: attempts.rows.map((row) => ({
      outcome: safeDiagnosticCode(row.outcome_category) ?? "unknown",count: Number(row.count),
    })),
  };
}

export async function quarantineApnsBacklogForCutover(
  db: OperationDatabase,
  cutoverAt: Date,
  configurationGeneration: string,
): Promise<ApnsQuarantineResult> {
  assertCutoverIdentity(cutoverAt,configurationGeneration);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await operationLock(client);
    const latest = await latestAudit(client);
    if (latest?.operation === "cutover_quarantine") {
      if (!sameCutover(latest,cutoverAt,configurationGeneration)) {
        throw new ApnsOperationError("cutover_identity_mismatch");
      }
      await client.query("COMMIT");
      return resultFromAudit(latest,true);
    }
    const swept = await quarantineAbandonedProcessingClaims(client as never);
    const processing = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM delivery_jobs WHERE state='processing'",
    );
    if (Number(processing.rows[0]?.count ?? 0) !== 0) {
      throw new ApnsOperationError("worker_must_be_stopped");
    }
    const quarantined = await client.query(
      `UPDATE delivery_jobs j SET state='canceled',lease_expires_at=NULL,
         last_error_code='pre_apns_cutover',last_error_message='Quarantined before APNs enablement',
         updated_at=now()
       FROM notification_events e WHERE e.id=j.notification_event_id AND e.created_at<$1
         AND j.state IN ('pending','retry')`,
      [cutoverAt],
    );
    const counts = {
      quarantined: quarantined.rowCount ?? 0,
      safelyRequeued: swept.safelyRequeued,
      reconciliationRequired: swept.reconciliationRequired,
    };
    await insertAudit(client,"cutover_quarantine",cutoverAt,configurationGeneration,counts);
    await client.query("COMMIT");
    return {
      operation: "cutover_quarantine",cutoverAt: cutoverAt.toISOString(),
      configurationGeneration,alreadyApplied: false,counts,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function quarantineApnsBacklogForRollback(
  db: OperationDatabase,
  cutoverAt: Date,
  configurationGeneration: string,
): Promise<ApnsQuarantineResult> {
  assertCutoverIdentity(cutoverAt,configurationGeneration);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await operationLock(client);
    const latest = await latestAudit(client);
    if (!latest || !sameCutover(latest,cutoverAt,configurationGeneration)) {
      throw new ApnsOperationError("cutover_identity_mismatch");
    }
    if (latest.operation === "rollback_quarantine") {
      await client.query("COMMIT");
      return resultFromAudit(latest,true);
    }
    const queued = await client.query(
      `UPDATE delivery_jobs j SET state='canceled',lease_expires_at=NULL,
         last_error_code='apns_rollback_quarantine',
         last_error_message='Quarantined during APNs rollback',updated_at=now()
       FROM notification_events e WHERE e.id=j.notification_event_id AND e.created_at>=$1
         AND j.state IN ('pending','retry')`,
      [cutoverAt],
    );
    const preparing = await client.query(
      `UPDATE delivery_jobs SET state='canceled',claim_token=NULL,claim_started_at=NULL,
         claim_phase=NULL,lease_expires_at=NULL,last_error_code='apns_rollback_pre_dispatch',
         last_error_message='Rollback canceled a claim before the durable dispatch fence',updated_at=now()
       WHERE state='processing' AND claim_phase='preparing'`,
    );
    const uncertain = await client.query(
      `UPDATE delivery_jobs SET state='reconciliation_required',claim_token=NULL,claim_started_at=NULL,
         claim_phase=NULL,lease_expires_at=NULL,last_error_code='apns_rollback_dispatch_uncertain',
         last_error_message='Rollback found a claim at or after the durable dispatch fence',updated_at=now()
       WHERE state='processing' AND claim_phase IS DISTINCT FROM 'preparing'`,
    );
    const counts = {
      quarantined: queued.rowCount ?? 0,
      preDispatchCanceled: preparing.rowCount ?? 0,
      reconciliationRequired: uncertain.rowCount ?? 0,
    };
    await insertAudit(client,"rollback_quarantine",cutoverAt,configurationGeneration,counts);
    await client.query("COMMIT");
    return {
      operation: "rollback_quarantine",cutoverAt: cutoverAt.toISOString(),
      configurationGeneration,alreadyApplied: false,counts,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function assertPreparedApnsCutover(
  db: Pick<Database,"query">,
  cutoverAt: Date,
  configurationGeneration: string,
): Promise<void> {
  assertCutoverIdentity(cutoverAt,configurationGeneration);
  const latest = await latestAudit(db);
  if (!latest || latest.operation !== "cutover_quarantine"
    || !sameCutover(latest,cutoverAt,configurationGeneration)) {
    throw new ApnsOperationError("cutover_not_prepared");
  }
}

function assertCutoverIdentity(cutoverAt: Date, configurationGeneration: string): void {
  if (!Number.isFinite(cutoverAt.getTime())) throw new ApnsOperationError("invalid_cutover_at");
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(configurationGeneration)) {
    throw new ApnsOperationError("invalid_configuration_generation");
  }
}

function sameCutover(row: AuditRow, cutoverAt: Date, generation: string): boolean {
  return new Date(row.cutover_at).getTime() === cutoverAt.getTime()
    && row.configuration_generation === generation;
}

function resultFromAudit(row: AuditRow, alreadyApplied: boolean): ApnsQuarantineResult {
  return {
    operation: row.operation,cutoverAt: new Date(row.cutover_at).toISOString(),
    configurationGeneration: row.configuration_generation,alreadyApplied,
    counts: Object.fromEntries(Object.entries(row.counts).map(([key,value]) => [key,Number(value)])),
  };
}

async function operationLock(query: Pick<Database,"query">): Promise<void> {
  await query.query("SELECT pg_advisory_xact_lock(hashtext('relo:apns:operations:v1'))");
}

async function latestAudit(query: Pick<Database,"query">): Promise<AuditRow | undefined> {
  return (await query.query<AuditRow>(
    `SELECT operation,cutover_at,configuration_generation,counts
     FROM apns_operation_audit ORDER BY created_at DESC,id DESC LIMIT 1`,
  )).rows[0];
}

async function insertAudit(
  query: Pick<Database,"query">,
  operation: AuditRow["operation"],
  cutoverAt: Date,
  generation: string,
  counts: Record<string,number>,
): Promise<void> {
  await query.query(
    `INSERT INTO apns_operation_audit(
       operation,apns_mode,cutover_at,configuration_generation,counts
     ) VALUES ($1,'disabled',$2,$3,$4::jsonb)`,
    [operation,cutoverAt,generation,JSON.stringify(counts)],
  );
}
