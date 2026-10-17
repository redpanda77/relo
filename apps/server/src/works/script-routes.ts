import {
  applyPlanCommand,declaredTextSchema,EMPTY_WORK_PLAN,planCommandSchema,
  WORK_GOAL_MAX,WORK_OUTCOME_MAX,WORK_RESULTS,WORK_STATUS_MAX,WORK_WAITING_MAX,workProgressSchema,
} from "@relo/notification-contracts";
import type { Context,Hono } from "hono";
import { z } from "zod";
import type { ApiRouteContext } from "../api/route-context.js";
import type { Database } from "../db.js";
import { refuseReadable } from "../content-policy.js";
import { credentialCardActor,type CardActor } from "./card-actor.js";
import { projectWorkCard } from "./card-projection.js";
import { applyDeclared,applyFinish,applyPauseStatus,applyProgress,carriesReadable,text,textFits,type WorkRefusal } from "./declared.js";

/** Readable text in any form a producer may send it: declared `{readable}` or a plain string. */
export const carriesReadableText = (input: Record<string,unknown>): boolean => carriesReadable(input)
  || ["goal","status","outcome"].some((key) => typeof input[key] === "string")
  || typeof (input.waiting as { reason?: unknown } | null | undefined)?.reason === "string";
import { clearLease,declareHeartbeat,isLeaseRefusal,parseLeaseSeconds,type LeaseOwner,type LeaseRefusal } from "./lease.js";
import type { NotificationDependencies } from "../notifications/types.js";
import { outcomeKindOf,readSealedOutcome,recordWorkOutcomeStandalone } from "./outcome-notification.js";
import { requestHash } from "./session-commands.js";
import { activeCardFor,saveWork,serializeWork,workInternalId,type Queryable,type WorkRow } from "./store.js";

/**
 * Producer works shared by the script module (`/api/producers/:producerKey/works…`, 2.9) and the
 * service module (`/hooks/:secret/works…`, 2.10), keyed by (credential | service, producerKey); neither
 * has a session. Every lookup is scoped in SQL. Identity, scoping, idempotency and leases are this module's;
 * the declared fields land through works/declared.ts, the same rules a session's work follows. A script
 * seals its text like an agent (ADR 0005); a service posting over HTTP may send a plain string, read as
 * readable text.
 */
/** The producer holding a work: its lease identity, its name, and how its cards are projected (plan 10 M5). */
export type ProducerOwner = LeaseOwner & { sourceName: string; card: CardActor; readableAllowed?: boolean };

/** Declared text, or a plain string meaning readable text (services calling the HTTP API). */
const producerText = (max: number) => z.union([
  z.string().trim().min(1).max(max).transform((readable) => ({ readable })),
  declaredTextSchema(max),
]);
const sealedObject = z.record(z.string(),z.unknown());
const envelopes = {
  context: z.record(z.string(),z.unknown()).optional().describe("Where the work runs (project, computer, account), as the CLI declares it; sealed fields arrive as handles."),
  sealed: sealedObject.optional().describe("The card text sealed to the owner's phones (an end-to-end envelope the CLI builds); with it, text fields are sent as { sealed: true }."),
  producerSealed: sealedObject.optional().describe("A copy of the work's text sealed to the producer itself, so it can restore its own work later."),
};
export const producerStartSchema = z.object({
  goal: producerText(WORK_GOAL_MAX).describe("What the work is for, in the owner's words: the card's title."),
  status: producerText(WORK_STATUS_MAX).optional().describe("What is happening now, in real words."),
  plan: planCommandSchema.optional().describe("The steps, as a plan command (usually set with the step labels)."),
  progress: workProgressSchema.optional().describe("A count for work without a plan, or for the current step (done of total)."),
  leaseSeconds: z.unknown().optional().describe("How long the work may stay silent and still count as moving; renew it with a heartbeat."),
  producerKey: z.string().optional().describe("Services only: names this job, so later calls find the same work."),
  new: z.boolean().optional().describe("Start a new work even if one is open (the open one is parked); otherwise a repeat start continues it."),
  ...envelopes,
}).strict();
export const producerUpdateSchema = z.object({
  goal: producerText(WORK_GOAL_MAX).optional().describe("A new goal, if it changed."),
  status: producerText(WORK_STATUS_MAX).optional().describe("What is happening now, in real words."),
  plan: planCommandSchema.optional().describe("A plan command: next step, add, revise, or jump to a step."),
  progress: workProgressSchema.nullable().optional().describe("A count (done of total); null clears it."),
  waiting: z.object({ reason: producerText(WORK_WAITING_MAX) }).strict().nullable().optional()
    .describe("Waiting on something outside the work (CI, a review), with the reason; null clears it."),
  ...envelopes,
}).strict();
export const producerFinishSchema = z.object({
  outcome: producerText(WORK_OUTCOME_MAX).describe("What happened, in the owner's words: the finish notification."),
  result: z.enum(WORK_RESULTS).default("finished").describe("finished, or failed or dropped when it did not succeed."),
  sealed: sealedObject.optional().describe("The final card text sealed to the owner's phones."),
  sealedOutcome: sealedObject.optional().describe("The finish notification sealed to the owner's phones (kind notice: title and outcome); without it a sealed work's notification carries a placeholder."),
}).strict();

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

