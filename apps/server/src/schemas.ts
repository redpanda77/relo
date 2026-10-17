import { callbackUrlSchema } from "./callback-destinations.js";
import { destinationUrlSchema, publicHttpsUrlSchema } from "./url-policy.js";
import { z } from "zod";
import { originDescriptorSchema } from "./origin-slots.js";
import { MAX_NOTIFICATION_BODY_BYTES } from "./notification-content.js";
import { decisionSubjectCommandSchema, notificationSubjectCommandSchema } from "./relevance/admission.js";
import { FACTS,subjectVersionSchema } from "@relo/notification-contracts";
import { answerSignatureSchema,sealedNoticeSchema } from "./sealed-content.js";
import { choiceOptionIdSchema } from "@relo/notification-contracts";
import {
  checkQuestionAnswers,choiceOptionsSchema,QUESTION_MAX_CHARACTERS,questionDetailSchema,questionExpirySchema,
  questionPromptMessage,questionTypeSchema,
} from "./question-policy.js";

const notificationLongBodySchema = z.string().trim().min(1).refine(
  (value) => Buffer.byteLength(value,"utf8") <= MAX_NOTIFICATION_BODY_BYTES,
  "Notification body must be at most 65,536 UTF-8 bytes.",
);
const notificationSummarySchema = z.string().trim().min(1).refine(
  (value) => Array.from(value).length <= 240,
  "Notification summary must be at most 240 characters.",
);

export const notificationRequestSchema = z.object({
  relevance: notificationSubjectCommandSchema.optional().describe("How relevant the notification is to the owner over time; Relo derives its urgency from this."),
  title: z.string().trim().min(1).max(80).describe("Heading of the notification."),
  body: notificationLongBodySchema.describe("Full text of the notification."),
  summary: notificationSummarySchema.optional().describe("Short version shown where space is tight."),
  bodyFormat: z.enum(["text","markdown"]).optional().describe("Whether the body is plain text or Markdown."),
  sourceName: z.string().trim().min(1).max(80).describe("Name of the sender shown with the notification."),
  imageUrl: publicHttpsUrlSchema.optional().describe("Public HTTPS address of an image to show with the notification."),
  destinationUrl: destinationUrlSchema.optional().describe("Where tapping the notification opens."),
  deviceIds: z.array(z.string()).min(1).max(50).optional().describe("Phones to notify; every paired phone when omitted."),
  context: z.object({
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
  }).strict().optional().describe("Where the work runs and what it belongs to, shown with the notification."),
  origin: originDescriptorSchema.optional().describe("Identifies where the notification comes from, so related items can be grouped."),
}).strict();

/** An end-to-end sealed notice: no title or body in the clear (docs/ENCRYPTION-PROTOCOL.md, E3). */
export const sealedNotificationRequestSchema = notificationRequestSchema
  .omit({ title: true,body: true,summary: true,bodyFormat: true,imageUrl: true,destinationUrl: true })
  .extend({ sealed: sealedNoticeSchema })
  .strict();
/**
 * What a device's Relo build can show; builds that send none receive only what every build decodes.
 * `owner_overview`: reads the whole account's Now; never a delivery target (owner-overview.ts).
 */
export const DEVICE_CAPABILITIES = ["choice_questions","owner_overview"] as const;
export const deviceCapabilitiesSchema = z.array(z.enum(DEVICE_CAPABILITIES)).max(16)
  .transform((values) => [...new Set(values)].sort());

export const registerDeviceSchema = z.object({
  stableDeviceId: z.string().min(1).max(200),
  installationId: z.string().min(1).max(200),
  name: z.string().min(1).max(120),
  bundleIdentifier: z.string().min(1).max(200),
  appVersion: z.string().min(1).max(40),
  appBuild: z.string().min(1).max(40),
  osVersion: z.string().min(1).max(40),
  model: z.string().max(120).optional(),
  /** Sent by builds that know they run in the iOS Simulator; older builds omit it. */
  isSimulator: z.boolean().optional(),
  apnsEnvironment: z.enum(["sandbox", "production"]),
  apnsToken: z.string().min(16).max(512).optional(),
  notificationAuthorization: z.enum(["unknown", "denied", "provisional", "authorized"]).default("unknown"),
  liveActivityAuthorization: z.enum(["unknown", "denied", "provisional", "authorized"]).default("unknown"),
  capabilities: deviceCapabilitiesSchema.default([]),
});

