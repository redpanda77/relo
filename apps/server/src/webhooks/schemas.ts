import { internalId } from "../ids.js";
import { checkQuestionAnswers,choiceOptionsSchema } from "../question-policy.js";
import { z } from "zod";
import { questionExpirySchema } from "../question-policy.js";
import { MAX_NOTIFICATION_BODY_BYTES } from "../notification-content.js";
import { originDescriptorSchema } from "../origin-slots.js";
import { decisionSubjectCommandSchema,notificationSubjectCommandSchema } from "../relevance/admission.js";
import { destinationUrlSchema,publicHttpsUrlSchema } from "../url-policy.js";
import { safeContextSchema,scopesFor,type Scope } from "@relo/notification-contracts";
import { interactionCallbackSchema } from "../schemas.js";

/** The request bodies of the webhook API and of service management (the API description reads these). */
/** What a webhook service may do (the hooks:* family of the scope registry). */
export const serviceScopeSchema = z.enum(scopesFor("service") as [Scope,...Scope[]]);

export const serviceCreateSchema = z.object({
  title: z.string().trim().min(1).max(80).describe("Name of the service, shown on its notifications."),
  imageUrl: publicHttpsUrlSchema.nullable().optional().describe("Public HTTPS address of the service's default image. Null clears it."),
  destinationUrl: destinationUrlSchema.nullable().optional().describe("Where tapping the service's notifications opens by default. Null clears it."),
  /** On an account that requires end-to-end encryption, may this service send readable content (it cannot seal)? */
  readableAllowed: z.boolean().optional().describe("On an account that requires end-to-end encryption, whether this service may still send readable content, since it cannot seal."),
  /** What the service may do; every service scope when omitted. */
  scopes: z.array(serviceScopeSchema).min(1).max(scopesFor("service").length).transform((scopes) => [...new Set(scopes)]).optional().describe("What the service may do; every service scope when omitted."),
}).strict();
export const serviceUpdateSchema = serviceCreateSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required.",
);

export const webhookSchema = z.object({
  body: z.string().trim().min(1).refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAX_NOTIFICATION_BODY_BYTES,
    "Notification body must be at most 65,536 UTF-8 bytes.",
  ).describe("Full text of the notification, or the question when response is set."),
  summary: z.string().trim().min(1).refine(
    (value) => Array.from(value).length <= 240,
    "Notification summary must be at most 240 characters.",
  ).optional().describe("Short version shown where space is tight."),
  bodyFormat: z.enum(["text", "markdown"]).optional().describe("Whether the body is plain text or Markdown."),
  title: z.string().trim().min(1).max(80).optional().describe("Heading of the notification."),
  imageUrl: publicHttpsUrlSchema.optional().describe("Public HTTPS address of an image to show with the notification."),
  url: destinationUrlSchema.optional().describe("Where tapping the notification opens. Not combinable with deepLink."),
  deepLink: destinationUrlSchema.optional().describe("Where tapping the notification opens. Not combinable with url."),
  deviceIds: z.array(z.string()).min(1).max(50)
    .transform((values) => [...new Set(values)].sort()).optional().describe("Phones to notify; every paired phone when omitted."),
  response: z.object({
    type: z.enum(["approval","yes_no","choice"],{ message: "Questions take tappable answers only: approval, yes_no or choice" })
      .describe("Kind of answer the question takes: approval, yes_no or choice."),
    options: choiceOptionsSchema.optional().describe("The answers to choose from when the type is choice."),
    expiresInSeconds: questionExpirySchema.describe("How long the question waits for an answer before it expires."),
    correlationId: z.string().trim().min(1).max(100).optional().describe("Your own id, returned with the answer so you can match it to the question."),
    callback: interactionCallbackSchema.optional().describe("Where Relo POSTs the answer once the owner responds."),
  }).strict().superRefine(checkQuestionAnswers).optional().describe("Makes this a question: what kind of answer it takes and how it is returned."),
  context: safeContextSchema.optional().describe("Where the work runs and what it belongs to, shown with the notification."),
  origin: originDescriptorSchema.optional().describe("Identifies where the notification comes from, so related items can be grouped."),
  relevance: z.union([notificationSubjectCommandSchema,decisionSubjectCommandSchema]).optional().describe("How relevant the notification or question is to the owner over time; Relo derives its urgency from this."),
}).strict().superRefine((value,context) => {
  if (value.url !== undefined && value.deepLink !== undefined) {
    context.addIssue({ code: "custom", message: "Use url or deepLink, not both." });
  }
  if (value.response && Buffer.byteLength(value.body, "utf8") > 2_000) {
    context.addIssue({ code: "custom", message: "Interactive prompts must be at most 2,000 UTF-8 bytes." });
  }
  if (value.relevance && (value.relevance.policy.kind === "decision") !== Boolean(value.response)) {
    context.addIssue({ code: "custom",message: "Relevance policy must match the notification or response kind" });
  }
  if (value.response && value.relevance?.policy.kind === "decision"
    && value.relevance.policy.actionSeconds !== undefined
    && value.relevance.policy.actionSeconds !== value.response.expiresInSeconds) {
    context.addIssue({ code: "custom",message: "Relevance action duration must match expiresInSeconds" });
  }
});

/** Requested phone ids as internal ids; [] when one is malformed (so nothing is sent), null when none were named. */
export function selectedDeviceIds(values: string[] | undefined): string[] | null {
  if (values === undefined) return null;
  const internal = values.map((value) => internalId("dev",value));
  if (internal.some((value) => !value || !z.uuid().safeParse(value).success)) return [];
  return internal as string[];
}
