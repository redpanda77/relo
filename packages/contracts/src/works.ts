import { z } from "zod";
import type { WorkLifecycle } from "./owner-state.js";
import {
  planProblems, WORK_PLAN_MAX_STEPS,
  type PlanCommand as EnginePlanCommand, type PlanEntry, type PlanProgressWire, type PlanRound, type PlanStep, type StepProgress, type StepState, type WorkPlan,
  type WorkResult,
} from "./plan-engine.js";

export * from "./plan-engine.js";

/**
 * Works (STATE-SPEC v2 slice 2): declared state of one producer's goal. Cards are views of works.
 * This module holds the wire contract and the pure plan rules shared by the server and Dashboard.
 */

export const WORK_DETAIL_MAX = 200;
export const WORK_LABEL_MAX = 80;
export const WORK_GOAL_MAX = 120;
export const WORK_STATUS_MAX = 120;
export const WORK_OUTCOME_MAX = 200;
export const WORK_WAITING_MAX = 60;

export const WORK_RESULTS = ["finished","failed","dropped"] as const;
export const STEP_STATES = ["open","current","done","skipped"] as const;
export const WORK_DISPOSITIONS = ["started","continuing","switched","updated","paused","resumed","finished","delivered","round_opened","handed_off","taken_over"] as const;
export type WorkDisposition = typeof WORK_DISPOSITIONS[number];

export const stepIdSchema = z.string().regex(/^s[1-9][0-9]{0,2}$/);
const labelSchema = z.string().trim().min(1).max(WORK_LABEL_MAX);
export const stepProgressSchema = z.object({ done: z.number().int().min(0),total: z.number().int().min(1) }).strict()
  .refine((value) => value.done <= value.total,"done cannot exceed total");

export const planStepSchema = z.object({
  id: stepIdSchema,
  state: z.enum(STEP_STATES),
  addedIn: z.number().int().positive(),
  label: labelSchema.optional(),
  progress: stepProgressSchema.optional(),
  /** The step this one belongs to: same round, earlier in `steps`. Only leaves do the work. */
  parent: stepIdSchema.optional(),
  /** The round the step belongs to; absent means 1. Set on new steps whenever the plan has a `rounds` array. */
  round: z.number().int().min(1).optional(),
  detail: z.string().trim().min(1).max(WORK_DETAIL_MAX).optional(),
  /** When the step became current / done or skipped (set by the engine when a write carries a clock). */
  startedAt: z.string().optional(),
  doneAt: z.string().optional(),
  /** Set when the round's close skipped this open leaf; the next round carries it. */
  dropped: z.boolean().optional(),
  /** The round whose unfinished step this one continues. */
  carriedFrom: z.number().int().min(1).optional(),
}).strict();

export const planRoundSchema = z.object({
  n: z.number().int().min(1),
  state: z.enum(["open","closed"]),
  title: labelSchema.optional(),
  outcome: z.string().trim().min(1).max(WORK_OUTCOME_MAX).optional(),
  openedAt: z.string().optional(),
  closedAt: z.string().optional(),
}).strict();

/** One step of a work's plan as clients read it (inbox activity, Now item). Labels are null for sealed or
 *  private work (devices open them by step id). Nested and multi-round plans carry the parent, the round
 *  (absent means 1) and the detail text. */
export const planDigestStepSchema = z.object({
  id: z.string().regex(/^s[1-9][0-9]{0,2}$/), state: z.enum(["open","current","done","skipped"]),
  label: z.string().refine(value => Array.from(value).length <= 120).nullable(),
  parent: z.string().regex(/^s[1-9][0-9]{0,2}$/).optional(),
  round: z.number().int().positive().optional(),
  detail: z.string().max(200).optional(),
  /** When the step became current and when it was done or skipped; the round a carried step continues. */
  startedAt: z.string().optional(), doneAt: z.string().optional(),
  carriedFrom: z.number().int().positive().optional(),
}).strict();
export type PlanDigestStep = z.infer<typeof planDigestStepSchema>;

/** One round of a work's plan as clients read it; title and outcome are absent for sealed or private work. */
export const planDigestRoundSchema = z.object({
  n: z.number().int().positive(), state: z.enum(["open","closed"]),
  title: z.string().max(80).optional(), outcome: z.string().max(200).optional(),
  openedAt: z.string().optional(), closedAt: z.string().optional(),
}).strict();
export type PlanDigestRound = z.infer<typeof planDigestRoundSchema>;

