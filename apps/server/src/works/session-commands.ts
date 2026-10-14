import { createHash } from "node:crypto";
import {
  applyPlanCommand,closePlan,EMPTY_WORK_PLAN,setCurrentStepProgress,
  type DeclaredText,type PlanCommand,type WorkDisposition,type WorkFinishRequest,type WorkPauseRequest,
  type WorkRefusalCode,type WorkResponse,type WorkStartRequest,type WorkUpdateRequest,
} from "@relo/notification-contracts";
import type { Database } from "../db.js";
import {
  activeCardFor,findSessionStart,insertSessionWork,lockOpenSessionWork,lockSessionWork,newestPausedSessionWork,
  parkedSummary,readOperation,readSessionLiveWorks,saveOperation,saveWork,serializeWork,
  type Queryable,type SessionScope,type WorkRow,
} from "./store.js";

/** The agent-session producer, resolved from headers and the API key (never the body). */
export type SessionOwner = SessionScope & { credentialId: string; harness: string; sourceName: string };

export type WorkRefusal = { error: WorkRefusalCode; status: 400 | 404 | 409 | 422; message: string; state?: unknown };
/** A committed command: the HTTP answer plus the works whose cards must follow. */
export type WorkAccepted = { status: 200 | 201; body: WorkResponse; changed: WorkRow[] };
export type WorkOutcome = WorkAccepted | WorkRefusal;

export const isRefusal = (value: WorkOutcome): value is WorkRefusal => "error" in value;

/**
 * The idempotency fingerprint of a declared write. Envelopes (`sealed`, `producerSealed`) are left out: they
 * are fresh randomness on every seal, so a CLI that re-seals a queued write for its replay (EDGE.3) still
 * gets the first result instead of a conflict.
 */
export function requestHash(operation: string,value: unknown): string {
  const declared = value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "sealed" && key !== "producerSealed"))
    : value;
  return createHash("sha256").update(JSON.stringify([operation,declared])).digest("hex");
}

function refusal(error: WorkRefusalCode,status: WorkRefusal["status"],message: string,state?: unknown): WorkRefusal {
  return { error,status,message,...(state !== undefined ? { state } : {}) };
}

const NOT_FOUND = () => refusal("not_found",404,"Work not found in this session.");

type Text = { value: string | null; sealed: boolean };
const text = (declared: DeclaredText): Text => "sealed" in declared ? { value: null,sealed: true } : { value: declared.readable,sealed: false };

/** A sealed work never stores readable text; a readable work never takes sealed text. */
function textFits(work: { sealed_text: boolean },...values: Array<DeclaredText | undefined>): WorkRefusal | null {
  for (const value of values) {
    if (!value) continue;
    if (("sealed" in value) !== work.sealed_text) {
      return refusal("invalid_request",422,work.sealed_text
        ? "This work is end-to-end encrypted; send sealed text."
        : "This work is readable; send readable text.");
    }
  }
  return null;
}

