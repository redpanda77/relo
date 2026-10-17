import { createHash,randomBytes } from "node:crypto";
import {
  applyPlanCommand,EMPTY_WORK_PLAN,lastRound,WORK_ENDED_BY_OWNER_OUTCOME,
  type WorkDeliverRequest,type WorkDisposition,type WorkFinishRequest,type WorkHandoffRequest,type WorkHandoffResponse,type WorkPauseRequest,
  type WorkResponse,type WorkStartRequest,type WorkUpdateRequest,
} from "@relo/notification-contracts";
import { applyDeclared,applyDeliver,applyFinish,applyPauseStatus,applyProgress,refusal,roundClosed,text,textFits,type WorkRefusal } from "./declared.js";
import type { Database } from "../db.js";
import type { NotificationDependencies } from "../notifications/types.js";
import type { SubjectTransaction } from "../relevance/commands.js";
import { liveRefusal } from "./hanging.js";
import { outcomeKindOf,readSealedOutcome,recordWorkOutcome } from "./outcome-notification.js";
import {
  activeCardFor,findSessionStart,insertSessionWork,lockAccountWork,lockHandoffByHash,lockOpenSessionWork,lockSessionWork,markHandoffUsed,
  moveWorkToSession,newestPausedSessionWork,parkedSummary,readOperation,replaceHandoff,readSessionLiveWorks,saveOperation,saveWork,serializeWork,
  type Queryable,type SessionScope,type WorkRow,
} from "./store.js";

/** The agent-session producer, resolved from headers and the API key (never the body). */
export type SessionOwner = SessionScope & { credentialId: string; harness: string; sourceName: string };

export type { WorkRefusal };
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
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "sealed" && key !== "producerSealed" && key !== "sealedOutcome"))
    : value;
  return createHash("sha256").update(JSON.stringify([operation,declared])).digest("hex");
}

const NOT_FOUND = () => refusal("not_found",404,"Work not found in this session.");

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

/** A handoff handle lives this long (the design: 24 hours). */
export const HANDOFF_TTL_MS = 24 * 60 * 60_000;
const hashHandle = (handle: string) => createHash("sha256").update(handle).digest("hex");
/** One neutral refusal for every handle that does not work: unknown, used, expired, another account or computer. */
const HANDOFF_INVALID = () => refusal("handoff_invalid",409,"This handoff handle is not valid here. Start with a goal instead: relo work start --goal \"…\".");

/**
 * `start --from <handle>`: take over the work another session of this computer handed off. The handle is
 * checked (hash, unused, unexpired, same account, same computer credential); then, in one transaction, the
 * caller's own open work is parked, the work moves to the caller (its card follows), and the handle is spent.
 */
