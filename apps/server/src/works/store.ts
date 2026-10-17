import { EMPTY_WORK_PLAN,planComplete,type WorkPlan,type WorkSummary } from "@relo/notification-contracts";
import { publicId,internalId } from "../ids.js";

/** Anything that can run a query: a pool or a client inside a transaction. */
export type Queryable = { query<T = any>(text: string,values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }> };

export type WorkRow = {
  id: string; principal_id: string;
  producer_type: "agent_session" | "script" | "service";
  credential_id: string | null; service_id: string | null; session_key: string | null; harness: string | null; producer_key: string | null;
  lifecycle: "open" | "paused" | "finished" | "failed" | "dropped";
  paused_reason: "declared" | "parked" | null;
  finished_at: Date | null; outcome_declared: boolean;
  sealed_text: boolean; goal: string | null; status: string | null; outcome: string | null;
  waiting_reason: string | null; waiting_since: Date | null;
  sealed: Record<string,unknown> | null; producer_sealed: Record<string,unknown> | null;
  plan: WorkPlan | null; plan_version: number;
  progress_n: number | null; progress_m: number | null;
  context: Record<string,unknown> | null; source_name: string | null;
  version: number; create_idempotency_key: string | null; create_request_hash: string | null;
  created_at: Date; declared_at: Date; updated_at: Date;
};

/**
 * The scope every agent-session lookup carries, in SQL (never a post-filter): another session's
 * work is indistinguishable from a missing one.
 */
export type SessionScope = { principalId: string; sessionKey: string };

const SESSION_PREDICATE = "principal_id=$1 AND producer_type='agent_session' AND session_key=$2";

export function workPublicId(id: string): string { return publicId("wrk",id); }
export function workInternalId(value: string): string | undefined { return internalId("wrk",value); }

export async function lockOpenSessionWork(query: Queryable,scope: SessionScope): Promise<WorkRow | undefined> {
  return (await query.query<WorkRow>(`SELECT * FROM works WHERE ${SESSION_PREDICATE} AND lifecycle='open' FOR NO KEY UPDATE`,
    [scope.principalId,scope.sessionKey])).rows[0];
}

export async function lockSessionWork(query: Queryable,scope: SessionScope,workId: string): Promise<WorkRow | undefined> {
  return (await query.query<WorkRow>(`SELECT * FROM works WHERE ${SESSION_PREDICATE} AND id=$3 FOR NO KEY UPDATE`,
    [scope.principalId,scope.sessionKey,workId])).rows[0];
}

/** Any work of the account, locked: agents run every work's lifecycle, whichever session declared it. */
export async function lockAccountWork(query: Queryable,principalId: string,workId: string): Promise<WorkRow | undefined> {
  return (await query.query<WorkRow>(`SELECT * FROM works WHERE principal_id=$1 AND id=$2 FOR NO KEY UPDATE`,
    [principalId,workId])).rows[0];
}

export async function readSessionWork(query: Queryable,scope: SessionScope,workId: string): Promise<WorkRow | undefined> {
  return (await query.query<WorkRow>(`SELECT * FROM works WHERE ${SESSION_PREDICATE} AND id=$3`,
    [scope.principalId,scope.sessionKey,workId])).rows[0];
}

/** Open and paused works of one session, newest first. */
export async function readSessionLiveWorks(query: Queryable,scope: SessionScope): Promise<WorkRow[]> {
  return (await query.query<WorkRow>(`SELECT * FROM works WHERE ${SESSION_PREDICATE} AND lifecycle IN ('open','paused')
    ORDER BY (lifecycle='open') DESC, updated_at DESC LIMIT 50`,[scope.principalId,scope.sessionKey])).rows;
}

export async function newestPausedSessionWork(query: Queryable,scope: SessionScope): Promise<WorkRow | undefined> {
  return (await query.query<WorkRow>(`SELECT * FROM works WHERE ${SESSION_PREDICATE} AND lifecycle='paused'
    ORDER BY updated_at DESC LIMIT 1 FOR NO KEY UPDATE`,[scope.principalId,scope.sessionKey])).rows[0];
}

export async function findSessionStart(query: Queryable,credentialId: string,idempotencyKey: string,scope: SessionScope): Promise<WorkRow | undefined> {
  return (await query.query<WorkRow>(`SELECT * FROM works WHERE credential_id=$3 AND create_idempotency_key=$4 AND ${SESSION_PREDICATE}`,
    [scope.principalId,scope.sessionKey,credentialId,idempotencyKey])).rows[0];
}

