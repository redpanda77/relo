import type { Database } from "./db.js";
import type { QuestionKind } from "./interactions/types.js";
import {
  assertApnsPayloadWithinBudget,
} from "@relo/notification-contracts";
import {
  ApnsProviderCleanroom,
  type ActivitySend,
  type ApnsOutcome,
  type ApnsProviderConfig,
  type ApnsTransport,
  type BackgroundSend,
  type RecipientResolver,
} from "./apns-provider-cleanroom.js";
import {
  deliveryProjection,
} from "./delivery-serialization.js";

export { activityContentState } from "./delivery-serialization.js";

export type ApnsRuntimeJob = {
  id: string;
  claimToken: string;
  attemptCount: number;
  providerAttemptsUsed: number;
  providerRetryStartedAt: Date | null;
  providerRetryAttemptCap: number | null;
  providerRetryHorizonAt: Date | null;
  providerNextAttemptNotBefore: Date | null;
  providerStatus: number | null;
  transport: "notification" | "live_activity_start" | "live_activity_update";
  createdAt: Date;
  expiresAt: Date | null;
  title: string;
  body: string;
  sourceName: string;
  conversationId: string | null;
  collapseId?: string | null;
  avatarUrl: string | null;
  imageUrl: string | null;
  deepLink: string | null;
  notificationId: string;
  accountId: string;
  deviceId?: string;
  serverOriginHash?: string;
  interactionExpiresAt?: Date | null;
  interactionKind: QuestionKind | null;
  interactionId: string | null;
  badge: number;
  payload: Record<string, unknown>;
  activityCommand?: Record<string, unknown>;
  signal?: AbortSignal;
};

export type ApnsRuntimeResult =
  | { kind: "accepted"; providerMessageId?: string }
  | { kind: "retry"; code: string; message: string }
  | { kind: "retry_scheduled"; notBefore: Date; code: string; message: string }
  | { kind: "invalid_token"; code: string; message: string }
  | { kind: "unavailable"; code: string; message: string }
  | { kind: "reconcile"; code: string; message: string; providerMessageId?: string }
  | { kind: "rejected"; code: string; message: string };

export function apnsPriorityForJob(input: {
  transport: ApnsRuntimeJob["transport"];
  command?: Record<string,unknown>;
  requesterCredentialId: string | null;
  requesterServiceId: string | null;
}): 5 | 10 {
  return input.command?.quietRestart === true ? 5 : 10;
}

export class ApnsOutcomePersistenceError extends Error {
  constructor(readonly result: ApnsRuntimeResult) {
    super("APNs outcome could not be durably recorded");
    this.name = "ApnsOutcomePersistenceError";
  }
}

export class CleanroomApnsRuntime {
  private readonly provider: ApnsProviderCleanroom;

  constructor(
    private readonly db: Database,
    config: ApnsProviderConfig,
    transport: ApnsTransport,
  ) {
    this.provider = new ApnsProviderCleanroom(config, transport);
  }

  async send(job: ApnsRuntimeJob, recipient: RecipientResolver): Promise<ApnsRuntimeResult> {
    const expiration = job.expiresAt ? Math.floor(job.expiresAt.getTime() / 1_000) : 0;
    const common = {
      recipient,
      apnsId: job.id,
      expiration,
      providerAttemptState: {
        attemptsUsed: job.providerAttemptsUsed,
        ...(job.providerRetryStartedAt
          ? { firstAttemptAtMs: job.providerRetryStartedAt.getTime() }
          : {}),
        ...(job.providerRetryAttemptCap == null ? {} : { attemptCap: job.providerRetryAttemptCap }),
        ...(job.providerRetryHorizonAt == null
          ? {} : { retryHorizonAtMs: job.providerRetryHorizonAt.getTime() }),
        ...(job.providerNextAttemptNotBefore == null
          ? {} : { nextAttemptNotBeforeMs: job.providerNextAttemptNotBefore.getTime() }),
      },
      persistProviderRetryState: async (proposed: {
        attemptsUsed: number;
        firstAttemptAtMs: number;
        attemptCap: number;
        retryHorizonAtMs: number;
        nextAttemptNotBeforeMs: number;
      }) => await persistProviderRetryState(this.db,job,proposed),
      ...(job.expiresAt ? { validUntilMs: job.expiresAt.getTime() } : {}),
      confirmPayloadSha256: async (sha256: string) => await confirmPayload(
        this.db,job.id,job.claimToken,sha256,
      ),
      ...(job.signal ? { signal: job.signal } : {}),
    };
    const projection = deliveryProjection(job);
    let outcome: ApnsOutcome;
    if (projection.kind === "alert") {
      const { kind: _kind, ...input } = projection;
      outcome = await this.provider.sendAlert({ ...common, ...input });
    } else if (projection.kind === "activity") {
      const { kind: _kind, ...input } = projection;
      assertApnsPayloadWithinBudget({
        aps: { timestamp: input.providerTimestamp, event: input.operation, "content-state": input.contentState },
      });
      outcome = await this.provider.sendActivity({ ...common, ...input });
    } else {
      outcome = {
        accepted: false,
        category: "validation",
        attempt: 0,
        apnsId: job.id,
        payloadBytes: 0,
      };
    }
    const result = mapApnsOutcomeToRuntimeResult(outcome);
    try {
      await recordOutcome(this.db,job,outcome);
    } catch {
      throw new ApnsOutcomePersistenceError(result);
    }
    return result;
  }