const refuse = (refusal: LeaseRefusal | WorkRefusal | { error: string; status: number; message: string }): ProducerAnswer => {
  const { status,...body } = refusal;
  return { status,body };
};

const invalid = (error: z.ZodError): ProducerAnswer => ({ status: 400,body: { error: "invalid_request",message: error.issues.map((issue) => issue.message).join("; ") } });
const answerWith = async (db: Database,work: WorkRow,disposition: string,status: 200 | 201 = 200): Promise<ProducerAnswer> =>
  ({ status,body: { work: serializeWork(work,await activeCardFor(db,work.id)),disposition },changed: work });

/** Start: continue this producer's open work (replay by Idempotency-Key), or create one. Key required. */
export async function startProducerWork(db: Database,owner: ProducerOwner,raw: unknown,idempotencyKey: string | undefined): Promise<ProducerAnswer> {
  if (!idempotencyKey) {
    return { status: 400,body: { error: "idempotency_key_required",message: "Scripts and services must send Idempotency-Key on every create.",
      next: "Retry with the header Idempotency-Key: <your stable id>" } };
  }
  const parsed = producerStartSchema.safeParse(raw);
  if (!parsed.success) return invalid(parsed.error);
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
    // `new` parks the open work: its lease ends.
    open.lifecycle = "paused"; open.paused_reason = "parked";
    await saveWork(db,open); await clearLease(db,open.id);
  } else if (open) {
    const misfit = applyDeclared(open,{ status: input.status,sealed: input.sealed,producerSealed: input.producerSealed },{ goal: false,plan: false });
    if (misfit) return refuse(misfit);
    const saved = await saveWork(db,open);
    if (lease !== undefined) await declareHeartbeat(db,owner,saved.id,lease);
    return { status: 200,body: { work: serializeWork(saved,await activeCardFor(db,saved.id)),disposition: "continued",replayed: false },changed: saved };
  }
  const goal = text(input.goal);
  const misfit = textFits({ sealed_text: goal.sealed },input.status);
  if (misfit) return refuse(misfit);
  const draft = { sealed_text: goal.sealed,plan: EMPTY_WORK_PLAN,plan_version: 1,progress_n: null,progress_m: null } as unknown as WorkRow;
  if (input.plan) {
    const applied = applyPlanCommand(EMPTY_WORK_PLAN,input.plan,1,{ sealed: goal.sealed,now: new Date().toISOString() });
    if (!applied.ok) return { status: 422,body: { error: applied.code,message: applied.message } };
    draft.plan = applied.plan;
  }
  applyProgress(draft,input.progress);
  const identity = owner.producerType === "script" ? owner.credentialId : owner.serviceId;
  const row = (await db.query<WorkRow>(`INSERT INTO works (principal_id,producer_type,${owner.producerType === "script" ? "credential_id" : "service_id"},
      producer_key,sealed_text,goal,status,plan,plan_version,progress_n,progress_m,context,sealed,producer_sealed,source_name,
      create_idempotency_key,create_request_hash,lease_until)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,1,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15,$16,
      CASE WHEN $17::int IS NULL THEN NULL ELSE statement_timestamp() + make_interval(secs => $17::int) END) RETURNING *`,
  [owner.principalId,owner.producerType,identity,owner.producerKey,goal.sealed,goal.value,input.status ? text(input.status).value : null,
    JSON.stringify(draft.plan),draft.progress_n,draft.progress_m,input.context ? JSON.stringify(input.context) : null,
    input.sealed ? JSON.stringify(input.sealed) : null,input.producerSealed ? JSON.stringify(input.producerSealed) : null,
    owner.sourceName,idempotencyKey,hash,lease ?? null])).rows[0]!;
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
    if (!parsed.success) return invalid(parsed.error);
    if (work.lifecycle !== "open") return { status: 409,body: { error: "not_open",message: "This work is not open." } };
    const misfit = applyDeclared(work,parsed.data,{ goal: true,plan: true });
    if (misfit) return refuse(misfit);
    return answerWith(db,await saveWork(db,work),"updated");
  });
}