export const workPlanSchema = z.object({
  v: z.literal(1),
  next: z.number().int().positive(),
  steps: z.array(planStepSchema),
  /** Absent means one open round 1. Rounds are numbered 1..k; at most one is open and it is the last. */
  rounds: z.array(planRoundSchema).optional(),
}).strict().superRefine((plan,context) => {
  for (const message of planProblems(plan as WorkPlan)) context.addIssue({ code: "custom",message });
});

// The engine's hand-written types and these schemas must describe the same plan (a mismatch fails the build).
type Same<A,B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const planTypesMatch: [Same<z.infer<typeof planStepSchema>,PlanStep>,Same<z.infer<typeof planRoundSchema>,PlanRound>,Same<z.infer<typeof workPlanSchema>,WorkPlan>,Same<z.infer<typeof stepProgressSchema>,StepProgress>] = [true,true,true,true];
export const stepStateMatches: Same<typeof STEP_STATES[number],StepState> = true;
export const workResultMatches: Same<typeof WORK_RESULTS[number],WorkResult> = true;

const planEntrySchema: z.ZodType<PlanEntry> = z.lazy(() => z.object({
  id: stepIdSchema.optional().describe("Id of an existing step to keep; leave out for a new step."),
  label: labelSchema.optional().describe("What the step is, in a few words."),
  detail: z.string().trim().min(1).max(WORK_DETAIL_MAX).optional().describe("One or two sentences of detail for the step."),
  children: z.array(planEntrySchema).max(WORK_PLAN_MAX_STEPS).optional().describe("Sub-steps, in order; use only when a step cannot be finished in one go."),
}).strict());
export const planCommandSchema = z.discriminatedUnion("op",[
  z.object({
    op: z.literal("set").describe("Replaces the steps still to do in the open round with this list; done steps stay and unlisted ones are skipped."),
    steps: z.array(planEntrySchema).min(1).max(WORK_PLAN_MAX_STEPS).describe("The steps still to do, in order; entries may nest."),
  }).strict(),
  z.object({
    op: z.literal("add").describe("Appends steps to the end of the open round, as the last children of one step, or as siblings right after one step."),
    steps: z.array(planEntrySchema).min(1).max(20).describe("The steps to append, in order; entries may nest."),
    under: stepIdSchema.optional().describe("Id of the step the new steps go under; leave out to append at the end of the round."),
    after: stepIdSchema.optional().describe("Id of the step the new steps follow, as its siblings; not together with under."),
  }).strict(),
  z.object({ op: z.literal("next").describe("Marks the current step done and moves to the next open one.") }).strict(),
  z.object({
    op: z.literal("step").describe("Makes one step (a step without sub-steps) the current one; the previous current step counts as done."),
    id: stepIdSchema.describe("Id of the step to make current."),
  }).strict(),
  z.object({
    op: z.literal("revise").describe("Lists the steps still to do by label; labels that match an existing step keep it."),
    labels: z.array(labelSchema).min(1).max(WORK_PLAN_MAX_STEPS).describe("The labels of the steps still to do, in order."),
  }).strict(),
  z.object({
    op: z.literal("round").describe("Opens the next round of the work; the last round must be closed."),
    title: labelSchema.optional().describe("What the round is for, in a few words."),
    steps: z.array(planEntrySchema).max(WORK_PLAN_MAX_STEPS).optional().describe("The round's steps, in order; entries may nest. Without steps the round carries the unfinished steps of the one before."),
  }).strict(),
  z.object({
    op: z.literal("close").describe("Closes the open round: the current step counts as done; open steps are refused unless dropRest skips them."),
    outcome: z.string().trim().min(1).max(WORK_OUTCOME_MAX).optional().describe("What the round delivered, in a line."),
    dropRest: z.boolean().optional().describe("Close the round although steps are still open: they are skipped."),
  }).strict(),
  z.object({
    op: z.literal("detail").describe("Sets the detail text of a step; an empty text clears it."),
    id: stepIdSchema.optional().describe("Id of the step; leave out for the current step."),
    detail: z.string().trim().max(WORK_DETAIL_MAX).describe("The detail text."),
  }).strict(),
]);
export const planCommandTypesMatch: Same<z.infer<typeof planCommandSchema>,EnginePlanCommand> = true;