  /** A silent push on the same provider pool (notifications/settle-pushes.ts owns its ledger). */
  async sendBackground(input: BackgroundSend): Promise<ApnsOutcome> {
    return await this.provider.sendBackground(input);
  }

  /** The wizard's Live Activity push (computer-invite-activity.ts owns its ledger); the activity's own token is the recipient. */
  async sendInviteActivity(input: ActivitySend): Promise<ApnsOutcome> {
    return await this.provider.sendActivity(input);
  }

  async close(): Promise<void> {
    await this.provider.close();
  }

  async warm(signal?: AbortSignal): Promise<void> {
    await this.provider.warm(signal);
  }

}

async function confirmPayload(
  db: Database,
  jobId: string,
  claimToken: string,
  sha256: string,
): Promise<boolean> {
  const stored = await db.query<{ apns_payload_sha256: string }>(
    `UPDATE delivery_jobs SET apns_payload_sha256=$2
     WHERE id=$1 AND state='processing' AND claim_token=$3
       AND claim_phase='dispatch_started' AND apns_payload_sha256 IS NULL
     RETURNING apns_payload_sha256`,
    [jobId,sha256,claimToken],
  );
  if (stored.rowCount) return stored.rows[0]!.apns_payload_sha256 === sha256;
  const current = await db.query<{ apns_payload_sha256: string | null }>(
    `SELECT apns_payload_sha256 FROM delivery_jobs
     WHERE id=$1 AND state='processing' AND claim_token=$2 AND claim_phase='dispatch_started'`,
    [jobId,claimToken],
  );
  return current.rows[0]?.apns_payload_sha256 === sha256;
}

async function persistProviderRetryState(
  db: Database,
  job: Pick<ApnsRuntimeJob,"id" | "claimToken">,
  proposed: {
    attemptsUsed: number;
    firstAttemptAtMs: number;
    attemptCap: number;
    retryHorizonAtMs: number;
    nextAttemptNotBeforeMs: number;
  },
): Promise<{ attemptCap: number; retryHorizonAtMs: number; nextAttemptNotBeforeMs: number }> {
  const row = await db.query<{
    provider_retry_attempt_cap: number;
    provider_retry_horizon_at: Date;
    provider_next_attempt_not_before: Date;
  }>(
    `UPDATE delivery_jobs SET
       provider_attempts_used=GREATEST(provider_attempts_used,$3),
       provider_retry_started_at=CASE WHEN provider_retry_started_at IS NULL THEN $4
         ELSE LEAST(provider_retry_started_at,$4) END,
       provider_retry_attempt_cap=CASE WHEN provider_retry_attempt_cap IS NULL THEN $5
         ELSE LEAST(provider_retry_attempt_cap,$5) END,
       provider_retry_horizon_at=CASE WHEN provider_retry_horizon_at IS NULL THEN $6
         ELSE LEAST(provider_retry_horizon_at,$6) END,
       provider_next_attempt_not_before=CASE WHEN provider_next_attempt_not_before IS NULL THEN $7
         ELSE GREATEST(provider_next_attempt_not_before,$7) END,
       updated_at=now()
     WHERE id=$1 AND state='processing' AND claim_token=$2 AND claim_phase='dispatch_started'
     RETURNING provider_retry_attempt_cap,provider_retry_horizon_at,provider_next_attempt_not_before`,
    [
      job.id,job.claimToken,proposed.attemptsUsed,
      new Date(proposed.firstAttemptAtMs),proposed.attemptCap,new Date(proposed.retryHorizonAtMs),
      new Date(proposed.nextAttemptNotBeforeMs),
    ],
  );
  if (row.rowCount !== 1) throw new Error("delivery claim ownership lost");
  const persisted = row.rows[0]!;
  return {
    attemptCap: Number(persisted.provider_retry_attempt_cap),
    retryHorizonAtMs: persisted.provider_retry_horizon_at.getTime(),
    nextAttemptNotBeforeMs: persisted.provider_next_attempt_not_before.getTime(),
  };
}

