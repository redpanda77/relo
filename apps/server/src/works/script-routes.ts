import { applyPlanCommand,closePlan,EMPTY_WORK_PLAN,type PlanCommand } from "@relo/notification-contracts";
import type { Context,Hono } from "hono";
import { z } from "zod";
import type { ApiRouteContext } from "../api/route-context.js";
import type { Database } from "../db.js";
import { projectWorkCard } from "./card-projection.js";
import { clearLease,declareHeartbeat,isLeaseRefusal,parseLeaseSeconds,type LeaseOwner,type LeaseRefusal } from "./lease.js";
import { requestHash } from "./session-commands.js";
import { activeCardFor,saveWork,serializeWork,workInternalId,type Queryable,type WorkRow } from "./store.js";

/**
 * Producer works shared by the script module (`/api/producers/:producerKey/works…`, 2.9) and the
 * service module (`/hooks/:secret/works…`, 2.10). Both are readable-text producers keyed by
 * (credential | service, producerKey); neither has a session. Every lookup is scoped in SQL.
 * TODO(works core owner): fold start/update/pause onto the shared `works/core` commands once they
 * accept ScriptOwner/ServiceOwner; until then these routes write through `saveWork` plus the inserts below.
 */
export type ProducerOwner = LeaseOwner & { sourceName: string };

const text = z.string().trim().min(1).max(500);
const planSchema = z.object({ op: z.literal("set"),steps: z.array(z.object({ label: text })).min(1).max(12) });
const progressSchema = z.object({ done: z.number().int().min(0),total: z.number().int().min(1) }).nullable();
export const producerStartSchema = z.object({
  goal: text,status: text.optional(),plan: planSchema.optional(),progress: progressSchema.optional(),
  leaseSeconds: z.unknown().optional(),producerKey: z.string().optional(),new: z.boolean().optional(),
}).strict();
export const producerUpdateSchema = z.object({
  goal: text.optional(),status: text.optional(),plan: z.any().optional(),progress: progressSchema.optional(),
  waiting: z.object({ reason: text }).nullable().optional(),
}).strict();
export const producerFinishSchema = z.object({ outcome: text,result: z.enum(["finished","failed","dropped"]).default("finished") }).strict();

const NOT_FOUND = { error: "not_found",message: "Work not found for this producer." } as const;

function predicate(owner: ProducerOwner): { sql: string; values: unknown[] } {
  return owner.producerType === "script"
    ? { sql: "principal_id=$1 AND producer_type='script' AND credential_id=$2 AND producer_key=$3",values: [owner.principalId,owner.credentialId,owner.producerKey] }
    : { sql: "principal_id=$1 AND producer_type='service' AND service_id=$2 AND ($3='' OR producer_key=$3)",values: [owner.principalId,owner.serviceId,owner.producerKey] };
}

export async function readProducerWork(query: Queryable,owner: ProducerOwner,workId: string): Promise<WorkRow | undefined> {
  const { sql,values } = predicate(owner);
  return (await query.query<WorkRow>(`SELECT * FROM works WHERE ${sql} AND id=$4`,[...values,workId])).rows[0];
}

export async function listProducerWorks(query: Queryable,owner: ProducerOwner,state: "open" | "paused" | "all"): Promise<WorkRow[]> {
  const { sql,values } = predicate(owner);
  const filter = state === "all" ? "" : `AND lifecycle='${state}'`;
  return (await query.query<WorkRow>(`SELECT * FROM works WHERE ${sql} ${filter} ORDER BY updated_at DESC LIMIT 50`,values)).rows;
}

export type ProducerAnswer = { status: number; body: Record<string,unknown>; changed?: WorkRow };

const refuse = (refusal: LeaseRefusal | { error: string; status: number; message: string }): ProducerAnswer => {
  const { status,...body } = refusal;
  return { status,body };
};