export type NewSessionWork = {
  principalId: string; credentialId: string; sessionKey: string; harness: string;
  sealedText: boolean; goal: string | null; status: string | null; plan: WorkPlan; planVersion: number;
  progress: { done: number; total: number } | null; context: Record<string,unknown> | null; sourceName: string | null;
  sealed: Record<string,unknown> | null; producerSealed: Record<string,unknown> | null;
  idempotencyKey: string | null; requestHash: string | null;
};

export async function insertSessionWork(query: Queryable,work: NewSessionWork): Promise<WorkRow> {
  return (await query.query<WorkRow>(`INSERT INTO works (principal_id,producer_type,credential_id,session_key,harness,
      sealed_text,goal,status,plan,plan_version,progress_n,progress_m,context,source_name,sealed,producer_sealed,
      create_idempotency_key,create_request_hash)
    VALUES ($1,'agent_session',$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12::jsonb,$13,$14::jsonb,$15::jsonb,$16,$17) RETURNING *`,
  [work.principalId,work.credentialId,work.sessionKey,work.harness,work.sealedText,work.goal,work.status,
    JSON.stringify(work.plan),work.planVersion,work.progress?.done ?? null,work.progress?.total ?? null,
    work.context ? JSON.stringify(work.context) : null,work.sourceName,
    work.sealed ? JSON.stringify(work.sealed) : null,work.producerSealed ? JSON.stringify(work.producerSealed) : null,
    work.idempotencyKey,work.requestHash])).rows[0]!;
}

/** The only UPDATE of works: writes the full declared row and bumps its version. */
export async function saveWork(query: Queryable,row: WorkRow,options: { declared: boolean } = { declared: true }): Promise<WorkRow> {
  return (await query.query<WorkRow>(`UPDATE works SET lifecycle=$2,paused_reason=$3,finished_at=$4,outcome_declared=$5,
      goal=$6,status=$7,outcome=$8,waiting_reason=$9,waiting_since=$10,sealed=$11::jsonb,producer_sealed=$12::jsonb,
      plan=$13::jsonb,plan_version=$14,progress_n=$15,progress_m=$16,
      version=version+1,updated_at=statement_timestamp(),
      declared_at=CASE WHEN $17 THEN statement_timestamp() ELSE declared_at END,context=$18::jsonb
    WHERE id=$1 RETURNING *`,
  [row.id,row.lifecycle,row.paused_reason,row.finished_at,row.outcome_declared,row.goal,row.status,row.outcome,
    row.waiting_reason,row.waiting_since,row.sealed ? JSON.stringify(row.sealed) : null,
    row.producer_sealed ? JSON.stringify(row.producer_sealed) : null,JSON.stringify(row.plan ?? EMPTY_WORK_PLAN),
    row.plan_version,row.progress_n,row.progress_m,options.declared,row.context ? JSON.stringify(row.context) : null])).rows[0]!;
}

/** Handoff (the working layer): the work row after it moved to another session of the same account and computer. */
export async function moveWorkToSession(query: Queryable,workId: string,scope: SessionScope,harness: string): Promise<WorkRow> {
  // The card follows its work: it is one card, now declared by the new session.
  await query.query(`UPDATE live_activities SET session_key=$2 WHERE work_id=$1 AND producer_type='agent_session'`,[workId,scope.sessionKey]);
  return (await query.query<WorkRow>(`UPDATE works SET session_key=$2,harness=$3,lifecycle='open',paused_reason=NULL,
      version=version+1,updated_at=statement_timestamp(),declared_at=statement_timestamp()
    WHERE id=$1 AND principal_id=$4 RETURNING *`,[workId,scope.sessionKey,harness,scope.principalId])).rows[0]!;
}

export type HandoffRow = {
  id: string; work_id: string; account_id: string; credential_id: string; handle_hash: string;
  created_at: Date; expires_at: Date; used_at: Date | null;
};