async function recordOutcome(db: Database, job: ApnsRuntimeJob, outcome: ApnsOutcome): Promise<void> {
  const invalidatedDate = outcome.invalidatedAtMs === undefined ? undefined : new Date(outcome.invalidatedAtMs);
  const invalidatedAt = invalidatedDate && Number.isFinite(invalidatedDate.getTime()) ? invalidatedDate : null;
  const firstAttemptDate = outcome.firstAttemptAtMs === undefined ? undefined : new Date(outcome.firstAttemptAtMs);
  const firstAttemptAt = firstAttemptDate && Number.isFinite(firstAttemptDate.getTime())
    ? firstAttemptDate
    : null;
  if (outcome.attempt > 0 && firstAttemptAt === null) {
    throw new Error("provider attempt outcome is missing its first-attempt epoch");
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO delivery_attempts(
         delivery_job_id,claim_token,job_attempt,provider_attempts,outcome_category,provider_status,
         provider_reason,provider_message_id,transport_code,invalidated_at,provider_first_attempt_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        job.id,job.claimToken,job.attemptCount,outcome.attempt,outcome.category,
        outcome.status ?? null,outcome.reason ?? null,outcome.responseApnsId ?? null,
        outcome.transportCode ?? null,invalidatedAt,firstAttemptAt,
      ],
    );
    const updated = await client.query(
      `UPDATE delivery_jobs SET provider_outcome_category=$3,provider_status=$4,
         provider_transport_code=$5,
         last_provider_attempt_at=CASE WHEN $6>0 THEN now() ELSE last_provider_attempt_at END,
         provider_attempts_used=GREATEST(provider_attempts_used,$8+$6),
         provider_retry_started_at=CASE WHEN $6>0 THEN COALESCE(provider_retry_started_at,$7)
           ELSE provider_retry_started_at END
       WHERE id=$1 AND state='processing' AND claim_token=$2 AND claim_phase='dispatch_started'`,
      [
        job.id,job.claimToken,outcome.category,outcome.status ?? null,
        outcome.transportCode ?? null,outcome.attempt,firstAttemptAt,job.providerAttemptsUsed,
      ],
    );
    if (updated.rowCount !== 1) throw new Error("delivery claim ownership lost");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function mapApnsOutcomeToRuntimeResult(outcome: ApnsOutcome): ApnsRuntimeResult {
  if (outcome.category === "accepted") {
    return outcome.responseApnsId
      ? { kind: "accepted", providerMessageId: outcome.responseApnsId }
      : { kind: "accepted" };
  }
  const message = outcome.reason ? `${outcome.category}: ${outcome.reason}` : outcome.category;
  if (outcome.category === "retry-scheduled" && Number.isSafeInteger(outcome.nextAttemptNotBeforeMs)) {
    return { kind: "retry_scheduled", notBefore: new Date(outcome.nextAttemptNotBeforeMs!), code: outcome.category, message };
  }
  if (outcome.category === "invalid-recipient") {
    return { kind: "invalid_token", code: outcome.reason ?? "invalid-recipient", message };
  }
  if (outcome.category === "stale-recipient") {
    return { kind: "unavailable", code: "recipient-unavailable", message };
  }
  if (outcome.category === "indeterminate-transport") {
    return {
      kind: "reconcile",code: outcome.transportCode ?? outcome.category,message,
      ...(outcome.responseApnsId ? { providerMessageId: outcome.responseApnsId } : {}),
    };
  }
  if (outcome.category === "retryable-not-scheduled" || outcome.category === "retry-exhausted") {
    return { kind: "rejected",code: outcome.category,message };
  }
  return { kind: "rejected", code: outcome.category, message };
}
