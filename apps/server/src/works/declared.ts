import {
  applyPlanCommand,closePlan,EMPTY_WORK_PLAN,lastRound,openRound,setCurrentStepProgress,
  type DeclaredText,type PlanCommand,type WorkDeliverRequest,type WorkFinishRequest,type WorkRefusalCode,type WorkUpdateRequest,
} from "@relo/notification-contracts";
import type { WorkRow } from "./store.js";

/**
 * The declared fields of a work, applied the same way for every producer type (ADR 0008: one shared core,
 * narrow typed inputs). Session, script and service routes keep their own identity, scoping, idempotency and
 * leases; what a producer declares (goal, status, plan, progress, waiting, outcome, sealed envelopes) lands
 * through these functions only. A sealed work never stores readable text; a readable work never takes sealed text.
 */
export type WorkRefusal = { error: WorkRefusalCode; status: 400 | 404 | 409 | 422; message: string; state?: unknown };

export function refusal(error: WorkRefusalCode,status: WorkRefusal["status"],message: string,state?: unknown): WorkRefusal {
  return { error,status,message,...(state !== undefined ? { state } : {}) };
}

export type Text = { value: string | null; sealed: boolean };
export const text = (declared: DeclaredText): Text => "sealed" in declared ? { value: null,sealed: true } : { value: declared.readable,sealed: false };

export function textFits(work: { sealed_text: boolean },...values: Array<DeclaredText | undefined>): WorkRefusal | null {
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

/** Whether a declared write carries readable text (refused on an account that requires end-to-end encryption). */
export function carriesReadable(input: Record<string,unknown>): boolean {
  return ["goal","status","outcome","next"].some((key) => typeof (input[key] as { readable?: string } | undefined)?.readable === "string")
    || typeof (input.waiting as { reason?: { readable?: string } } | null | undefined)?.reason?.readable === "string";
}

export function applyPlan(work: WorkRow,command: PlanCommand | undefined): WorkRefusal | null {
  if (!command) return null;
  const nextVersion = work.plan_version + 1;
  const result = applyPlanCommand(work.plan ?? EMPTY_WORK_PLAN,command,nextVersion,{ sealed: work.sealed_text,now: new Date().toISOString() });
  if (!result.ok) return refusal(result.code,422,result.message);
  work.plan = result.plan;
  if (result.structural) work.plan_version = nextVersion;
  return null;
}

/** An open work whose last round is closed (delivered): it waits for the owner and takes no plan or status writes. */
export const roundClosed = (work: Pick<WorkRow,"plan">): boolean => lastRound(work.plan ?? EMPTY_WORK_PLAN).state === "closed";

/** Counted progress lands on the current step when the work has a plan (and any work-level count is dropped), else on the work. */
export function applyProgress(work: WorkRow,progress: { done: number; total: number } | null | undefined): void {
  if (progress === undefined) return;
  const plan = work.plan ?? EMPTY_WORK_PLAN;
  if (plan.steps.length) {
    const updated = setCurrentStepProgress(plan,progress);
    if (updated) { work.plan = updated; work.progress_n = null; work.progress_m = null; return; }
  }
  work.progress_n = progress?.done ?? null;
  work.progress_m = progress?.total ?? null;
}

/** The fields a start or update declares. `goal` and `plan` are off for a start that continues the open work. */
export type DeclaredChange = Pick<WorkUpdateRequest,"goal" | "status" | "plan" | "progress" | "waiting" | "context" | "sealed" | "producerSealed">;

export function applyDeclared(work: WorkRow,input: DeclaredChange,options: { goal: boolean; plan: boolean }): WorkRefusal | null {
  const misfit = textFits(work,options.goal ? input.goal : undefined,input.status,input.waiting ? input.waiting.reason : undefined);
  if (misfit) return misfit;
  if (options.goal && input.goal) work.goal = text(input.goal).value;
  if (input.status) work.status = text(input.status).value;
  if (options.plan) {
    const planRefusal = applyPlan(work,input.plan);
    if (planRefusal) return planRefusal;
  }
  applyProgress(work,input.progress);
  if (input.waiting !== undefined) {
    if (input.waiting === null) { work.waiting_reason = null; work.waiting_since = null; }
    else { work.waiting_reason = text(input.waiting.reason).value; work.waiting_since = work.waiting_since ?? new Date(); }
  }
  if (input.sealed) work.sealed = input.sealed;
  if (input.producerSealed) work.producer_sealed = input.producerSealed;
  // Declared context fields replace their old values (a renamed session's threadName); the rest stays.
  if (input.context) work.context = { ...(work.context ?? {}),...input.context };
  return null;
}

/** A pause's declared reason, with the card and self copy that carry it on a sealed work. */
export function applyPauseStatus(work: WorkRow,input: Pick<WorkUpdateRequest,"status" | "sealed" | "producerSealed">): WorkRefusal | null {
  if (!input.status) return null;
  const misfit = textFits(work,input.status);
  if (misfit) return misfit;
  work.status = text(input.status).value;
  if (input.sealed) work.sealed = input.sealed;
  if (input.producerSealed) work.producer_sealed = input.producerSealed;
  return null;
}

/** The finish itself: the outcome replaces the last status, waiting clears, open steps close. */
export function applyFinish(work: WorkRow,input: WorkFinishRequest): WorkRefusal | null {
  const misfit = textFits(work,input.outcome);
  if (misfit) return misfit;
  work.outcome = text(input.outcome).value;
  work.outcome_declared = true;
  work.status = null;
  work.lifecycle = input.result;
  work.paused_reason = null;
  work.finished_at = new Date();
  work.waiting_reason = null;
  work.waiting_since = null;
  work.plan = closePlan(work.plan ?? EMPTY_WORK_PLAN,input.result,work.finished_at.toISOString());
  if (input.sealed) work.sealed = input.sealed;
  return null;
}

/**
 * Deliver: the open round closes with its outcome (refused while top-level steps are open unless `dropRest`) (readable on the round; a sealed work's rides `sealed`), status
 * and waiting clear as in finish, and the work stays open and waits for the owner's next word.
 */
export function applyDeliver(work: WorkRow,input: WorkDeliverRequest): WorkRefusal | null {
  const misfit = textFits(work,input.outcome);
  if (misfit) return misfit;
  const plan = work.plan ?? EMPTY_WORK_PLAN;
  if (!openRound(plan)) return refusal("no_open_round",409,"This work has no open round to deliver; open the next with start --round, or finish it.");
  const outcome = text(input.outcome).value;
  const nextVersion = work.plan_version + 1;
  const result = applyPlanCommand(plan,{ op: "close",...(outcome !== null ? { outcome } : {}),...(input.dropRest ? { dropRest: true } : {}) },nextVersion,
    { sealed: work.sealed_text,now: new Date().toISOString() });
  if (!result.ok) {
    return refusal(result.code,422,result.code === "open_steps"
      ? `${result.message}. Deliver means this request is done. If the owner must act mid-plan: relo ask or relo work update --waiting; this request is done: relo work deliver --drop-rest (an older relo: relo work update --plan "<the steps left>" and deliver again, or run relo update).`
      : result.message);
  }
  work.plan = result.plan;
  if (result.structural) work.plan_version = nextVersion;
  work.status = null;
  work.waiting_reason = null;
  work.waiting_since = null;
  if (input.sealed) work.sealed = input.sealed;
  if (input.producerSealed) work.producer_sealed = input.producerSealed;
  return null;
}
