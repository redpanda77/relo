import { z } from "zod";
import type { WorkLifecycle } from "./owner-state.js";

/**
 * Works (STATE-SPEC v2 slice 2): declared state of one producer's goal. Cards are views of works.
 * This module holds the wire contract and the pure plan rules shared by the server and Dashboard.
 */

export const WORK_PLAN_MAX_STEPS = 30;
export const WORK_LABEL_MAX = 80;
export const WORK_GOAL_MAX = 120;
export const WORK_STATUS_MAX = 120;
export const WORK_OUTCOME_MAX = 200;
export const WORK_WAITING_MAX = 60;

export const WORK_RESULTS = ["finished","failed","dropped"] as const;
export type WorkResult = typeof WORK_RESULTS[number];
export const STEP_STATES = ["open","current","done","skipped"] as const;
export type StepState = typeof STEP_STATES[number];
export const WORK_DISPOSITIONS = ["started","continuing","switched","updated","paused","resumed","finished"] as const;
export type WorkDisposition = typeof WORK_DISPOSITIONS[number];

export const stepIdSchema = z.string().regex(/^s[1-9][0-9]{0,2}$/);
const labelSchema = z.string().trim().min(1).max(WORK_LABEL_MAX);
export const stepProgressSchema = z.object({ done: z.number().int().min(0),total: z.number().int().min(1) }).strict()
  .refine((value) => value.done <= value.total,"done cannot exceed total");
export type StepProgress = z.infer<typeof stepProgressSchema>;

export const planStepSchema = z.object({
  id: stepIdSchema,
  state: z.enum(STEP_STATES),
  addedIn: z.number().int().positive(),
  label: labelSchema.optional(),
  progress: stepProgressSchema.optional(),
}).strict();
export type PlanStep = z.infer<typeof planStepSchema>;

export const workPlanSchema = z.object({
  v: z.literal(1),
  next: z.number().int().positive(),
  steps: z.array(planStepSchema).max(WORK_PLAN_MAX_STEPS),
}).strict().superRefine((plan,context) => {
  if (plan.steps.filter((step) => step.state === "current").length > 1) context.addIssue({ code: "custom",message: "at most one current step" });
  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (ids.has(step.id)) context.addIssue({ code: "custom",message: `duplicate step id ${step.id}` });
    ids.add(step.id);
    if (Number(step.id.slice(1)) >= plan.next) context.addIssue({ code: "custom",message: `step id ${step.id} not below next` });
  }
});
export type WorkPlan = z.infer<typeof workPlanSchema>;
export const EMPTY_WORK_PLAN: WorkPlan = { v: 1,next: 1,steps: [] };

const planEntrySchema = z.object({ id: stepIdSchema.optional(),label: labelSchema.optional() }).strict();
export const planCommandSchema = z.discriminatedUnion("op",[
  z.object({ op: z.literal("set"),steps: z.array(planEntrySchema).min(1).max(WORK_PLAN_MAX_STEPS) }).strict(),
  z.object({ op: z.literal("add"),steps: z.array(planEntrySchema).min(1).max(20) }).strict(),
  z.object({ op: z.literal("next") }).strict(),
  z.object({ op: z.literal("step"),id: stepIdSchema }).strict(),
  z.object({ op: z.literal("revise"),labels: z.array(labelSchema).min(1).max(WORK_PLAN_MAX_STEPS) }).strict(),
]);
export type PlanCommand = z.infer<typeof planCommandSchema>;

/** Readable text, or the fact that sealed text carries it (the server never sees it). */
export const declaredTextSchema = (max: number) => z.union([
  z.object({ readable: z.string().trim().min(1).max(max) }).strict(),
  z.object({ sealed: z.literal(true) }).strict(),
]);
export type DeclaredText = { readable: string } | { sealed: true };

export const workProgressSchema = z.object({ done: z.number().int().min(0),total: z.number().int().min(1).max(1_000_000) }).strict()
  .refine((value) => value.done <= value.total,"done cannot exceed total");

const sealedObject = z.record(z.string(),z.unknown());

export const workStartRequestSchema = z.object({
  goal: declaredTextSchema(WORK_GOAL_MAX),
  status: declaredTextSchema(WORK_STATUS_MAX).optional(),
  plan: planCommandSchema.optional(),
  progress: workProgressSchema.optional(),
  new: z.boolean().optional(),
  context: z.record(z.string(),z.unknown()).optional(),
  sealed: sealedObject.optional(),
  producerSealed: sealedObject.optional(),
}).strict();
export type WorkStartRequest = z.infer<typeof workStartRequestSchema>;