export function finishProducerWork(db: Database,owner: ProducerOwner,workId: string,raw: unknown,
  outcomes?: NotificationDependencies): Promise<ProducerAnswer> {
  return locked(db,owner,workId,async (work) => {
    if (!raw || typeof raw !== "object" || !("outcome" in raw)) return { status: 422,body: { error: "outcome_required",message: "Every finish declares an outcome." } };
    const parsed = producerFinishSchema.safeParse(raw);
    if (!parsed.success) return invalid(parsed.error);
    const sealedOutcome = readSealedOutcome(parsed.data);
    if ("error" in sealedOutcome) return { status: 422,body: { error: sealedOutcome.error,message: "The sealed outcome notice is not valid." } };
    if (work.lifecycle !== "open" && work.lifecycle !== "paused") return { status: 409,body: { error: "work_finished",message: "This work is already finished." } };
    const misfit = applyFinish(work,parsed.data);
    if (misfit) return refuse(misfit);
    const saved = await saveWork(db,work);
    await clearLease(db,saved.id);
    // A separate transaction after saveWork: a crash between the two loses this one buzz (the work is saved and
    // a retry of the finish answers from the saved state), a narrow window we accept for scripts.
    await recordWorkOutcomeStandalone(db,saved,outcomeKindOf(saved)!,outcomes,sealedOutcome.sealed);
    return answerWith(db,saved,"finished");
  });
}

export const producerPauseSchema = z.object({
  status: producerText(WORK_STATUS_MAX).optional().describe("Why the work is paused, in plain words, shown on the card."),
  sealed: sealedObject.optional().describe("The pause reason sealed to the owner's phones (an end-to-end envelope the CLI builds)."),
  producerSealed: sealedObject.optional().describe("A copy of the work's text sealed to the producer itself, so it can restore its own work later."),
}).strict();