/** One live handoff per work: a new one replaces the old handle (which then matches nothing). */
export async function replaceHandoff(query: Queryable,input: { workId: string; principalId: string; credentialId: string; handleHash: string; ttlMs: number })
  : Promise<HandoffRow> {
  return (await query.query<HandoffRow>(`INSERT INTO work_handoffs (work_id,account_id,credential_id,handle_hash,expires_at)
    VALUES ($1,$2,$3,$4,statement_timestamp() + ($5 * interval '1 millisecond'))
    ON CONFLICT (work_id) DO UPDATE SET account_id=EXCLUDED.account_id,credential_id=EXCLUDED.credential_id,
      handle_hash=EXCLUDED.handle_hash,created_at=statement_timestamp(),expires_at=EXCLUDED.expires_at,used_at=NULL
    RETURNING *`,[input.workId,input.principalId,input.credentialId,input.handleHash,input.ttlMs])).rows[0]!;
}

export async function lockHandoffByHash(query: Queryable,principalId: string,handleHash: string): Promise<HandoffRow | undefined> {
  return (await query.query<HandoffRow>(`SELECT * FROM work_handoffs WHERE account_id=$1 AND handle_hash=$2 FOR UPDATE`,
    [principalId,handleHash])).rows[0];
}

export async function markHandoffUsed(query: Queryable,id: string): Promise<void> {
  await query.query(`UPDATE work_handoffs SET used_at=statement_timestamp() WHERE id=$1`,[id]);
}

export async function readOperation(query: Queryable,workId: string,key: string)
  : Promise<{ request_hash: string; response: unknown } | undefined> {
  return (await query.query(`SELECT request_hash,response FROM work_operations WHERE work_id=$1 AND idempotency_key=$2`,[workId,key])).rows[0];
}

export async function saveOperation(query: Queryable,workId: string,key: string,operation: string,hash: string,response: unknown): Promise<void> {
  await query.query(`INSERT INTO work_operations (work_id,idempotency_key,operation,request_hash,response)
    VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING`,[workId,key,operation,hash,JSON.stringify(response)]);
}

export async function activeCardFor(query: Queryable,workId: string): Promise<{ id: string; state: string } | undefined> {
  return (await query.query(`SELECT id,state FROM live_activities WHERE work_id=$1 ORDER BY (state='active') DESC, created_at DESC LIMIT 1`,
    [workId])).rows[0];
}

// Owner reads (phones, linked browsers, Dashboard): every work of the account.
export async function readOwnerWorks(query: Queryable,principalId: string,options: { live: boolean; limit: number }): Promise<WorkRow[]> {
  return (await query.query<WorkRow>(`SELECT * FROM works WHERE principal_id=$1
      ${options.live ? "AND lifecycle IN ('open','paused')" : ""}
    ORDER BY updated_at DESC LIMIT $2`,[principalId,options.limit])).rows;
}

export async function readOwnerWork(query: Queryable,principalId: string,workId: string): Promise<WorkRow | undefined> {
  return (await query.query<WorkRow>(`SELECT * FROM works WHERE principal_id=$1 AND id=$2`,[principalId,workId])).rows[0];
}

export function serializeWork(row: WorkRow,card: { id: string; state: string } | undefined | null,
  options: { producerSealed: boolean } = { producerSealed: true }): WorkSummary {
  const plan = row.plan ?? EMPTY_WORK_PLAN;
  return {
    id: workPublicId(row.id),
    lifecycle: row.lifecycle,
    pausedReason: row.paused_reason,
    version: row.version,
    sealed: row.sealed_text,
    goal: row.goal,
    status: row.status,
    outcome: row.outcome,
    waiting: row.waiting_since ? { reason: row.waiting_reason,since: row.waiting_since.toISOString() } : null,
    plan: { version: row.plan_version,next: plan.next,complete: planComplete(plan),steps: plan.steps,...(plan.rounds ? { rounds: plan.rounds } : {}) },
    progress: row.progress_m !== null ? { done: row.progress_n ?? 0,total: row.progress_m } : null,
    startedAt: row.created_at.toISOString(),
    declaredAt: row.declared_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
    card: card ? { id: publicId("act",card.id),state: card.state } : null,
    ...(options.producerSealed && row.producer_sealed ? { producerSealed: row.producer_sealed } : {}),
  };
}

export function parkedSummary(row: WorkRow) {
  return { id: workPublicId(row.id),lifecycle: row.lifecycle,pausedReason: row.paused_reason,sealed: row.sealed_text,goal: row.goal };
}