/** Start: continue this producer's open work (replay by Idempotency-Key), or create one. Key required. */
export async function startProducerWork(db: Database,owner: ProducerOwner,raw: unknown,idempotencyKey: string | undefined): Promise<ProducerAnswer> {
  if (!idempotencyKey) {
    return { status: 400,body: { error: "idempotency_key_required",message: "Scripts and services must send Idempotency-Key on every create.",
      next: "Retry with the header Idempotency-Key: <your stable id>" } };
  }
  const parsed = producerStartSchema.safeParse(raw);
  if (!parsed.success) return { status: 400,body: { error: "invalid_request",message: parsed.error.issues.map((issue) => issue.message).join("; ") } };
  const input = parsed.data;
  const lease = parseLeaseSeconds(input.leaseSeconds);
  if (isLeaseRefusal(lease)) return refuse(lease);
  const hash = requestHash("start",input);
  const { sql,values } = predicate(owner);
  const replay = (await db.query<WorkRow>(`SELECT * FROM works WHERE ${sql} AND create_idempotency_key=$4`,[...values,idempotencyKey])).rows[0];
  if (replay) {
    if (replay.create_request_hash !== hash) return { status: 409,body: { error: "idempotency_conflict",message: "This Idempotency-Key was used for a different start." } };
    return { status: 200,body: { work: serializeWork(replay,await activeCardFor(db,replay.id)),disposition: "started",replayed: true } };
  }
  const open = (await db.query<WorkRow>(`SELECT * FROM works WHERE ${sql} AND lifecycle='open'`,values)).rows[0];
  if (open && input.new) {
    // `new` parks the open work: it stays readable, its lease ends.
    open.lifecycle = "paused"; open.paused_reason = "parked";
    await saveWork(db,open); await clearLease(db,open.id);
  } else if (open) {
    if (input.status) open.status = input.status;
    const saved = await saveWork(db,open);
    if (lease !== undefined) await declareHeartbeat(db,owner,saved.id,lease);
    return { status: 200,body: { work: serializeWork(saved,await activeCardFor(db,saved.id)),disposition: "continued",replayed: false },changed: saved };
  }
  let plan = EMPTY_WORK_PLAN;
  if (input.plan) {
    const applied = applyPlanCommand(EMPTY_WORK_PLAN,input.plan as PlanCommand,1,{ sealed: false });
    if (!applied.ok) return { status: 422,body: { error: applied.code,message: applied.message } };
    plan = applied.plan;
  }
  const identity = owner.producerType === "script" ? owner.credentialId : owner.serviceId;
  const row = (await db.query<WorkRow>(`INSERT INTO works (principal_id,producer_type,${owner.producerType === "script" ? "credential_id" : "service_id"},
      producer_key,sealed_text,goal,status,plan,plan_version,progress_n,progress_m,source_name,create_idempotency_key,create_request_hash,lease_until)
    VALUES ($1,$2,$3,$4,false,$5,$6,$7::jsonb,1,$8,$9,$10,$11,$12,
      CASE WHEN $13::int IS NULL THEN NULL ELSE statement_timestamp() + make_interval(secs => $13::int) END) RETURNING *`,
  [owner.principalId,owner.producerType,identity,owner.producerKey,input.goal,input.status ?? null,JSON.stringify(plan),
    input.progress?.done ?? null,input.progress?.total ?? null,owner.sourceName,idempotencyKey,hash,lease ?? null])).rows[0]!;
  return { status: 201,body: { work: serializeWork(row,null),disposition: "started",replayed: false },changed: row };
}

async function locked(db: Database,owner: ProducerOwner,workId: string,run: (work: WorkRow) => Promise<ProducerAnswer>): Promise<ProducerAnswer> {
  const work = await readProducerWork(db,owner,workId);
  if (!work) return { status: 404,body: { ...NOT_FOUND } };
  return run(work);
}