/** Readable text, or the fact that sealed text carries it (the server never sees it). */
export const declaredTextSchema = (max: number) => z.union([
  z.object({ readable: z.string().trim().min(1).max(max).describe("The text itself.") }).strict(),
  z.object({ sealed: z.literal(true).describe("True when the text travels in the sealed field instead.") }).strict(),
]);
export type DeclaredText = { readable: string } | { sealed: true };

/** Plan progress on a card and a Now item (plan UX U1, U2): the phone writes the plan line from it. */
export const planProgressWireSchema = z.object({
  done: z.number().int().min(0),
  total: z.number().int().min(0),
  currentId: stepIdSchema.nullable(),
  sub: z.object({ done: z.number().int().min(0),total: z.number().int().min(1) }).strict().nullable(),
  round: z.number().int().min(1),
  rounds: z.number().int().min(1),
  delivered: z.boolean(),
  // Optional: a service sending `plan`, and a card stored before these fields, omit them.
  current: z.number().int().min(1).nullable().optional(),
  fill: z.number().min(0).max(1).nullable().optional(),
  stepLabel: z.string().max(80).optional(),
  subLabel: z.string().max(80).optional(),
}).strict();
export const planProgressWireTypesMatch: Same<z.infer<typeof planProgressWireSchema>,PlanProgressWire> = true;

export const workProgressSchema = z.object({
  done: z.number().int().min(0).describe("How many units are finished."),
  total: z.number().int().min(1).max(1_000_000).describe("How many units there are in all."),
}).strict()
  .refine((value) => value.done <= value.total,"done cannot exceed total");

const sealedObject = z.record(z.string(),z.unknown());

export const workStartRequestSchema = z.object({
  goal: declaredTextSchema(WORK_GOAL_MAX).optional().describe("What the work is for, in the owner's words. Required unless `from` takes over a handed-off work."),
  status: declaredTextSchema(WORK_STATUS_MAX).optional().describe("One line saying what is happening now."),
  plan: planCommandSchema.optional().describe("A plan command that creates or changes the work's plan."),
  progress: workProgressSchema.optional().describe("Counted progress, on the current step when the work has a plan, else on the work."),
  round: declaredTextSchema(WORK_LABEL_MAX).optional().describe("Title of the next round, when the open work's last round is delivered."),
  from: z.string().trim().min(1).max(200).optional().describe("A handoff handle: take over the work another session of this computer handed off, instead of starting one."),
  new: z.boolean().optional().describe("Start a new work for a different goal instead of continuing the open one."),
  context: z.record(z.string(),z.unknown()).optional().describe("Context fields shown with the work, such as the session's name."),
  sealed: sealedObject.optional().describe("End-to-end sealed text of the work; readable fields are then omitted."),
  producerSealed: sealedObject.optional().describe("Sealed content kept for the producer itself; the server stores it without reading it."),
}).strict().refine((value) => value.goal !== undefined || value.from !== undefined,{ message: "goal is required unless from takes over a handed-off work",path: ["goal"] });
export type WorkStartRequest = z.infer<typeof workStartRequestSchema>;

export const workUpdateRequestSchema = z.object({
  baseVersion: z.number().int().positive().optional().describe("The work version this change builds on; refused as a conflict if the work has moved on since."),
  goal: declaredTextSchema(WORK_GOAL_MAX).optional().describe("New goal, when it changes."),
  status: declaredTextSchema(WORK_STATUS_MAX).optional().describe("One line saying what is happening now."),
  plan: planCommandSchema.optional().describe("A plan command that changes the work's plan."),
  /** Counted progress: on the current step when the work has a plan, else on the work. */
  progress: workProgressSchema.nullable().optional().describe("Counted progress, on the current step when the work has a plan, else on the work. Null clears it."),
  waiting: z.object({ reason: declaredTextSchema(WORK_WAITING_MAX).describe("What the work is waiting on.") }).strict().nullable().optional().describe("What the work is waiting on, such as CI or a review. Null means it is no longer waiting."),
  /** Context fields to replace, e.g. the session's new name as `threadName` (merged into the work's context). */
  context: z.record(z.string(),z.unknown()).optional().describe("Context fields to replace, merged into the work's context, such as the session's new name as threadName."),
  sealed: sealedObject.optional().describe("End-to-end sealed text of the work; readable fields are then omitted."),
  producerSealed: sealedObject.optional().describe("Sealed content kept for the producer itself; the server stores it without reading it."),
}).strict();
export type WorkUpdateRequest = z.infer<typeof workUpdateRequestSchema>;

