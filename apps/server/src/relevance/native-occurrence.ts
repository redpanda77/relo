import { RELEVANCE_DEFAULTS } from "@relo/notification-contracts";
import type { SubjectTransaction } from "./commands.js";

export class NativeOccurrenceError extends Error {
  constructor(readonly code: "invalid_occurrence" | "stale_occurrence" | "occurrence_conflict") { super(code); }
}
export type NativeMutationFreshness = {
  id: string; occurred_at: Date | null; accepted_at: Date; deliver_until: Date;
  operation: "start" | "update" | "end";
};

/** The caller holds the activity row and owns the transaction. This evidence is
 * independent of prunable notification history. Unknown producer time stays null.
 * Terminal cleanup starts at server settlement; it is not a new producer alert. */
export async function recordNativeMutation(tx: SubjectTransaction, input: {
  activityId: string; sequence: number; operation: NativeMutationFreshness["operation"];
  occurredAt?: string | undefined;
  mutationTime: Date | string;
}): Promise<NativeMutationFreshness> {
  const prior = (await tx.query<NativeMutationFreshness>(
    "SELECT * FROM activity_mutation_freshness WHERE activity_id=$1 AND sequence=$2",
    [input.activityId,input.sequence])).rows[0];
  if (prior) {
    if (prior.operation !== input.operation || (input.occurredAt !== undefined
      && prior.occurred_at?.getTime() !== Date.parse(input.occurredAt))) throw new NativeOccurrenceError("occurrence_conflict");
    return prior;
  }
  const now = (await tx.query<{ at: Date }>("SELECT clock_timestamp() AS at")).rows[0]!.at;
  const acceptedAt = new Date(input.mutationTime);
  if (!Number.isFinite(acceptedAt.getTime()) || acceptedAt.getTime() > now.getTime()+RELEVANCE_DEFAULTS.producerClockToleranceMilliseconds) throw new NativeOccurrenceError("invalid_occurrence");
  const occurredAt = input.occurredAt === undefined ? null : new Date(input.occurredAt);
  if (occurredAt && (!Number.isFinite(occurredAt.getTime())
    || occurredAt.getTime() > now.getTime()+RELEVANCE_DEFAULTS.producerClockToleranceMilliseconds)) {
    throw new NativeOccurrenceError("invalid_occurrence");
  }
  if (occurredAt) {
    const latest = (await tx.query<{ occurred_at: Date | null }>(
      "SELECT COALESCE(occurred_at,accepted_at) AS occurred_at FROM activity_mutation_freshness WHERE activity_id=$1 AND sequence<$2 ORDER BY sequence DESC LIMIT 1",
      [input.activityId,input.sequence])).rows[0];
    if (latest?.occurred_at && occurredAt < latest.occurred_at) throw new NativeOccurrenceError("stale_occurrence");
  }
  const base = input.operation === "end" ? acceptedAt.getTime()
    : Math.min(occurredAt?.getTime() ?? acceptedAt.getTime(),acceptedAt.getTime());
  const seconds = input.operation === "end" ? RELEVANCE_DEFAULTS.terminalCleanupSeconds : RELEVANCE_DEFAULTS.progressDeliverySeconds;
  return (await tx.query<NativeMutationFreshness>(
    `INSERT INTO activity_mutation_freshness(activity_id,sequence,operation,occurred_at,accepted_at,deliver_until)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [input.activityId,input.sequence,input.operation,occurredAt,acceptedAt,new Date(base+seconds*1000)])).rows[0]!;
}

/** Caller holds the origin slot. An unseen delayed run cannot replace a newer run. */
export async function assertNativeStartChronology(tx: SubjectTransaction, latest: { id: string; created_at: Date }, occurredAt: string | undefined) {
  if (occurredAt === undefined) return;
  const start = (await tx.query<{ at: Date }>(
    "SELECT COALESCE(occurred_at,accepted_at) AS at FROM activity_mutation_freshness WHERE activity_id=$1 ORDER BY sequence LIMIT 1",
    [latest.id])).rows[0]?.at ?? new Date(latest.created_at);
  if (Date.parse(occurredAt) < start.getTime()) throw new NativeOccurrenceError("stale_occurrence");
}
