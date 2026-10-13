import { destinationUrlSchema, publicHttpsUrlSchema } from "./url-policy.js";
import { z } from "zod";
import { originDescriptorSchema } from "./origin-slots.js";
import { MAX_NOTIFICATION_BODY_BYTES } from "./notification-content.js";
import { decisionSubjectCommandSchema, notificationSubjectCommandSchema } from "./relevance/admission.js";
import { subjectVersionSchema } from "@relo/notification-contracts";
import { questionExpirySchema } from "./question-policy.js";

const notificationLongBodySchema = z.string().trim().min(1).refine(
  (value) => Buffer.byteLength(value,"utf8") <= MAX_NOTIFICATION_BODY_BYTES,
  "Notification body must be at most 65,536 UTF-8 bytes.",
);
const notificationSummarySchema = z.string().trim().min(1).refine(
  (value) => Array.from(value).length <= 240,
  "Notification summary must be at most 240 characters.",
);

export const notificationRequestSchema = z.object({
  relevance: notificationSubjectCommandSchema.optional(),
  title: z.string().trim().min(1).max(80),
  body: notificationLongBodySchema,
  summary: notificationSummarySchema.optional(),
  bodyFormat: z.enum(["text","markdown"]).optional(),
  sourceName: z.string().trim().min(1).max(80),
  imageUrl: publicHttpsUrlSchema.optional(),
  destinationUrl: destinationUrlSchema.optional(),
  deviceIds: z.array(z.string()).min(1).max(50).optional(),
  context: z.object({
    providerName: z.string().trim().min(1).max(80).optional(),
    producerKind: z.enum(["agent","service","webhook","manual"]).optional(),
    computer: z.string().trim().min(1).max(120).optional(),
    project: z.string().trim().min(1).max(120).optional(),
    providerThreadId: z.string().trim().min(1).max(200).optional(),
    providerWorkItemId: z.string().trim().min(1).max(200).optional(),
    threadName: z.string().trim().min(1).max(160).optional(),
    taskTitle: z.string().trim().min(1).max(160).optional(),
    threadNameSource: z.enum(["provider","explicit","fallback"]).optional(),
    taskTitleSource: z.enum(["provider","prompt_summary","explicit","fallback"]).optional(),
  }).strict().optional(),
  origin: originDescriptorSchema.optional(),
}).strict();

export const registerDeviceSchema = z.object({
  stableDeviceId: z.string().min(1).max(200),
  installationId: z.string().min(1).max(200),
  name: z.string().min(1).max(120),
  bundleIdentifier: z.string().min(1).max(200),
  appVersion: z.string().min(1).max(40),
  appBuild: z.string().min(1).max(40),
  osVersion: z.string().min(1).max(40),
  model: z.string().max(120).optional(),
  apnsEnvironment: z.enum(["sandbox", "production"]),
  apnsToken: z.string().min(16).max(512).optional(),
  notificationAuthorization: z.enum(["unknown", "denied", "provisional", "authorized"]).default("unknown"),
  liveActivityAuthorization: z.enum(["unknown", "denied", "provisional", "authorized"]).default("unknown"),
});

export const heartbeatSchema = z.object({
  appVersion: z.string().min(1).max(40).optional(),
  appBuild: z.string().min(1).max(40).optional(),
  osVersion: z.string().min(1).max(40).optional(),
  model: z.string().max(120).optional(),
  apnsEnvironment: z.enum(["sandbox", "production"]).optional(),
  apnsToken: z.string().min(16).max(512).optional(),
  notificationAuthorization: z.enum(["unknown", "denied", "provisional", "authorized"]).optional(),
  liveActivityAuthorization: z.enum(["unknown", "denied", "provisional", "authorized"]).optional(),
  liveActivityPushToStartToken: z.string().min(16).max(512).optional(),
});

export const liveActivityUpdateTokenSchema = z.object({
  token: z.string().regex(/^[a-fA-F0-9]{32,512}$/),
  nativeActivityId: z.string().trim().min(1).max(200),
  environment: z.enum(["sandbox","production"]),
  generation: z.number().int().positive(),
}).strict();

export const createNotificationSchema = z.object({
  source: z.string().min(1).max(120),
  kind: z.enum(["notification", "approval", "question", "live_activity"]).default("notification"),
  title: z.string().min(1).max(200),
  body: z.string().max(4096).default(""),
  imageUrl: z.url().optional(),
  deepLink: z.string().max(2048).optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
  expiresAt: z.iso.datetime().optional(),
});