export function updateProducerWork(db: Database,owner: ProducerOwner,workId: string,raw: unknown): Promise<ProducerAnswer> {
  return locked(db,owner,workId,async (work) => {
    const parsed = producerUpdateSchema.safeParse(raw);
    if (!parsed.success) return { status: 400,body: { error: "invalid_request",message: parsed.error.issues.map((issue) => issue.message).join("; ") } };
    if (work.lifecycle !== "open") return { status: 409,body: { error: "not_open",message: "This work is not open." } };
    const input = parsed.data;
    if (input.goal) work.goal = input.goal;
    if (input.status) work.status = input.status;
    if (input.plan) {
      const applied = applyPlanCommand(work.plan ?? EMPTY_WORK_PLAN,input.plan as PlanCommand,work.plan_version + 1,{ sealed: false });
      if (!applied.ok) return { status: 422,body: { error: applied.code,message: applied.message } };
      work.plan = applied.plan;
      if (applied.structural) work.plan_version += 1;
    }
    if (input.progress !== undefined) { work.progress_n = input.progress?.done ?? null; work.progress_m = input.progress?.total ?? null; }
    if (input.waiting !== undefined) {
      work.waiting_reason = input.waiting?.reason ?? null;
      work.waiting_since = input.waiting ? work.waiting_since ?? new Date() : null;
    }
    const saved = await saveWork(db,work);
    return { status: 200,body: { work: serializeWork(saved,await activeCardFor(db,saved.id)),disposition: "updated" },changed: saved };
  });
}

export function finishProducerWork(db: Database,owner: ProducerOwner,workId: string,raw: unknown): Promise<ProducerAnswer> {
  return locked(db,owner,workId,async (work) => {
    if (!raw || typeof raw !== "object" || !("outcome" in raw)) return { status: 422,body: { error: "outcome_required",message: "Every finish declares an outcome." } };
    const parsed = producerFinishSchema.safeParse(raw);
    if (!parsed.success) return { status: 400,body: { error: "invalid_request",message: parsed.error.issues.map((issue) => issue.message).join("; ") } };
    if (work.lifecycle !== "open" && work.lifecycle !== "paused") return { status: 409,body: { error: "work_finished",message: "This work is already finished." } };
    work.outcome = parsed.data.outcome; work.outcome_declared = true; work.lifecycle = parsed.data.result;
    work.paused_reason = null; work.finished_at = new Date(); work.waiting_reason = null; work.waiting_since = null;
    work.plan = closePlan(work.plan ?? EMPTY_WORK_PLAN,parsed.data.result);
    const saved = await saveWork(db,work);
    await clearLease(db,saved.id);
    return { status: 200,body: { work: serializeWork(saved,await activeCardFor(db,saved.id)),disposition: "finished" },changed: saved };
  });
}

export function pauseProducerWork(db: Database,owner: ProducerOwner,workId: string,resume: boolean): Promise<ProducerAnswer> {
  return locked(db,owner,workId,async (work) => {
    if (resume ? work.lifecycle !== "paused" : work.lifecycle !== "open") {
      return { status: 409,body: { error: resume ? "not_paused" : "not_open",message: resume ? "This work is not paused." : "This work is not open." } };
    }
    work.lifecycle = resume ? "open" : "paused";
    work.paused_reason = resume ? null : "declared";
    const saved = await saveWork(db,work);
    if (!resume) await clearLease(db,saved.id);
    return { status: 200,body: { work: serializeWork(saved,await activeCardFor(db,saved.id)),disposition: resume ? "resumed" : "paused" },changed: saved };
  });
}

export async function heartbeatProducerWork(db: Database,owner: ProducerOwner,workId: string,raw: unknown): Promise<ProducerAnswer> {
  const seconds = parseLeaseSeconds((raw as { leaseSeconds?: unknown } | null)?.leaseSeconds);
  if (seconds === undefined) return { status: 400,body: { error: "invalid_lease",message: "Send { leaseSeconds } from 60 to 3600." } };
  if (isLeaseRefusal(seconds)) return refuse(seconds);
  const result = await declareHeartbeat(db,owner,workId,seconds);
  if (isLeaseRefusal(result)) return refuse(result);
  return { status: 200,body: { work: serializeWork(result.work,await activeCardFor(db,result.work.id)),leaseUntil: result.leaseUntil } };
}

