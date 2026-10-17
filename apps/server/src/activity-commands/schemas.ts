import { sealedNoticeSchema } from "../sealed-content.js";
import { callbackUrlSchema } from "../callback-destinations.js";
import { FACTS,agentLifecycleIdentitySchema,LIVE_ACTIVITY_REQUEST_PRESETS,liveActivityPresentationSchema,planProgressWireSchema } from "@relo/notification-contracts";
import { z } from "zod";
import { originDescriptorSchema } from "../origin-slots.js";
import {
  checkQuestionAnswers,choiceOptionsSchema,QUESTION_MAX_CHARACTERS,questionDetailSchema,questionExpirySchema,
  questionPromptMessage,questionTypeSchema,
} from "../question-policy.js";

export const liveActivityStyles = [
  "standard", "ring", "hero", "terminal", "steps",
  "approval", "shell", "verdict", "signal",
] as const;
export const taskLiveActivityStyles = ["standard", "ring", "hero", "terminal", "steps"] as const;
export const activityPrivacyModes = ["standard", "private"] as const;
export const liveActivitySymbols = ["terminal", "code", "build", "success", "warning"] as const;
const accentColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const DEFAULT_EXPIRES_IN_SECONDS = FACTS.card.maxSeconds;
const DEFAULT_STALE_AFTER_SECONDS = 14_400;


const contextSchema = z.object({
  providerName: z.string().trim().min(1).max(80).optional().describe("Name of the tool or product doing the work, shown as the source."),
  producerKind: z.enum(["agent","service","webhook","manual"]).optional().describe("What kind of sender this is: an agent, a service, a webhook or a manual action."),
  computer: z.string().trim().min(1).max(120).optional().describe("Name of the machine the work runs on."),
  account: z.string().trim().min(1).max(40).optional().describe("Name of the account the work runs under."),
  project: z.string().trim().min(1).max(120).optional().describe("Name of the project the work belongs to."),
  providerThreadId: z.string().trim().min(1).max(200).optional().describe("The sender's own id for the conversation or thread, used to group items from one thread."),
  providerWorkItemId: z.string().trim().min(1).max(200).optional().describe("The sender's own id for the task or work item."),
  threadName: z.string().trim().min(1).max(160).optional().describe("Human-readable name of the thread."),
  taskTitle: z.string().trim().min(1).max(160).optional().describe("Human-readable title of the task."),
  threadNameSource: z.enum(["provider","explicit","fallback"]).optional().describe("Where threadName came from: the provider, set explicitly, or a fallback."),
  taskTitleSource: z.enum(["provider","prompt_summary","explicit","fallback"]).optional().describe("Where taskTitle came from: the provider, a summary of the prompt, set explicitly, or a fallback."),
}).strict();

const semanticStepsSchema = z.object({
  labels: z.array(z.string().trim().min(1).max(40)).min(1).max(8).describe("Labels of the steps shown on the card, in order."),
  current: z.number().int().min(1).max(8).describe("Which of the given labels is in progress, counting from the first."),
  /** Steps of a longer plan hidden before (done) and after (not started) these labels. */
  before: z.number().int().min(1).max(99).optional().describe("How many earlier steps of a longer plan are hidden before these labels; they count as done."),
  after: z.number().int().min(1).max(99).optional().describe("How many later steps of a longer plan are hidden after these labels; they count as not started."),
  plan: planProgressWireSchema.optional().describe("Where the work stands in its plan: steps done of total, the current step, its substeps, and the round (plan UX U1, U2)."),
}).strict().superRefine((value,context) => {
  if (value.current > value.labels.length) {
    context.addIssue({ code: "custom",path: ["current"],message: "Current step must reference a supplied label" });
  }
});

