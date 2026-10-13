import { sealedNoticeSchema } from "../sealed-content.js";
import { callbackUrlSchema } from "../callback-destinations.js";
import { agentLifecycleIdentitySchema,LIVE_ACTIVITY_PRESENTATION_PRESETS,liveActivityPresentationSchema } from "@relo/notification-contracts";
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
const DEFAULT_EXPIRES_IN_SECONDS = 28_800;
const DEFAULT_STALE_AFTER_SECONDS = 14_400;


const contextSchema = z.object({
  providerName: z.string().trim().min(1).max(80).optional(),
  producerKind: z.enum(["agent","service","webhook","manual"]).optional(),
  computer: z.string().trim().min(1).max(120).optional(),
  account: z.string().trim().min(1).max(40).optional(),
  project: z.string().trim().min(1).max(120).optional(),
  providerThreadId: z.string().trim().min(1).max(200).optional(),
  providerWorkItemId: z.string().trim().min(1).max(200).optional(),
  threadName: z.string().trim().min(1).max(160).optional(),
  taskTitle: z.string().trim().min(1).max(160).optional(),
  threadNameSource: z.enum(["provider","explicit","fallback"]).optional(),
  taskTitleSource: z.enum(["provider","prompt_summary","explicit","fallback"]).optional(),
}).strict();

const semanticStepsSchema = z.object({
  labels: z.array(z.string().trim().min(1).max(40)).min(1).max(8),
  current: z.number().int().min(1).max(8),
}).strict().superRefine((value,context) => {
  if (value.current > value.labels.length) {
    context.addIssue({ code: "custom",path: ["current"],message: "Current step must reference a supplied label" });
  }
});

export const activityStartSchema = z.object({
  occurredAt: z.iso.datetime({ offset: true }).optional(),
  key: z.string().trim().min(1).max(100).optional(), replace: z.boolean().default(false),
  acquireMode: z.enum(["start","ensure"]).optional(),
  title: z.string().trim().min(1).max(80).optional(),
  status: z.string().trim().min(1).max(60).optional(), detail: z.string().trim().min(1).max(240).optional(),
  progress: z.number().min(0).max(1).optional(), symbol: z.enum(liveActivitySymbols).optional(),
  progressLabel: z.string().trim().min(1).max(32).optional(),
  steps: semanticStepsSchema.optional(),
  style: z.enum(taskLiveActivityStyles).optional(),
  preset: z.enum(LIVE_ACTIVITY_PRESENTATION_PRESETS).optional(),
  theme: z.enum(["system", "light", "dark"]).optional(),
  accentColor: accentColorSchema.optional(),
  privacy: z.enum(activityPrivacyModes).optional(),
  deviceIds: z.array(z.string()).min(1).max(50).optional(), context: contextSchema.optional(),
  origin: originDescriptorSchema.optional(),
  lifecycle: agentLifecycleIdentitySchema.optional(),
  expiresInSeconds: z.number().int().min(60).max(28_800).default(DEFAULT_EXPIRES_IN_SECONDS),
  staleAfterSeconds: z.number().int().min(0).max(28_800).default(DEFAULT_STALE_AFTER_SECONDS),
  presentation: liveActivityPresentationSchema.optional(),
  /** End-to-end sealed card text (E5); the readable fields carry placeholders. */
  sealed: sealedNoticeSchema.optional(),
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
  origin: originDescriptorSchema.optional(),
  lifecycle: agentLifecycleIdentitySchema.optional(),
  current: z.literal(true).optional(),
}).strict().superRefine((value,context) => {
  const selectors = [value.origin,value.lifecycle,value.current].filter((part) => part !== undefined);
  if (selectors.length !== 1) {
    context.addIssue({ code: "custom",message: "Provide exactly one lifecycle resolver" });
  }
});

export const activityUpdateSchema = z.object({
  occurredAt: z.iso.datetime({ offset: true }).optional(),
  title: z.string().trim().min(1).max(80).optional(),
  status: z.string().trim().min(1).max(60).optional(),
  detail: z.string().trim().min(1).max(240).nullable().optional(),
  progress: z.number().min(0).max(1).nullable().optional(),
  progressLabel: z.string().trim().min(1).max(32).nullable().optional(),
  steps: semanticStepsSchema.optional(),
  symbol: z.enum(liveActivitySymbols).optional(),
  accentColor: accentColorSchema.optional(),
  style: z.enum(taskLiveActivityStyles).optional(),
  staleAfterSeconds: z.number().int().min(0).max(28_800).optional(),
  deliveryPriority: z.literal(10).optional(),
  context: contextSchema.optional(),
  lifecycle: agentLifecycleIdentitySchema.optional(),
  ifSequence: z.number().int().min(0).optional(),
  presentation: liveActivityPresentationSchema.optional(),
  /** End-to-end sealed card text (E5); the readable fields carry placeholders. */
  sealed: sealedNoticeSchema.optional(),
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
  lifecycle: agentLifecycleIdentitySchema,
  leaseAfterSeconds: z.number().int().min(300).max(14_400).default(3_600),
}).strict();

export const activityEndSchema = z.object({
  occurredAt: z.iso.datetime({ offset: true }).optional(),
  status: z.string().trim().min(1).max(60).optional(),
  detail: z.string().trim().min(1).max(240).nullable().optional(),
  progress: z.number().min(0).max(1).nullable().optional(),
  symbol: z.enum(liveActivitySymbols).optional(),
  accentColor: accentColorSchema.optional(),
  dismissAfterSeconds: z.number().int().min(0).max(14400).default(0),
  ifSequence: z.number().int().min(0).optional(),
  lifecycle: agentLifecycleIdentitySchema.optional(),
  presentation: liveActivityPresentationSchema.optional(),
  /** End-to-end sealed card text (E5); the readable fields carry placeholders. */
  sealed: sealedNoticeSchema.optional(),
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
  type: questionTypeSchema,
  prompt: z.string().trim().min(1).max(2_000),
  options: choiceOptionsSchema.optional(),
  detail: questionDetailSchema.optional(),
  expiresInSeconds: questionExpirySchema,
  primaryLabel: activityWaitLabelSchema.optional(),
  secondaryLabel: activityWaitLabelSchema.optional(),
  correlationId: z.string().trim().min(1).max(100).optional(),
  callback: z.object({
    url: callbackUrlSchema,
    token: z.string().min(16).max(512).refine((value) => !/\s/.test(value),"Callback tokens cannot contain whitespace"),
  }).strict().optional(),
  /** End-to-end sealed prompt (E4.1); the server fills a placeholder prompt before parsing. */
  sealed: sealedNoticeSchema.optional(),
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