export const workUpdateRequestSchema = z.object({
  baseVersion: z.number().int().positive().optional(),
  goal: declaredTextSchema(WORK_GOAL_MAX).optional(),
  status: declaredTextSchema(WORK_STATUS_MAX).optional(),
  plan: planCommandSchema.optional(),
  /** Counted progress: on the current step when the work has a plan, else on the work. */
  progress: workProgressSchema.nullable().optional(),
  waiting: z.object({ reason: declaredTextSchema(WORK_WAITING_MAX) }).strict().nullable().optional(),
  /** Context fields to replace, e.g. the session's new name as `threadName` (merged into the work's context). */
  context: z.record(z.string(),z.unknown()).optional(),
  sealed: sealedObject.optional(),
  producerSealed: sealedObject.optional(),
}).strict();
export type WorkUpdateRequest = z.infer<typeof workUpdateRequestSchema>;

export const workPauseRequestSchema = z.object({
  status: declaredTextSchema(WORK_STATUS_MAX),
  sealed: sealedObject.optional(),
  producerSealed: sealedObject.optional(),
}).strict();
export type WorkPauseRequest = z.infer<typeof workPauseRequestSchema>;

export const workResumeRequestSchema = z.object({}).strict();

export const workFinishRequestSchema = z.object({
  result: z.enum(WORK_RESULTS),
  outcome: declaredTextSchema(WORK_OUTCOME_MAX),
  sealed: sealedObject.optional(),
}).strict();
export type WorkFinishRequest = z.infer<typeof workFinishRequestSchema>;

export type WorkSummary = {
  id: string;
  lifecycle: WorkLifecycle;
  pausedReason: "declared" | "parked" | null;
  version: number;
  sealed: boolean;
  goal: string | null;
  status: string | null;
  outcome: string | null;
  waiting: { reason: string | null; since: string } | null;
  plan: { version: number; next: number; complete: boolean; steps: PlanStep[] };
  progress: { done: number; total: number } | null;
  startedAt: string;
  declaredAt: string;
  finishedAt: string | null;
  card: { id: string; state: string } | null;
  producerSealed?: unknown;
};

export type WorkResponse = {
  work: WorkSummary;
  disposition: WorkDisposition;
  replayed: boolean;
  ignored: string[];
  parked: Array<Pick<WorkSummary,"id" | "lifecycle" | "pausedReason" | "sealed" | "goal">>;
};

export const WORK_REFUSAL_CODES = [
  "not_found","not_open","work_finished","version_conflict","outcome_required","text_refused","plan_too_long",
  "plan_ids_invalid","step_not_found","labels_sealed","idempotency_key_required","idempotency_conflict",
  "end_to_end_required","session_key_required","owner_only","plan_invalid","invalid_request",
] as const;
export type WorkRefusalCode = typeof WORK_REFUSAL_CODES[number];

// ---------------------------------------------------------------------------------------------
// Pure plan rules. Ids come from `next` and are never reused; steps are never deleted (unlisted
// open steps become skipped); at most one current; new steps never land before the current one.

export type PlanResult =
  | { ok: true; plan: WorkPlan; structural: boolean; complete: boolean }
  | { ok: false; code: "plan_too_long" | "plan_ids_invalid" | "step_not_found" | "labels_sealed" | "plan_invalid"; message: string };

const stepNumber = (id: string) => Number(id.slice(1));

function refuse(code: Extract<PlanResult,{ ok: false }>["code"],message: string): PlanResult {
  return { ok: false,code,message };
}

function finalize(plan: WorkPlan,before: WorkPlan): PlanResult {
  if (plan.steps.length > WORK_PLAN_MAX_STEPS) {
    return refuse("plan_too_long",`A plan holds at most ${WORK_PLAN_MAX_STEPS} steps (this one would hold ${plan.steps.length}).`);
  }
  if (!plan.steps.some((step) => step.state === "current")) {
    const first = plan.steps.find((step) => step.state === "open");
    if (first) first.state = "current";
  }
  const checked = workPlanSchema.safeParse(plan);
  if (!checked.success) return refuse("plan_invalid",checked.error.issues.map((issue) => issue.message).join("; "));
  const structure = (value: WorkPlan) => JSON.stringify(value.steps.map((step) => [step.id,step.state]));
  return { ok: true,plan,structural: structure(plan) !== structure(before),complete: planComplete(plan) };
}

export function planComplete(plan: WorkPlan): boolean {
  return plan.steps.length > 0 && !plan.steps.some((step) => step.state === "open" || step.state === "current");
}

function clonePlan(plan: WorkPlan): WorkPlan {
  return { v: 1,next: plan.next,steps: plan.steps.map((step) => ({ ...step,...(step.progress ? { progress: { ...step.progress } } : {}) })) };
}

/** Assigns ids to new entries; a sealed entry carries the id the client predicted from `next`. */
function newSteps(plan: WorkPlan,entries: Array<{ id?: string | undefined; label?: string | undefined }>,version: number,sealed: boolean)
  : PlanStep[] | PlanResult {
  const created: PlanStep[] = [];
  for (const entry of entries) {
    const id = `s${plan.next}`;
    if (entry.id !== undefined && entry.id !== id) {
      return refuse("plan_ids_invalid",`New step id ${entry.id} does not match the next id ${id}.`);
    }
    if (sealed && entry.label !== undefined) return refuse("labels_sealed","A sealed work carries no readable step labels.");
    plan.next += 1;
    created.push({ id,state: "open",addedIn: version,...(entry.label !== undefined ? { label: entry.label } : {}) });
  }
  return created;
}