export const activityStartSchema = z.object({
  occurredAt: z.iso.datetime({ offset: true }).optional().describe("When the change originally happened, if it is sent later than the event."),
  key: z.string().trim().min(1).max(100).optional().describe("Your own name for the card; starting again with the same key continues that card."),
  replace: z.boolean().default(false).describe("Whether to end a card already running under this key and put this one in its place."),
  acquireMode: z.enum(["start","ensure"]).optional().describe("Whether to always start a card (start) or reuse the running card for the same origin when there is one (ensure)."),
  title: z.string().trim().min(1).max(80).optional().describe("Short heading of the card."),
  status: z.string().trim().min(1).max(60).optional().describe("One line saying what is happening now."),
  detail: z.string().trim().min(1).max(240).optional().describe("Longer text shown under the status."),
  progress: z.number().min(0).max(1).optional().describe("How far along the work is, as a fraction of the whole."),
  symbol: z.enum(liveActivitySymbols).optional().describe("Icon shown on the card."),
  progressLabel: z.string().trim().min(1).max(32).optional().describe("Short text shown beside the progress, such as a count."),
  steps: semanticStepsSchema.optional().describe("A short row of labelled steps with the current one marked."),
  style: z.enum(taskLiveActivityStyles).optional().describe("Layout of the card on the Lock Screen."),
  preset: z.enum(LIVE_ACTIVITY_REQUEST_PRESETS).optional().describe("Named appearance preset for the card."),
  theme: z.enum(["system", "light", "dark"]).optional().describe("Color theme of the card."),
  accentColor: accentColorSchema.optional().describe("Accent color of the card as a six-digit hex value such as #1A73E8."),
  privacy: z.enum(activityPrivacyModes).optional().describe("Whether the card shows its text on the Lock Screen (standard) or keeps it out of view (private)."),
  deviceIds: z.array(z.string()).min(1).max(50).optional().describe("Phones to show the card on; every paired phone when omitted."),
  context: contextSchema.optional().describe("Where the work runs and what it belongs to, shown with the card."),
  origin: originDescriptorSchema.optional().describe("Identifies where the work comes from, so its card can be found again."),
  lifecycle: agentLifecycleIdentitySchema.optional().describe("Identity of the agent session that owns the card, used to find, update and end it."),
  expiresInSeconds: z.number().int().min(60).max(FACTS.card.maxSeconds).default(DEFAULT_EXPIRES_IN_SECONDS).describe("How long the card may stay on screen, counted from now."),
  staleAfterSeconds: z.number().int().min(0).max(FACTS.card.maxSeconds).default(DEFAULT_STALE_AFTER_SECONDS).describe("How long without an update before the card is shown as stale."),
  presentation: liveActivityPresentationSchema.optional().describe("A complete presentation record to show instead of the separate title, status and similar fields; the two cannot be combined."),
  /** End-to-end sealed card text (E5); the readable fields carry placeholders. */
  sealed: sealedNoticeSchema.optional().describe("End-to-end sealed card text; the readable fields then carry placeholders."),
}).strict().superRefine((value,context) => {
  if (value.lifecycle !== undefined && value.origin === undefined) {
    context.addIssue({ code: "custom",path: ["origin"],message: "Lifecycle acquisition requires an origin" });
  }
  if (!value.presentation && (!value.title || !value.status)) {
    context.addIssue({ code: "custom",message: "Semantic input requires title and status" });
  }
  if (value.presentation) {
    for (const key of ["title","status","detail","progress","progressLabel","steps"] as const) {
      if (value[key] !== undefined) {
        context.addIssue({ code: "custom",path: [key],message: "An explicit presentation uses the complete presentation record" });
      }
    }
  }
});

export const activityResolveSchema = z.object({
  origin: originDescriptorSchema.optional().describe("Find the card started from this origin."),
  lifecycle: agentLifecycleIdentitySchema.optional().describe("Find the card owned by this agent session identity."),
  current: z.literal(true).optional().describe("Find the calling session's current card."),
}).strict().superRefine((value,context) => {
  const selectors = [value.origin,value.lifecycle,value.current].filter((part) => part !== undefined);
  if (selectors.length !== 1) {
    context.addIssue({ code: "custom",message: "Provide exactly one lifecycle resolver" });
  }
});