/** Pause (with an optional declared reason) or resume. */
export function pauseProducerWork(db: Database,owner: ProducerOwner,workId: string,resume: boolean,raw: unknown = {}): Promise<ProducerAnswer> {
  return locked(db,owner,workId,async (work) => {
    if (resume ? work.lifecycle !== "paused" : work.lifecycle !== "open") {
      return { status: 409,body: { error: resume ? "not_paused" : "not_open",message: resume ? "This work is not paused." : "This work is not open." } };
    }
    if (!resume) {
      const parsed = producerPauseSchema.safeParse(raw ?? {});
      if (!parsed.success) return invalid(parsed.error);
      const misfit = applyPauseStatus(work,parsed.data);
      if (misfit) return refuse(misfit);
    }
    work.lifecycle = resume ? "open" : "paused";
    work.paused_reason = resume ? null : "declared";
    const saved = await saveWork(db,work);
    if (!resume) await clearLease(db,saved.id);
    return answerWith(db,saved,resume ? "resumed" : "paused");
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
  project: (owner: ProducerOwner,work: WorkRow) => Promise<void>,
  /** The producer type's text policy: a refusal for readable text it may not send, or null. */
  refuseReadable: (owner: ProducerOwner,input: unknown) => Promise<ProducerAnswer | null> = async () => null,
  /** Set where the outcome notification can be made (the account's content cipher); a finish without it makes none. */
  outcomes?: NotificationDependencies): void {
  const json = async (context: Context): Promise<unknown> => { try { return await context.req.json(); } catch { return {}; } };
  const key = (context: Context) => { const value = context.req.header("idempotency-key")?.trim(); return value && value.length <= 200 ? value : undefined; };
  const workId = (context: Context) => workInternalId(context.req.param("workId") ?? "");
  const send = async (context: Context,owner: ProducerOwner,answer: ProducerAnswer) => {
    if (answer.changed) await project(owner,answer.changed);
    return context.json(answer.body,answer.status as 200);
  };
  /** A declared write: the body is read once and checked against the type's text policy first. */
  const withWork = (run: (owner: ProducerOwner,id: string,input: unknown) => Promise<ProducerAnswer>) => async (context: Context) => {
    const owner = await resolve(context); if (owner instanceof Response) return owner;
    const id = workId(context); if (!id) return context.json(NOT_FOUND,404);
    const input = await json(context);
    const refused = await refuseReadable(owner,input);
    return send(context,owner,refused ?? await run(owner,id,input));
  };

  app.post(`${prefix}/works`,async (context) => {
    const owner = await resolve(context); if (owner instanceof Response) return owner;
    const input = await json(context);
    return send(context,owner,await refuseReadable(owner,input) ?? await startProducerWork(db,owner,input,key(context)));
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
  app.patch(`${prefix}/works/:workId`,withWork((owner,id,input) => updateProducerWork(db,owner,id,input)));
  app.post(`${prefix}/works/:workId/pause`,withWork((owner,id,input) => pauseProducerWork(db,owner,id,false,input)));
  app.post(`${prefix}/works/:workId/resume`,withWork((owner,id) => pauseProducerWork(db,owner,id,true)));
  app.post(`${prefix}/works/:workId/finish`,withWork((owner,id,input) => finishProducerWork(db,owner,id,input,outcomes)));
  app.post(`${prefix}/works/:workId/heartbeat`,withWork((owner,id,input) => heartbeatProducerWork(db,owner,id,input)));
}

/** `relo work` for scripts: `producerKey` = sha256("producer:"+key) base64url (43 chars), chosen by the CLI. */
const PRODUCER_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function registerScriptWorkRoutes(app: Hono,shared: ApiRouteContext): void {
  const { db,apnsMode,notificationContentCipher } = shared;
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
    const sourceName = auth.clientName ?? "Relo CLI";
    return { producerType: "script",principalId: auth.principalId,credentialId: auth.credentialId,producerKey,sourceName,
      card: credentialCardActor(db,{ kind: "credential",principalId: auth.principalId,credentialId: auth.credentialId,sourceName }) };
  },async (owner,work) => projectWorkCard(db,apnsMode,owner.card,work),async (owner,input) => {
    // A script seals like an agent: readable text on an account that requires end-to-end encryption is refused.
    if (!input || typeof input !== "object" || !carriesReadableText(input as Record<string,unknown>)) return null;
    const refused = await refuseReadable(db,owner.principalId);
    return refused ? { status: 409,body: { ...refused } } : null;
  },notificationContentCipher ? { apnsMode,contentCipher: notificationContentCipher } : undefined);
}
