import { createHash } from "node:crypto";
import type { PoolClient,QueryResult,QueryResultRow } from "pg";
import {
  classifySubjectMutation, normalizeRelevancePolicy, relevanceItemSchema,
  subjectActorSchema, subjectVersionSchema,
  type RelevanceItem, type RelevancePolicy, type SubjectVersion,
} from "@relo/notification-contracts";
import { lockDecisionActivity } from "../decision-lock.js";
import { publicId } from "../ids.js";

export type ServerSubjectActor = { principalId: string; sourceId: string };
export type SubjectTransaction = {
  query: <T extends QueryResultRow = QueryResultRow>(text: string,values?: unknown[]) => Promise<QueryResult<T>>;
};

export type SubjectCommand = {
  subjectKey: string;
  generation: number;
  revision: number;
  operation: "update" | "replace";
  occurredAt: string;
  policy: RelevancePolicy;
  status?: "resolved" | undefined;
};
export class SubjectAdmissionError extends Error {
  constructor(readonly code: "not_found" | "stale" | "requires_replace" | "invalid_generation" | "version_conflict" | "retired_replay" | "invalid_relevance") {
    super(code);
  }
}
type SubjectRow = {
  id: string; generation: string; revision: string;
  intent_sha256: string; current_event_id: string; current_relevance: RelevanceItem;
};
/** Acquire before inserting an event: insertion binds shared source metadata.
 * Holding that metadata while waiting for an old activity would deadlock with
 * a response that owns the activity and is creating its terminal event. */
export async function lockSubjectAdmission(tx: SubjectTransaction,actor: ServerSubjectActor,subjectKey: string) {
  const lockKey = JSON.stringify([actor.principalId,actor.sourceId,subjectKey]);
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[lockKey]);
  const current = (await tx.query<SubjectRow>(
    `SELECT * FROM relevance_subjects WHERE principal_id=$1 AND source_id=$2 AND subject_key=$3 FOR UPDATE`,
    [actor.principalId,actor.sourceId,subjectKey],
  )).rows[0];
  if (current) {
    const events = await tx.query<{ notification_event_id: string }>(
      `SELECT notification_event_id FROM notification_relevance
       WHERE subject_id=$1 AND generation=$2 AND revision=$3 ORDER BY notification_event_id`,
      [current.id,current.generation,current.revision]);
    for (const row of events.rows) await lockDecisionActivity(tx,actor.principalId,row.notification_event_id);
  }
  return current;
}
export type SubjectAdmission =
  | { kind: "applied"; subjectId: string; relevance: RelevanceItem; supersededEventIds: string[] }
  | { kind: "duplicate"; subjectId: string; eventId: string; relevance: RelevanceItem };

/** The caller owns BEGIN/COMMIT and creates event + outbox in this transaction.
 * Scope comes from authentication, never from display labels or client actor claims.
 * Replacement locks subject -> activity -> request -> event -> job. A response/expiry
 * locks activity -> request, reads the head without locking it, then settles metadata.
 * Replacement must lock every prior request before changing the head, so that
 * request lock also serializes adjudication without a request->head deadlock. */