export const activityUpdateSchema = z.object({
  occurredAt: z.iso.datetime({ offset: true }).optional().describe("When the change originally happened, if it is sent later than the event. Requires ifSequence."),
  title: z.string().trim().min(1).max(80).optional().describe("Short heading of the card."),
  status: z.string().trim().min(1).max(60).optional().describe("One line saying what is happening now."),
  detail: z.string().trim().min(1).max(240).nullable().optional().describe("Longer text shown under the status. Null clears it."),
  progress: z.number().min(0).max(1).nullable().optional().describe("How far along the work is, as a fraction of the whole. Null clears it."),
  progressLabel: z.string().trim().min(1).max(32).nullable().optional().describe("Short text shown beside the progress, such as a count. Null clears it."),
  steps: semanticStepsSchema.optional().describe("A short row of labelled steps with the current one marked."),
  symbol: z.enum(liveActivitySymbols).optional().describe("Icon shown on the card."),
  accentColor: accentColorSchema.optional().describe("Accent color of the card as a six-digit hex value such as #1A73E8."),
  style: z.enum(taskLiveActivityStyles).optional().describe("Layout of the card on the Lock Screen."),
  staleAfterSeconds: z.number().int().min(0).max(FACTS.card.maxSeconds).optional().describe("How long without an update before the card is shown as stale."),
  deliveryPriority: z.literal(10).optional().describe("Delivery priority for the push; the only accepted value asks for immediate delivery."),
  context: contextSchema.optional().describe("Where the work runs and what it belongs to, shown with the card."),
  lifecycle: agentLifecycleIdentitySchema.optional().describe("Identity of the agent session that owns the card, used to find, update and end it."),
  ifSequence: z.number().int().min(0).optional().describe("Apply the change only if the card is at exactly this sequence; otherwise it is refused, so a stale writer cannot overwrite a newer change."),
  presentation: liveActivityPresentationSchema.optional().describe("A complete presentation record to show instead of the separate title, status and similar fields; the two cannot be combined."),
  /** End-to-end sealed card text (E5); the readable fields carry placeholders. */
  sealed: sealedNoticeSchema.optional().describe("End-to-end sealed card text; the readable fields then carry placeholders."),
}).strict().refine(
  (value) => Object.entries(value).some(([key,part]) => !["ifSequence","lifecycle","occurredAt"].includes(key) && part !== undefined),
  "At least one activity field is required",
).superRefine((value,context) => {
  if (value.occurredAt !== undefined && value.ifSequence === undefined) context.addIssue({ code: "custom",path: ["ifSequence"],message: "Original occurrence requires an exact sequence" });
  if (!value.presentation) return;
  for (const key of ["title","status","detail","progress","progressLabel","steps","symbol","accentColor","style"] as const) {
    if (value[key] !== undefined) {
      context.addIssue({ code: "custom",path: [key],message: "An explicit presentation replaces the complete presentation record" });
    }
  }
});

export const activityHeartbeatSchema = z.object({
  lifecycle: agentLifecycleIdentitySchema.describe("Identity of the agent session whose card to keep alive."),
  leaseAfterSeconds: z.number().int().min(300).max(14_400).default(3_600).describe("How long the card stays alive without another heartbeat."),
}).strict();