async function inTransaction<T>(db: Database,run: (client: Queryable) => Promise<T & ({ rollback?: boolean })>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query(result.rollback ? "ROLLBACK" : "COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function response(query: Queryable,owner: SessionOwner,work: WorkRow,disposition: WorkDisposition,
  extra: { replayed?: boolean; ignored?: string[] } = {}): Promise<WorkResponse> {
  const others = (await readSessionLiveWorks(query,owner)).filter((row) => row.id !== work.id && row.lifecycle === "paused");
  return {
    work: serializeWork(work,await activeCardFor(query,work.id)),
    disposition,
    replayed: extra.replayed ?? false,
    ignored: extra.ignored ?? [],
    parked: others.map(parkedSummary),
  };
}

async function sessionState(query: Queryable,owner: SessionOwner) {
  const live = await readSessionLiveWorks(query,owner);
  const open = live.find((row) => row.lifecycle === "open");
  return { open: open ? parkedSummary(open) : null,parked: live.filter((row) => row.lifecycle === "paused").map(parkedSummary) };
}

function applyPlan(work: WorkRow,command: PlanCommand | undefined): WorkRefusal | null {
  if (!command) return null;
  const nextVersion = work.plan_version + 1;
  const result = applyPlanCommand(work.plan ?? EMPTY_WORK_PLAN,command,nextVersion,{ sealed: work.sealed_text });
  if (!result.ok) return refusal(result.code,422,result.message);
  work.plan = result.plan;
  if (result.structural) work.plan_version = nextVersion;
  return null;
}

function applyProgress(work: WorkRow,progress: { done: number; total: number } | null | undefined): void {
  if (progress === undefined) return;
  const plan = work.plan ?? EMPTY_WORK_PLAN;
  if (plan.steps.length) {
    const updated = setCurrentStepProgress(plan,progress);
    if (updated) { work.plan = updated; return; }
  }
  work.progress_n = progress?.done ?? null;
  work.progress_m = progress?.total ?? null;
}

function applyUpdate(work: WorkRow,input: WorkUpdateRequest | WorkStartRequest,options: { goal: boolean; plan: boolean }): WorkRefusal | null {
  const misfit = textFits(work,options.goal ? input.goal : undefined,input.status,
    "waiting" in input && input.waiting ? input.waiting.reason : undefined);
  if (misfit) return misfit;
  if (options.goal && input.goal) work.goal = text(input.goal).value;
  if (input.status) work.status = text(input.status).value;
  if (options.plan) {
    const planRefusal = applyPlan(work,input.plan);
    if (planRefusal) return planRefusal;
  }
  applyProgress(work,input.progress);
  if ("waiting" in input && input.waiting !== undefined) {
    if (input.waiting === null) { work.waiting_reason = null; work.waiting_since = null; }
    else { work.waiting_reason = text(input.waiting.reason).value; work.waiting_since = work.waiting_since ?? new Date(); }
  }
  if (input.sealed) work.sealed = input.sealed;
  if (input.producerSealed) work.producer_sealed = input.producerSealed;
  // Declared context fields replace their old values (a renamed session's threadName); the rest stays.
  if (input.context) work.context = { ...(work.context ?? {}),...input.context };
  return null;
}

/** `start`: continue the open work (goal and plan ignored), or create one; `new` parks the open one. */
export async function startSessionWork(db: Database,owner: SessionOwner,input: WorkStartRequest,
  idempotencyKey: string | undefined): Promise<WorkOutcome> {
  const hash = requestHash("start",input);
  return inTransaction(db,async (query) => {
    if (idempotencyKey) {
      const prior = await findSessionStart(query,owner.credentialId,idempotencyKey,owner);
      if (prior) {
        if (prior.create_request_hash !== hash) return { ...refusal("idempotency_conflict",409,"This Idempotency-Key was used for a different start."),rollback: true };
        return { status: 200 as const,body: await response(query,owner,prior,"started",{ replayed: true }),changed: [] };
      }
    }
    const open = await lockOpenSessionWork(query,owner);
    const changed: WorkRow[] = [];
    let disposition: WorkDisposition = "started";
    if (open && !input.new) {
      const ignored = [input.goal ? "goal" : null,input.plan ? "plan" : null].filter((value): value is string => value !== null);
      const misfit = applyUpdate(open,{ ...input,goal: undefined,plan: undefined } as unknown as WorkUpdateRequest,{ goal: false,plan: false });
      if (misfit) return { ...misfit,rollback: true };
      const saved = await saveWork(query,open);
      return { status: 200 as const,body: await response(query,owner,saved,"continuing",{ ignored }),changed: [saved] };
    }
    if (open) {
      open.lifecycle = "paused";
      open.paused_reason = "parked";
      changed.push(await saveWork(query,open,{ declared: false }));
      disposition = "switched";
    }
    const goal = text(input.goal);
    const misfit = textFits({ sealed_text: goal.sealed },input.status);
    if (misfit) return { ...misfit,rollback: true };
    const draft = { sealed_text: goal.sealed,plan: EMPTY_WORK_PLAN,plan_version: 1,progress_n: null,progress_m: null } as unknown as WorkRow;
    if (input.plan) {
      const result = applyPlanCommand(EMPTY_WORK_PLAN,input.plan,1,{ sealed: goal.sealed });
      if (!result.ok) return { ...refusal(result.code,422,result.message),rollback: true };
      draft.plan = result.plan;
    }
    applyProgress(draft,input.progress);
    const created = await insertSessionWork(query,{
      principalId: owner.principalId,credentialId: owner.credentialId,sessionKey: owner.sessionKey,harness: owner.harness,
      sealedText: goal.sealed,goal: goal.value,status: input.status ? text(input.status).value : null,
      plan: draft.plan ?? EMPTY_WORK_PLAN,planVersion: 1,
      progress: draft.progress_m !== null ? { done: draft.progress_n ?? 0,total: draft.progress_m } : null,
      context: input.context ?? null,sourceName: owner.sourceName.slice(0,80) || null,
      sealed: input.sealed ?? null,producerSealed: input.producerSealed ?? null,
      idempotencyKey: idempotencyKey ?? null,requestHash: idempotencyKey ? hash : null,
    });
    changed.push(created);
    return { status: 201 as const,body: await response(query,owner,created,disposition),changed };
  });
}

type Resolve = { workId: string | "current" };

async function resolveTarget(query: Queryable,owner: SessionOwner,target: Resolve): Promise<WorkRow | undefined> {
  if (target.workId === "current") return lockOpenSessionWork(query,owner);
  return lockSessionWork(query,owner,target.workId);
}

/** Shared frame for by-id commands: scope, idempotency receipt, finished refusal, save. */
async function workCommand(db: Database,owner: SessionOwner,target: Resolve,operation: "update" | "pause" | "resume" | "finish",
  input: unknown,idempotencyKey: string | undefined,
  apply: (query: Queryable,work: WorkRow) => Promise<{ refusal: WorkRefusal } | { changed: WorkRow[]; work: WorkRow; disposition: WorkDisposition }>)
  : Promise<WorkOutcome> {
  const hash = requestHash(operation,input);
  return inTransaction(db,async (query) => {
    const work = await resolveTarget(query,owner,target);
    if (!work) {
      if (target.workId === "current") return { ...refusal("not_open",409,"This session has no open work.",await sessionState(query,owner)),rollback: true };
      return { ...NOT_FOUND(),rollback: true };
    }
    if (idempotencyKey) {
      const prior = await readOperation(query,work.id,idempotencyKey);
      if (prior) {
        if (prior.request_hash !== hash) return { ...refusal("idempotency_conflict",409,"This Idempotency-Key was used for a different write."),rollback: true };
        return { status: 200 as const,body: { ...(prior.response as WorkResponse),replayed: true },changed: [] };
      }
    }
    if (work.lifecycle === "finished" || work.lifecycle === "failed" || work.lifecycle === "dropped") {
      return { ...refusal("work_finished",409,`This work is ${work.lifecycle}; start a new goal with start.`,
        { work: serializeWork(work,null) }),rollback: true };
    }
    const applied = await apply(query,work);
    if ("refusal" in applied) return { ...applied.refusal,rollback: true };
    const body = await response(query,owner,applied.work,applied.disposition);
    if (idempotencyKey) await saveOperation(query,work.id,idempotencyKey,operation,hash,body);
    return { status: 200 as const,body,changed: applied.changed };
  });
}

export function updateSessionWork(db: Database,owner: SessionOwner,target: Resolve,input: WorkUpdateRequest,idempotencyKey?: string) {
  return workCommand(db,owner,target,"update",input,idempotencyKey,async (query,work) => {
    if (work.lifecycle !== "open") return { refusal: refusal("not_open",409,"This work is paused; resume it first.",await sessionState(query,owner)) };
    if (input.baseVersion !== undefined && input.baseVersion !== work.version) {
      return { refusal: refusal("version_conflict",409,`This work is at version ${work.version}.`,{ work: serializeWork(work,null) }) };
    }
    const misfit = applyUpdate(work,input,{ goal: true,plan: true });
    if (misfit) return { refusal: misfit };
    const saved = await saveWork(query,work);
    return { changed: [saved],work: saved,disposition: "updated" };
  });
}

export function pauseSessionWork(db: Database,owner: SessionOwner,target: Resolve,input: WorkPauseRequest,idempotencyKey?: string) {
  return workCommand(db,owner,target,"pause",input,idempotencyKey,async (query,work) => {
    if (work.lifecycle !== "open") return { refusal: refusal("not_open",409,"This work is already paused.",await sessionState(query,owner)) };
    const misfit = textFits(work,input.status);
    if (misfit) return { refusal: misfit };
    work.status = text(input.status).value;
    if (input.sealed) work.sealed = input.sealed;
    if (input.producerSealed) work.producer_sealed = input.producerSealed;
    work.lifecycle = "paused";
    work.paused_reason = "declared";
    const saved = await saveWork(query,work);
    return { changed: [saved],work: saved,disposition: "paused" };
  });
}

/** Resume a paused work; the session's open work (if another) is parked. */
export async function resumeSessionWork(db: Database,owner: SessionOwner,target: Resolve | { workId: "newest" },idempotencyKey?: string) {
  if (target.workId === "newest") {
    const newest = await newestPausedSessionWork(db,owner);
    if (!newest) return refusal("not_found",404,"This session has no paused work.");
    target = { workId: newest.id };
  }
  return workCommand(db,owner,target as Resolve,"resume",{},idempotencyKey,async (query,work) => {
    if (work.lifecycle === "open") return { changed: [],work,disposition: "resumed" };
    const changed: WorkRow[] = [];
    const open = await lockOpenSessionWork(query,owner);
    if (open) {
      open.lifecycle = "paused";
      open.paused_reason = "parked";
      changed.push(await saveWork(query,open,{ declared: false }));
    }
    work.lifecycle = "open";
    work.paused_reason = null;
    const saved = await saveWork(query,work);
    changed.push(saved);
    return { changed,work: saved,disposition: "resumed" };
  });
}

export function finishSessionWork(db: Database,owner: SessionOwner,target: Resolve,input: WorkFinishRequest,idempotencyKey?: string) {
  return workCommand(db,owner,target,"finish",input,idempotencyKey,async (tx,work) => {
    const misfit = textFits(work,input.outcome);
    if (misfit) return { refusal: misfit };
    work.outcome = text(input.outcome).value;
    work.outcome_declared = true;
    // The outcome replaces the last in-progress status (DOGFOOD #20), as finishing clears waiting.
    work.status = null;
    work.lifecycle = input.result;
    work.paused_reason = null;
    work.finished_at = new Date();
    work.waiting_reason = null;
    work.waiting_since = null;
    work.plan = closePlan(work.plan ?? EMPTY_WORK_PLAN,input.result);
    if (input.sealed) work.sealed = input.sealed;
    const saved = await saveWork(tx,work);
    return { changed: [saved],work: saved,disposition: "finished" };
  });
}

export async function readSessionState(db: Database,owner: SessionOwner) {
  const live = await readSessionLiveWorks(db,owner);
  const works = await Promise.all(live.map(async (row) => serializeWork(row,await activeCardFor(db,row.id))));
  return { open: works.find((work) => work.lifecycle === "open") ?? null,parked: works.filter((work) => work.lifecycle === "paused") };
}