async function takeOverWork(query: Queryable,owner: SessionOwner,input: WorkStartRequest,handle: string): Promise<WorkOutcome & { rollback?: boolean }> {
  const handoff = await lockHandoffByHash(query,owner.principalId,hashHandle(handle));
  if (!handoff || handoff.credential_id !== owner.credentialId) return { ...HANDOFF_INVALID(),rollback: true };
  const work = await lockAccountWork(query,owner.principalId,handoff.work_id);
  if (!work) return { ...HANDOFF_INVALID(),rollback: true };
  if (handoff.used_at) {
    // A queued start replayed by the same session that took over answers the first result; nobody else gets in.
    if (work.session_key === owner.sessionKey && work.lifecycle === "open") {
      return { status: 200 as const,body: await response(query,owner,work,"taken_over",{ replayed: true }),changed: [] };
    }
    return { ...HANDOFF_INVALID(),rollback: true };
  }
  if (handoff.expires_at.getTime() <= Date.now()) return { ...HANDOFF_INVALID(),rollback: true };
  if (work.lifecycle === "finished" || work.lifecycle === "failed" || work.lifecycle === "dropped") {
    return { ...refusal("handoff_finished",409,`That work is ${work.lifecycle}; start a new goal with start --goal.`),rollback: true };
  }
  const changed: WorkRow[] = [];
  const own = await lockOpenSessionWork(query,owner);
  if (own && own.id !== work.id) {
    own.lifecycle = "paused";
    own.paused_reason = "parked";
    changed.push(await saveWork(query,own,{ declared: false }));
  }
  const moved = await moveWorkToSession(query,work.id,owner,owner.harness);
  await markHandoffUsed(query,handoff.id);
  const misfit = applyDeclared(moved,input,{ goal: false,plan: false });
  if (misfit) return { ...misfit,rollback: true };
  const saved = await saveWork(query,moved);
  changed.push(saved);
  return { status: 200 as const,body: await response(query,owner,saved,"taken_over",{ ignored: input.goal ? ["goal"] : [] }),changed };
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
    if (input.from) return takeOverWork(query,owner,input,input.from);
    const open = await lockOpenSessionWork(query,owner);
    const changed: WorkRow[] = [];
    let disposition: WorkDisposition = "started";
    if (open && !input.new && roundClosed(open)) {
      // Delivered: the owner's turn. The next round opens with --round; a new goal needs --new.
      if (!input.round) {
        return { ...refusal("round_required",409,"The last round is delivered. Open the next with start --round \"<what it is for>\" (and --plan for its steps), start --new for a different goal, or finish.",
          await sessionState(query,owner)),rollback: true };
      }
      const misfit = textFits(open,input.round,input.status);
      if (misfit) return { ...misfit,rollback: true };
      const title = "readable" in input.round ? input.round.readable : undefined;
      const steps = input.plan && (input.plan.op === "set" || input.plan.op === "add") ? input.plan.steps : undefined;
      const version = open.plan_version + 1;
      const opened = applyPlanCommand(open.plan ?? EMPTY_WORK_PLAN,{ op: "round",...(title !== undefined ? { title } : {}),...(steps ? { steps } : {}) },
        version,{ sealed: open.sealed_text,now: new Date().toISOString() });
      if (!opened.ok) return { ...refusal(opened.code,422,opened.message),rollback: true };
      open.plan = opened.plan;
      if (opened.structural) open.plan_version = version;
      const declared = applyDeclared(open,input,{ goal: false,plan: false });
      if (declared) return { ...declared,rollback: true };
      const saved = await saveWork(query,open);
      return { status: 200 as const,body: await response(query,owner,saved,"round_opened",{ ignored: input.goal ? ["goal"] : [] }),changed: [saved] };
    }
    if (open && !input.new) {
      const ignored = [input.goal ? "goal" : null,input.plan ? "plan" : null].filter((value): value is string => value !== null);
      const misfit = applyDeclared(open,input,{ goal: false,plan: false });
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
    if (!input.goal) return { ...refusal("invalid_request",400,"goal is required to start a work."),rollback: true };
    const goal = text(input.goal);
    const misfit = textFits({ sealed_text: goal.sealed },input.status);
    if (misfit) return { ...misfit,rollback: true };
    const draft = { sealed_text: goal.sealed,plan: EMPTY_WORK_PLAN,plan_version: 1,progress_n: null,progress_m: null } as unknown as WorkRow;
    if (input.plan) {
      const result = applyPlanCommand(EMPTY_WORK_PLAN,input.plan,1,{ sealed: goal.sealed,now: new Date().toISOString() });
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
async function workCommand(db: Database,owner: SessionOwner,target: Resolve,operation: "update" | "pause" | "resume" | "finish" | "deliver",
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
    if (roundClosed(work) && (input.goal || input.status || input.plan || input.progress !== undefined || input.waiting)) {
      return { refusal: refusal("round_closed",409,"The last round is delivered. Open the next with start --round \"<what it is for>\", or finish.") };
    }
    const misfit = applyDeclared(work,input,{ goal: true,plan: true });
    if (misfit) return { refusal: misfit };
    const saved = await saveWork(query,work);
    return { changed: [saved],work: saved,disposition: "updated" };
  });
}

export function pauseSessionWork(db: Database,owner: SessionOwner,target: Resolve,input: WorkPauseRequest,idempotencyKey?: string) {
  return workCommand(db,owner,target,"pause",input,idempotencyKey,async (query,work) => {
    if (work.lifecycle !== "open") return { refusal: refusal("not_open",409,"This work is already paused.",await sessionState(query,owner)) };
    const misfit = applyPauseStatus(work,input);
    if (misfit) return { refusal: misfit };
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

/**
 * Admin: the owner (or an agent the owner asked for help, through `relo admin`) ends any work of the account.
 * Open work that still moves stays its producer's: ending it would pull the card out from under a running
 * agent or script. Paused work, and open work the derivation shows as quiet, left open or delivered (hanging.ts,
 * the owner's End shares it), can be ended.
 */
export async function finishAccountWork(db: Database,principalId: string,workId: string,input: WorkFinishRequest)
  : Promise<WorkRefusal | { work: WorkRow }> {
  return inTransaction(db,async (query) => {
    const work = await lockAccountWork(query,principalId,workId);
    if (!work) return { ...refusal("not_found",404,"Work not found."),rollback: true };
    if (work.lifecycle === "finished" || work.lifecycle === "failed" || work.lifecycle === "dropped") {
      return { ...refusal("work_finished",409,`This work is already ${work.lifecycle}.`),rollback: true };
    }
    const live = await liveRefusal(query,work);
    if (live) return { ...live,rollback: true };
    const misfit = applyFinish(work,input);
    if (misfit) return { ...misfit,rollback: true };
    return { work: await saveWork(query,work) };
  });
}

/**
 * The owner's End (phone or Dashboard): the same hanging rule as admin finish, but the server chooses the result.
 * A delivered work (open, last round closed) finishes with its last round's outcome; anything else is dropped as
 * "Ended by you". A sealed work's outcome is text the server cannot write, so it stays absent (the phone words it).
 */
export async function endOwnerWork(db: Database,principalId: string,workId: string): Promise<WorkRefusal | { work: WorkRow }> {
  return inTransaction(db,async (query) => {
    const work = await lockAccountWork(query,principalId,workId);
    if (!work) return { ...refusal("not_found",404,"Work not found."),rollback: true };
    if (work.lifecycle === "finished" || work.lifecycle === "failed" || work.lifecycle === "dropped") {
      return { ...refusal("work_finished",409,`This work is already ${work.lifecycle}.`),rollback: true };
    }
    const live = await liveRefusal(query,work);
    if (live) return { ...live,rollback: true };
    const delivered = work.lifecycle === "open" && roundClosed(work);
    const readable = delivered ? lastRound(work.plan ?? EMPTY_WORK_PLAN).outcome ?? "Delivered" : WORK_ENDED_BY_OWNER_OUTCOME;
    const misfit = applyFinish(work,{ result: delivered ? "finished" : "dropped",outcome: work.sealed_text ? { sealed: true } : { readable } });
    if (misfit) return { ...misfit,rollback: true };
    return { work: await saveWork(query,work) };
  });
}

/** The request's sealed outcome notice (the routes already refused an invalid one). */
const sealedOutcomeOf = (input: unknown) => { const read = readSealedOutcome(input); return "sealed" in read ? read.sealed : null; };

export function finishSessionWork(db: Database,owner: SessionOwner,target: Resolve,input: WorkFinishRequest,idempotencyKey?: string,
  outcomes?: NotificationDependencies) {
  return workCommand(db,owner,target,"finish",input,idempotencyKey,async (tx,work) => {
    // The outcome replaces the last in-progress status (DOGFOOD #20), as finishing clears waiting.
    const misfit = applyFinish(work,input);
    if (misfit) return { refusal: misfit };
    const saved = await saveWork(tx,work);
    // The one outcome notification, in the same transaction: a retry (same work and round) makes no second.
    await recordWorkOutcome(tx as unknown as SubjectTransaction,saved,outcomeKindOf(saved)!,outcomes,sealedOutcomeOf(input));
    return { changed: [saved],work: saved,disposition: "finished" };
  });
}

/** Deliver: the open round closes with an outcome; the card ends as a final card, the work stays open for the owner's turn. */
export function deliverSessionWork(db: Database,owner: SessionOwner,target: Resolve,input: WorkDeliverRequest,idempotencyKey?: string,
  outcomes?: NotificationDependencies) {
  return workCommand(db,owner,target,"deliver",input,idempotencyKey,async (tx,work) => {
    if (work.lifecycle !== "open") return { refusal: refusal("not_open",409,"This work is paused; resume it first.",await sessionState(tx,owner)) };
    const misfit = applyDeliver(work,input);
    if (misfit) return { refusal: misfit };
    const saved = await saveWork(tx,work);
    await recordWorkOutcome(tx as unknown as SubjectTransaction,saved,"delivered",outcomes,sealedOutcomeOf(input));
    return { changed: [saved],work: saved,disposition: "delivered" };
  });
}

/**
 * Handoff: the open work stays open (and its round too: nothing is delivered), its status becomes the note, and
 * a single-use handle is returned once. Only its hash is kept; a new handoff replaces the old handle. No
 * notification: the card simply goes on. A replay issues a fresh handle (the earlier one stops working).
 */
export async function handoffSessionWork(db: Database,owner: SessionOwner,target: Resolve,input: WorkHandoffRequest)
  : Promise<WorkOutcome & { handoff?: WorkHandoffResponse["handoff"] }> {
  return inTransaction(db,async (query) => {
    const work = await resolveTarget(query,owner,target);
    if (!work) {
      if (target.workId === "current") return { ...refusal("not_open",409,"This session has no open work.",await sessionState(query,owner)),rollback: true };
      return { ...NOT_FOUND(),rollback: true };
    }
    if (work.lifecycle === "finished" || work.lifecycle === "failed" || work.lifecycle === "dropped") {
      return { ...refusal("work_finished",409,`This work is ${work.lifecycle}; start a new goal with start.`,{ work: serializeWork(work,null) }),rollback: true };
    }
    if (work.lifecycle !== "open") return { ...refusal("not_open",409,"This work is paused; resume it first.",await sessionState(query,owner)),rollback: true };
    if (roundClosed(work)) {
      return { ...refusal("round_closed",409,"The last round is delivered, so there is nothing to hand off. Open the next with start --round, or finish."),rollback: true };
    }
    const misfit = textFits(work,input.next);
    if (misfit) return { ...misfit,rollback: true };
    work.status = text(input.next).value;
    if (input.sealed) work.sealed = input.sealed;
    if (input.producerSealed) work.producer_sealed = input.producerSealed;
    const saved = await saveWork(query,work);
    const handle = `rh_${randomBytes(24).toString("base64url")}`;
    const row = await replaceHandoff(query,{ workId: saved.id,principalId: owner.principalId,credentialId: owner.credentialId,
      handleHash: hashHandle(handle),ttlMs: HANDOFF_TTL_MS });
    return { status: 200 as const,body: await response(query,owner,saved,"handed_off"),changed: [saved],
      handoff: { handle,expiresAt: row.expires_at.toISOString() } };
  });
}

export async function readSessionState(db: Database,owner: SessionOwner) {
  const live = await readSessionLiveWorks(db,owner);
  const works = await Promise.all(live.map(async (row) => serializeWork(row,await activeCardFor(db,row.id))));
  return { open: works.find((work) => work.lifecycle === "open") ?? null,parked: works.filter((work) => work.lifecycle === "paused") };
}