export function applyPlanCommand(current: WorkPlan,command: PlanCommand,version: number,options: { sealed: boolean }): PlanResult {
  const before = clonePlan(current);
  const plan = clonePlan(current);
  switch (command.op) {
  case "set": {
    const byId = new Map(plan.steps.map((step) => [step.id,step]));
    const listed: PlanStep[] = [];
    const pendingNew: Array<{ id?: string | undefined; label?: string | undefined }> = [];
    const seen = new Set<string>();
    for (const entry of command.steps) {
      const existing = entry.id !== undefined ? byId.get(entry.id) : undefined;
      if (existing) {
        if (seen.has(existing.id)) return refuse("plan_ids_invalid",`Step ${existing.id} is listed twice.`);
        seen.add(existing.id);
        if (entry.label !== undefined) {
          if (options.sealed) return refuse("labels_sealed","A sealed work carries no readable step labels.");
          existing.label = entry.label;
        }
        if (existing.state === "skipped") existing.state = "open";
        listed.push(existing);
      } else {
        const made = newSteps(plan,[entry],version,options.sealed);
        if (!Array.isArray(made)) return made;
        listed.push(...made);
        pendingNew.push(entry);
      }
    }
    const done = plan.steps.filter((step) => step.state === "done" && !seen.has(step.id));
    const unlisted = plan.steps.filter((step) => step.state !== "done" && !seen.has(step.id))
      .map((step) => ({ ...step,state: "skipped" as const }));
    // Done steps stay listed first; the remaining order follows the command; unlisted become skipped.
    const remaining = listed.filter((step) => step.state !== "done");
    const listedDone = listed.filter((step) => step.state === "done");
    const currentIndex = remaining.findIndex((step) => step.state === "current");
    if (currentIndex > 0 && remaining.slice(0,currentIndex).some((step) => step.addedIn === version && !byId.has(step.id))) {
      return refuse("plan_ids_invalid","New steps cannot land before the current step.");
    }
    plan.steps = [...done,...listedDone,...remaining,...unlisted];
    return finalize(plan,before);
  }
  case "add": {
    const made = newSteps(plan,command.steps,version,options.sealed);
    if (!Array.isArray(made)) return made;
    plan.steps.push(...made);
    return finalize(plan,before);
  }
  case "next": {
    const current = plan.steps.find((step) => step.state === "current");
    if (current) current.state = "done";
    const following = plan.steps.find((step) => step.state === "open");
    if (following) following.state = "current";
    return finalize(plan,before);
  }
  case "step": {
    const target = plan.steps.find((step) => step.id === command.id);
    if (!target) return refuse("step_not_found",`Step ${command.id} is not in this plan (${plan.steps.map((step) => step.id).join(", ") || "no steps"}).`);
    if (target.state === "current") return finalize(plan,before);
    const current = plan.steps.find((step) => step.state === "current");
    if (current) current.state = "done";
    target.state = "current";
    return finalize(plan,before);
  }
  case "revise": {
    if (options.sealed) return refuse("labels_sealed","A sealed work's labels are matched by the client; send set.");
    return applyPlanCommand(current,revisePlanByLabels(current,command.labels),version,options);
  }
  }
}

/** Matches labels to existing steps (done steps excluded) and turns them into a `set` command. */
export function revisePlanByLabels(plan: WorkPlan,labels: string[]): PlanCommand {
  const available = plan.steps.filter((step) => step.state !== "done");
  const used = new Set<string>();
  const steps = labels.map((label) => {
    const match = available.find((step) => !used.has(step.id) && step.label?.toLowerCase() === label.toLowerCase());
    if (match) { used.add(match.id); return { id: match.id }; }
    return { label };
  });
  return { op: "set",steps };
}

/** Finishing marks every open or current step skipped (spec 3.3), current counts as done on success. */
export function closePlan(current: WorkPlan,result: WorkResult): WorkPlan {
  const plan = clonePlan(current);
  for (const step of plan.steps) {
    if (step.state === "current") step.state = result === "finished" ? "done" : "skipped";
    else if (step.state === "open") step.state = "skipped";
  }
  return plan;
}

export function setCurrentStepProgress(current: WorkPlan,progress: StepProgress | null): WorkPlan | null {
  const plan = clonePlan(current);
  const step = plan.steps.find((candidate) => candidate.state === "current");
  if (!step) return null;
  if (progress) step.progress = progress;
  else delete step.progress;
  return plan;
}

export { stepNumber as workStepNumber };