export async function applySubjectMutation(
  tx: SubjectTransaction, actor: ServerSubjectActor,
  input: { eventId: string; command: SubjectCommand; intentHash: string; actionDeadlineCap?: Date | string | undefined },
): Promise<SubjectAdmission> {
  const identityActor = subjectActorSchema.parse({ accountId:publicId("acc",actor.principalId),sourceId:actor.sourceId });
  const candidate = subjectVersionSchema.parse({ ...identityActor,
    subjectKey: input.command.subjectKey, generation: input.command.generation, revision: input.command.revision });
  if (!/^[a-f0-9]{64}$/.test(input.intentHash)) throw new Error("invalid_subject_intent_hash");
  const current = await lockSubjectAdmission(tx,actor,candidate.subjectKey);
  const prior = current ? relevanceItemSchema.parse(current.current_relevance) : null;
  const transition = classifySubjectMutation(identityActor,candidate,prior?.identity ?? null,input.command.operation);
  if (transition === "duplicate") {
    if (current!.intent_sha256 !== input.intentHash) throw new SubjectAdmissionError("version_conflict");
    const retained = await tx.query("SELECT id FROM notification_events WHERE id=$1 AND principal_id=$2",[current!.current_event_id,actor.principalId]);
    if (!retained.rowCount) throw new SubjectAdmissionError("retired_replay");
    return { kind:"duplicate",subjectId:current!.id,eventId:current!.current_event_id,relevance:prior! };
  }
  if (transition !== "advance") {
    if (transition === "unauthorized" || transition === "wrong_subject") throw new SubjectAdmissionError("not_found");
    throw new SubjectAdmissionError(transition);
  }
  if (prior && candidate.generation === prior.identity.generation
    && (prior.status === "resolved" || prior.deadlines.kind !== input.command.policy.kind)) {
    // This terminal fence lives in the retained head, independent of event history.
    throw new SubjectAdmissionError("requires_replace");
  }
  if (input.command.status !== undefined && input.command.policy.kind !== "incident") {
    throw new SubjectAdmissionError("invalid_relevance");
  }
  const event = await tx.query("SELECT id FROM notification_events WHERE id=$1 AND principal_id=$2",[input.eventId,actor.principalId]);
  if (!event.rowCount) throw new SubjectAdmissionError("not_found");
  const now = (await tx.query<{ accepted_at: Date }>("SELECT clock_timestamp() AS accepted_at")).rows[0]!.accepted_at.toISOString();
  let relevance: RelevanceItem;
  try {
    const deadlines = normalizeRelevancePolicy(input.command.policy,input.command.occurredAt,now);
    // Only server-owned context supplies this absolute ceiling. It may shorten
    // admission, never extend the original lifetime, and replay bypasses it.
    if (input.actionDeadlineCap !== undefined) {
      if (deadlines.kind !== "decision") throw new Error("decision_deadline_required");
      const cap = new Date(input.actionDeadlineCap).getTime();
      deadlines.actionExpiresAt = new Date(Math.min(cap,Date.parse(deadlines.actionExpiresAt!))).toISOString();
      deadlines.deliverUntil = new Date(Math.min(cap,Date.parse(deadlines.deliverUntil))).toISOString();
    }
    relevance = relevanceItemSchema.parse({
      identity:candidate,deadlines,
      status:input.command.status ?? "active",supersededAt:null,supersededBy:null,
    });
  } catch { throw new SubjectAdmissionError("invalid_relevance"); }
  const supersededEventIds: string[] = [];
  if (current && prior) {
    const previous = await tx.query<{ notification_event_id: string }>(
      `SELECT notification_event_id FROM notification_relevance
       WHERE subject_id=$1 AND generation=$2 AND revision=$3 ORDER BY notification_event_id`,
      [current.id,current.generation,current.revision],
    );
    supersededEventIds.push(...previous.rows.map(row=>row.notification_event_id));
    if (supersededEventIds.length) {
      const priorRequests = await tx.query<{ id: string; state: string; expired: boolean }>(
        `SELECT id,state,expires_at<=clock_timestamp() AS expired FROM interaction_requests WHERE notification_event_id=ANY($1::uuid[])
        ORDER BY id FOR UPDATE`,[supersededEventIds]);
      if (prior.deadlines.kind === "decision" && candidate.generation === prior.identity.generation
        && priorRequests.rows.some(row => row.state !== "pending" || row.expired)) {
        throw new SubjectAdmissionError("requires_replace");
      }
      await tx.query(`UPDATE interaction_requests SET state='canceled',responded_at=clock_timestamp()
        WHERE notification_event_id=ANY($1::uuid[]) AND state='pending'`,[supersededEventIds]);
      await tx.query(`UPDATE notification_events SET state='canceled',updated_at=clock_timestamp()
        WHERE id=ANY($1::uuid[]) AND state='active'`,[supersededEventIds]);
      await tx.query(`UPDATE notification_relevance
        SET superseded_at=$2::text::timestamptz,relevance=jsonb_set(jsonb_set(relevance,'{supersededAt}',to_jsonb($2::text)),
          '{supersededBy}',$3::jsonb)
        WHERE notification_event_id=ANY($1::uuid[])`,[supersededEventIds,now,candidate]);
      await tx.query(`UPDATE delivery_jobs SET state='canceled',last_error_code='subject_superseded',
        last_error_message='A newer canonical subject version replaced this unsent attempt',
        claim_token=NULL,claim_started_at=NULL,claim_phase=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
        WHERE notification_event_id=ANY($1::uuid[]) AND (state IN ('pending','retry')
          OR (state='processing' AND claim_phase='preparing'))`,[supersededEventIds]);
    }
  }
  const head = await tx.query<{ id:string }>(
    `INSERT INTO relevance_subjects(principal_id,source_id,subject_key,generation,revision,
       intent_sha256,current_event_id,current_relevance)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT(principal_id,source_id,subject_key) DO UPDATE SET generation=EXCLUDED.generation,
       revision=EXCLUDED.revision,intent_sha256=EXCLUDED.intent_sha256,
       current_event_id=EXCLUDED.current_event_id,current_relevance=EXCLUDED.current_relevance,
       updated_at=clock_timestamp() RETURNING id`,
    [actor.principalId,actor.sourceId,candidate.subjectKey,candidate.generation,candidate.revision,
      input.intentHash,input.eventId,relevance],
  );
  await tx.query(`INSERT INTO notification_relevance(notification_event_id,subject_id,generation,revision,
    relevance,deliver_until,action_expires_at,relevant_until,fresh_until)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [input.eventId,head.rows[0]!.id,candidate.generation,candidate.revision,relevance,
      relevance.deadlines.deliverUntil,relevance.deadlines.actionExpiresAt,relevance.deadlines.relevantUntil,
      relevance.deadlines.freshUntil]);
  return { kind:"applied",subjectId:head.rows[0]!.id,relevance,supersededEventIds };
}

/** Missing metadata is explicit legacy state; the adapter applies its cutover policy. */
export async function lockSubjectForEvent(
  tx: PoolClient, principalId: string, eventId: string,
): Promise<{ relevance: RelevanceItem; current: SubjectVersion } | null> {
  const row = (await tx.query<{ relevance: RelevanceItem; current_relevance: RelevanceItem }>(
    `SELECT r.relevance,s.current_relevance FROM notification_relevance r
     JOIN relevance_subjects s ON s.id=r.subject_id
     JOIN notification_events e ON e.id=r.notification_event_id AND e.principal_id=s.principal_id
     WHERE e.id=$1 AND s.principal_id=$2 FOR UPDATE OF s`,[eventId,principalId],
  )).rows[0];
  if (!row) return null;
  return { relevance:relevanceItemSchema.parse(row.relevance),
    current:relevanceItemSchema.parse(row.current_relevance).identity };
}

export function independentSubjectKey(idempotencyKey: string): string {
  return `event:${createHash("sha256").update(idempotencyKey).digest("hex")}`;
}