export const workPauseRequestSchema = z.object({
  status: declaredTextSchema(WORK_STATUS_MAX).describe("Why the work is paused, in a line."),
  sealed: sealedObject.optional().describe("End-to-end sealed text; readable fields are then omitted."),
  producerSealed: sealedObject.optional().describe("Sealed content kept for the producer itself; the server stores it without reading it."),
}).strict();
export type WorkPauseRequest = z.infer<typeof workPauseRequestSchema>;

export const workResumeRequestSchema = z.object({}).strict();

export const workFinishRequestSchema = z.object({
  result: z.enum(WORK_RESULTS).describe("How the work ended: finished, failed or dropped."),
  outcome: declaredTextSchema(WORK_OUTCOME_MAX).describe("What happened, in the owner's words."),
  sealed: sealedObject.optional().describe("End-to-end sealed text of the outcome; readable fields are then omitted."),
  sealedOutcome: sealedObject.optional().describe("The outcome notification sealed to the owner's phones (kind notice: title and outcome); without it a sealed work's notification carries a placeholder."),
}).strict();
export type WorkFinishRequest = z.infer<typeof workFinishRequestSchema>;

/**
 * The owner ends a work from the phone or the Dashboard (12b-plan-ux 4.11). The body is empty: the server chooses the
 * result (a delivered work finishes with its last round's outcome, anything else is dropped as "Ended by you").
 */
export const workEndRequestSchema = z.object({}).strict();
export type WorkEndRequest = z.infer<typeof workEndRequestSchema>;
/** The ended work; refusals are `work_running` (409, still moving), `work_finished` (409) and `not_found` (404). */
export type WorkEndResponse = { work: WorkSummary };
/** The readable outcome of a work the owner ended without a delivered round. */
export const WORK_ENDED_BY_OWNER_OUTCOME = "Ended by you";

export const workDeliverRequestSchema = z.object({
  outcome: declaredTextSchema(WORK_OUTCOME_MAX).describe("What this round delivered, in the owner's words."),
  sealed: sealedObject.optional().describe("End-to-end sealed text of the outcome; readable fields are then omitted."),
  producerSealed: sealedObject.optional().describe("Sealed content kept for the producer itself; the server stores it without reading it."),
  sealedOutcome: sealedObject.optional().describe("The outcome notification sealed to the owner's phones (kind notice: title and outcome); without it a sealed work's notification carries a placeholder."),
  dropRest: z.boolean().optional().describe("Deliver although top-level steps are still open: they are skipped. Without it such a deliver is refused (open_steps)."),
}).strict();
export type WorkDeliverRequest = z.infer<typeof workDeliverRequestSchema>;

export const workHandoffRequestSchema = z.object({
  next: declaredTextSchema(WORK_STATUS_MAX).describe("The handoff note: what the next session should do, as the work's status line."),
  sealed: sealedObject.optional().describe("End-to-end sealed text of the note; readable fields are then omitted."),
  producerSealed: sealedObject.optional().describe("Sealed content kept for the producer itself; the server stores it without reading it."),
}).strict();
export type WorkHandoffRequest = z.infer<typeof workHandoffRequestSchema>;

/** The handoff response adds the single-use handle (shown once; the server keeps only its hash). */
export type WorkHandoffResponse = WorkResponse & { handoff: { handle: string; expiresAt: string } };

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
  plan: { version: number; next: number; complete: boolean; steps: PlanStep[]; rounds?: PlanRound[] };
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
  "end_to_end_required","session_key_required","owner_only","plan_invalid","invalid_request","work_running",
  "round_required","round_closed","no_open_round","plan_too_deep","round_open","handoff_invalid","handoff_finished","open_steps",
] as const;
export type WorkRefusalCode = typeof WORK_REFUSAL_CODES[number];