export const heartbeatSchema = z.object({
  appVersion: z.string().min(1).max(40).optional(),
  appBuild: z.string().min(1).max(40).optional(),
  osVersion: z.string().min(1).max(40).optional(),
  model: z.string().max(120).optional(),
  isSimulator: z.boolean().optional(),
  apnsEnvironment: z.enum(["sandbox", "production"]).optional(),
  apnsToken: z.string().min(16).max(512).optional(),
  notificationAuthorization: z.enum(["unknown", "denied", "provisional", "authorized"]).optional(),
  liveActivityAuthorization: z.enum(["unknown", "denied", "provisional", "authorized"]).optional(),
  liveActivityPushToStartToken: z.string().min(16).max(512).optional(),
  capabilities: deviceCapabilitiesSchema.optional(),
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
  kind: z.enum(["approve", "deny", "yes", "no", "answer", "choose", "opened", "received"]),
  value: z.record(z.string(), z.unknown()).default({}),
  idempotencyKey: z.string().trim().min(1).max(200),
}).strict().superRefine((input,context) => {
  // A choice answer names exactly one of the question's options.
  if (input.kind === "choose") {
    // Exactly one option, plus the phone's signature over it when it signs answers (E4.2).
    const { optionId,...signature } = input.value;
    if (!choiceOptionIdSchema.safeParse(optionId).success
      || (Object.keys(signature).length > 0 && !answerSignatureSchema.safeParse(signature).success)) {
      context.addIssue({ code: "custom",path: ["value","optionId"],message: "A choice answer is {\"optionId\": \"…\"}" });
    }
    return;
  }
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
  url: callbackUrlSchema.describe("Address Relo POSTs the answer to."),
  token: z.string().min(16).max(512).refine((value) => !/[\s]/.test(value), "Callback tokens cannot contain whitespace")
    .describe("Secret Relo sends back as a bearer token so the receiver can verify the call."),
}).strict();

const interactionActionLabelSchema = z.string().trim().min(1).max(24)
  .refine((value) => !/[\r\n]/.test(value), "Action labels must use one line");

export const createInteractionSchema = z.object({
  relevance: decisionSubjectCommandSchema.optional().describe("How relevant the question is to the owner over time; Relo derives its urgency from this."),
  context: notificationRequestSchema.shape.context.describe("Where the work runs and what it belongs to, shown with the question."),
  origin: originDescriptorSchema.optional().describe("Identifies where the question comes from, so related items can be grouped."),
  prompt: z.string().min(1).max(2000).describe("The question shown to the owner."),
  detail: questionDetailSchema.optional().describe("Extra context shown with the question."),
  // Questions take tappable answers only; typed replies were removed for new questions.
  type: questionTypeSchema.describe("Kind of answer the question takes: approval, yes_no or choice."),
  options: choiceOptionsSchema.optional().describe("The answers to choose from when the type is choice."),
  title: z.string().min(1).max(80).default("Response requested").describe("Heading of the question."),
  expiresInSeconds: questionExpirySchema.describe("How long the question waits for an answer before it expires."),
  deviceIds: z.array(z.string()).min(1).max(50).optional().describe("Phones to ask; every paired phone when omitted."),
  presentation: z.enum(["notification","live_activity"]).default("notification").describe("Whether the question arrives as a notification or as a Live Activity card."),
  style: z.enum(["approval","shell","verdict","signal"]).optional().describe("Layout of the question card; only for the live_activity presentation."),
  primaryLabel: interactionActionLabelSchema.optional().describe("Text of the main answer button; only for the live_activity presentation."),
  secondaryLabel: interactionActionLabelSchema.optional().describe("Text of the other answer button; only for the live_activity presentation."),
  imageUrl: publicHttpsUrlSchema.optional().describe("Public HTTPS address of an image to show with the question; only for the notification presentation."),
  destinationUrl: destinationUrlSchema.optional().describe("Where tapping the question opens; only for the notification presentation."),
  privacy: z.enum(["standard","private"]).optional().describe("Whether the card shows its text on the Lock Screen (standard) or keeps it out of view (private); only for the live_activity presentation."),
  correlationId: z.string().trim().min(1).max(100).optional().describe("Your own id, returned with the answer so you can match it to the question."),
  callback: interactionCallbackSchema.optional().describe("Where Relo POSTs the answer once the owner responds."),
  /** The phone cannot show a card: notify without answer buttons; the owner answers in Relo. */
  answerInApp: z.boolean().optional().describe("Set when the phone cannot show answer buttons: the owner is notified and answers inside the Relo app."),
  /** End-to-end sealed title and prompt (E4.1); the server fills placeholders before parsing. */
  sealed: sealedNoticeSchema.optional().describe("End-to-end sealed title and prompt; the readable ones then carry placeholders."),
}).strict().superRefine((input,context) => {
  checkQuestionAnswers(input,context);
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
  if (input.prompt.length > QUESTION_MAX_CHARACTERS || /[\r\n]/.test(input.prompt)) {
    context.addIssue({ code: "custom", path: ["prompt"], message: questionPromptMessage });
  }
  if (input.expiresInSeconds > FACTS.card.maxSeconds) {
    context.addIssue({ code: "custom", path: ["expiresInSeconds"], message: "Live Activities expire within 8 hours" });
  }
  if (input.imageUrl !== undefined || input.destinationUrl !== undefined) {
    context.addIssue({ code: "custom", message: "Images and destination URLs require presentation=notification" });
  }
});