/** The producer route table, mounted under a prefix; `resolve` authenticates and names the owner. */
export function mountProducerWorkRoutes(app: Hono,prefix: string,db: Database,
  resolve: (context: Context) => Promise<ProducerOwner | Response>,
  project: (owner: ProducerOwner,work: WorkRow) => Promise<void>): void {
  const json = async (context: Context): Promise<unknown> => { try { return await context.req.json(); } catch { return {}; } };
  const key = (context: Context) => { const value = context.req.header("idempotency-key")?.trim(); return value && value.length <= 200 ? value : undefined; };
  const workId = (context: Context) => workInternalId(context.req.param("workId") ?? "");
  const send = async (context: Context,owner: ProducerOwner,answer: ProducerAnswer) => {
    if (answer.changed) await project(owner,answer.changed);
    return context.json(answer.body,answer.status as 200);
  };
  const withWork = (run: (owner: ProducerOwner,id: string,context: Context) => Promise<ProducerAnswer>) => async (context: Context) => {
    const owner = await resolve(context); if (owner instanceof Response) return owner;
    const id = workId(context); if (!id) return context.json(NOT_FOUND,404);
    return send(context,owner,await run(owner,id,context));
  };

  app.post(`${prefix}/works`,async (context) => {
    const owner = await resolve(context); if (owner instanceof Response) return owner;
    return send(context,owner,await startProducerWork(db,owner,await json(context),key(context)));
  });
  app.get(`${prefix}/works`,async (context) => {
    const owner = await resolve(context); if (owner instanceof Response) return owner;
    const state = (context.req.query("state") ?? "open") as "open" | "paused" | "all";
    if (!["open","paused","all"].includes(state)) return context.json({ error: "invalid_request",message: "state is open, paused or all." },400);
    context.header("Cache-Control","no-store");
    const rows = await listProducerWorks(db,owner,state);
    return context.json({ works: await Promise.all(rows.map(async (row) => serializeWork(row,await activeCardFor(db,row.id)))) });
  });
  app.get(`${prefix}/works/:workId`,async (context) => {
    const owner = await resolve(context); if (owner instanceof Response) return owner;
    const id = workId(context); if (!id) return context.json(NOT_FOUND,404);
    const row = await readProducerWork(db,owner,id); if (!row) return context.json(NOT_FOUND,404);
    context.header("Cache-Control","no-store");
    return context.json({ work: serializeWork(row,await activeCardFor(db,row.id)) });
  });
  app.patch(`${prefix}/works/:workId`,withWork(async (owner,id,context) => updateProducerWork(db,owner,id,await json(context))));
  app.post(`${prefix}/works/:workId/pause`,withWork(async (owner,id) => pauseProducerWork(db,owner,id,false)));
  app.post(`${prefix}/works/:workId/resume`,withWork(async (owner,id) => pauseProducerWork(db,owner,id,true)));
  app.post(`${prefix}/works/:workId/finish`,withWork(async (owner,id,context) => finishProducerWork(db,owner,id,await json(context))));
  app.post(`${prefix}/works/:workId/heartbeat`,withWork(async (owner,id,context) => heartbeatProducerWork(db,owner,id,await json(context))));
}

/** `relo work` for scripts: `producerKey` = sha256("producer:"+key) base64url (43 chars), chosen by the CLI. */
const PRODUCER_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function registerScriptWorkRoutes(app: Hono,shared: ApiRouteContext): void {
  const { db,apnsMode } = shared;
  mountProducerWorkRoutes(app,"/api/producers/:producerKey",db,async (context) => {
    const auth = context.get("auth");
    if (!auth.scopes.has("activities:write")) return context.json({ error: "forbidden" },403);
    if (!auth.credentialId) return context.json({ error: "principal_credential_required" },403);
    // A script never carries a session: the session surface is the agent module's.
    if (context.req.header("relo-session-key")) {
      return context.json({ error: "wrong_surface",message: "This request names a session; sessions use /api/session/works." },400);
    }
    const producerKey = context.req.param("producerKey") ?? "";
    if (!PRODUCER_KEY_PATTERN.test(producerKey)) return context.json({ error: "invalid_producer_key",message: "producerKey is 43 base64url characters." },400);
    return { producerType: "script",principalId: auth.principalId,credentialId: auth.credentialId,producerKey,sourceName: auth.clientName ?? "Relo CLI" };
  },async (owner,work) => {
    if (owner.producerType !== "script") return;
    await projectWorkCard(db,apnsMode,{ kind: "credential",principalId: owner.principalId,credentialId: owner.credentialId,sourceName: owner.sourceName },work);
  });
}