export const activityEndSchema = z.object({
  occurredAt: z.iso.datetime({ offset: true }).optional().describe("When the change originally happened, if it is sent later than the event. Requires ifSequence."),
  status: z.string().trim().min(1).max(60).optional().describe("Final line shown on the ended card."),
  detail: z.string().trim().min(1).max(240).nullable().optional().describe("Longer text shown under the status. Null clears it."),
  progress: z.number().min(0).max(1).nullable().optional().describe("How far along the work is, as a fraction of the whole. Null clears it."),
  symbol: z.enum(liveActivitySymbols).optional().describe("Icon shown on the card."),
  accentColor: accentColorSchema.optional().describe("Accent color of the card as a six-digit hex value such as #1A73E8."),
  plan: planProgressWireSchema.optional().describe("Where the work stood in its plan when the card ended (plan UX U1, U2)."),
  dismissAfterSeconds: z.number().int().min(0).max(14400).default(0).describe("How long the ended card stays on screen before it is removed."),
  ifSequence: z.number().int().min(0).optional().describe("Apply the end only if the card is at exactly this sequence; otherwise it is refused."),
  lifecycle: agentLifecycleIdentitySchema.optional().describe("Identity of the agent session that owns the card, used to find, update and end it."),
  presentation: liveActivityPresentationSchema.optional().describe("A complete presentation record for the ended card instead of the separate fields; the two cannot be combined."),
  /** End-to-end sealed card text (E5); the readable fields carry placeholders. */
  sealed: sealedNoticeSchema.optional().describe("End-to-end sealed card text; the readable fields then carry placeholders."),
}).strict().superRefine((value,context) => {
  if (value.occurredAt !== undefined && value.ifSequence === undefined) context.addIssue({ code: "custom",path: ["ifSequence"],message: "Original occurrence requires an exact sequence" });
  if (!value.presentation) return;
  for (const key of ["status","detail","progress","symbol","accentColor"] as const) {
    if (value[key] !== undefined) {
      context.addIssue({ code: "custom",path: [key],message: "An explicit presentation replaces the complete presentation record" });
    }
  }
});

const activityWaitLabelSchema = z.string().trim().min(1).max(24)
  .refine((value) => !/[\r\n]/.test(value),"Action labels must use one line");

export const activityWaitSchema = z.object({
  type: questionTypeSchema.describe("Kind of answer the question takes: approval, yes_no or choice."),
  prompt: z.string().trim().min(1).max(2_000).describe("The question shown to the owner."),
  options: choiceOptionsSchema.optional().describe("The answers to choose from when the type is choice."),
  detail: questionDetailSchema.optional().describe("Extra context shown with the question."),
  expiresInSeconds: questionExpirySchema.describe("How long the question waits for an answer before it expires."),
  primaryLabel: activityWaitLabelSchema.optional().describe("Text of the main answer button."),
  secondaryLabel: activityWaitLabelSchema.optional().describe("Text of the other answer button."),
  correlationId: z.string().trim().min(1).max(100).optional().describe("Your own id, returned with the answer so you can match it to the question."),
  callback: z.object({
    url: callbackUrlSchema.describe("Address Relo POSTs the answer to."),
    token: z.string().min(16).max(512).refine((value) => !/\s/.test(value),"Callback tokens cannot contain whitespace")
      .describe("Secret Relo sends back as a bearer token so the receiver can verify the call."),
  }).strict().optional().describe("Where Relo POSTs the answer once the owner responds."),
  /** End-to-end sealed prompt (E4.1); the server fills a placeholder prompt before parsing. */
  sealed: sealedNoticeSchema.optional().describe("End-to-end sealed prompt; the readable prompt then carries a placeholder."),
}).strict().superRefine((input,context) => {
  if (input.prompt.length > QUESTION_MAX_CHARACTERS || /[\r\n]/.test(input.prompt)) {
    context.addIssue({ code: "custom",path: ["prompt"],message: questionPromptMessage });
  }
  checkQuestionAnswers(input,context);
});

export const activityDeliverySummarySchema = z.object({
  eligibleDevices: z.number().int().min(0),
  durableCommands: z.number().int().min(0),
  apnsJobs: z.number().int().min(0),
}).strict();

export type ActivityDeliverySummary = z.infer<typeof activityDeliverySummarySchema>;
export type ApnsMode = "disabled" | "production" | "sandbox";