export const interactionSchema = z.object({
  expectedSubject: subjectVersionSchema.optional(),
  expectedInteractionId: z.string().regex(/^int_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).optional(),
  kind: z.enum(["approve", "deny", "yes", "no", "answer", "opened", "received"]),
  value: z.record(z.string(), z.unknown()).default({}),
  idempotencyKey: z.string().trim().min(1).max(200),
}).strict().superRefine((input,context) => {
  const response = input.value.response;
  if (input.kind === "answer") {
    if (typeof response !== "string" || response.trim().length < 1 || response.trim().length > 4_000) {
      context.addIssue({
        code: "custom",
        path: ["value","response"],
        message: "A text answer requires a response between 1 and 4,000 characters.",
      });
    }
    return;
  }
  if (response !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["value","response"],
      message: "Only a text answer may include response text.",
    });
  }
}).transform((input) => input.kind === "answer" && typeof input.value.response === "string"
  ? { ...input,value: { ...input.value,response: input.value.response.trim() } }
  : input);

/** Where Relo POSTs the answer. The token is returned as a bearer token so the receiver can verify Relo. */
export const interactionCallbackSchema = z.object({
  url: publicHttpsUrlSchema,
  token: z.string().min(16).max(512).refine((value) => !/[\s]/.test(value), "Callback tokens cannot contain whitespace"),
}).strict();

const interactionActionLabelSchema = z.string().trim().min(1).max(24)
  .refine((value) => !/[\r\n]/.test(value), "Action labels must use one line");

export const createInteractionSchema = z.object({
  relevance: decisionSubjectCommandSchema.optional(),
  context: notificationRequestSchema.shape.context,
  origin: originDescriptorSchema.optional(),
  prompt: z.string().min(1).max(2000),
  // Questions take tappable answers only; typed replies were removed for new questions.
  type: z
    .enum(["approval", "yes-no", "yes_no"],{ message: "Questions take tappable answers only: approval or yes_no" })
    .transform((value) => (value === "yes-no" ? "yes_no" : value)),
  title: z.string().min(1).max(80).default("Response requested"),
  expiresInSeconds: questionExpirySchema,
  deviceIds: z.array(z.string()).min(1).max(50).optional(),
  presentation: z.enum(["notification","live_activity"]).default("notification"),
  style: z.enum(["approval","shell","verdict","signal"]).optional(),
  primaryLabel: interactionActionLabelSchema.optional(),
  secondaryLabel: interactionActionLabelSchema.optional(),
  imageUrl: publicHttpsUrlSchema.optional(),
  destinationUrl: destinationUrlSchema.optional(),
  privacy: z.enum(["standard","private"]).optional(),
  correlationId: z.string().trim().min(1).max(100).optional(),
  callback: interactionCallbackSchema.optional(),
  /** The phone cannot show a card: notify without answer buttons; the owner answers in Relo. */
  answerInApp: z.boolean().optional(),
}).strict().superRefine((input,context) => {
  if (input.relevance?.policy.kind === "decision" && input.relevance.policy.actionSeconds !== undefined
    && input.relevance.policy.actionSeconds !== input.expiresInSeconds) {
    context.addIssue({ code: "custom",path: ["relevance","policy","actionSeconds"],
      message: "Decision actionSeconds must match expiresInSeconds" });
  }
  if (input.presentation === "notification") {
    if (input.privacy !== undefined) {
      context.addIssue({ code: "custom", path: ["privacy"], message: "Private prompts require presentation=live_activity" });
    }
    if (input.style !== undefined || input.primaryLabel !== undefined || input.secondaryLabel !== undefined) {
      context.addIssue({ code: "custom", message: "Live Activity fields require presentation=live_activity" });
    }
    return;
  }
  if (input.prompt.length > 240) {
    context.addIssue({ code: "custom", path: ["prompt"], message: "Live Activity prompts are limited to 240 characters" });
  }
  if (input.expiresInSeconds > 28_800) {
    context.addIssue({ code: "custom", path: ["expiresInSeconds"], message: "Live Activities expire within 8 hours" });
  }
  if (input.imageUrl !== undefined || input.destinationUrl !== undefined) {
    context.addIssue({ code: "custom", message: "Images and destination URLs require presentation=notification" });
  }
});
