import { choiceOptionSchema } from "./presentation.js";
import { z } from "zod";
import { agentSessionListSchema } from "./agent-sessions.js";

export * from "./presentation.js";
export * from "./delivery-evidence.js";
export * from "./relevance.js";
export * from "./current-inbox.js";
export * from "./agent-sessions.js";

export function isPublicHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname.endsWith(".home") ||
      hostname.endsWith(".lan") ||
      (!hostname.includes(".") && !hostname.includes(":"))
    ) return false;

    const ipv4 = hostname.split(".").map(Number);
    if (
      ipv4.length === 4 &&
      ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ) {
      const [first, second] = ipv4;
      if (
        first === 0 || first === 10 || first === 127 ||
        (first === 169 && second === 254) ||
        (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
        (first === 192 && second === 168) ||
        (first === 100 && second !== undefined && second >= 64 && second <= 127) ||
        (first === 192 && second === 0) ||
        (first === 198 && (second === 18 || second === 19)) ||
        (first === 198 && second === 51 && ipv4[2] === 100) ||
        (first === 203 && second === 0 && ipv4[2] === 113) ||
        (first !== undefined && first >= 224)
      ) return false;
    }

    const isIpv6 = hostname.includes(":");
    return !(isIpv6 && (
      hostname === "::" || hostname === "::1" ||
      hostname.startsWith("fc") ||
      hostname.startsWith("fd") ||
      /^fe[89ab]/.test(hostname) ||
      hostname.startsWith("ff") ||
      hostname.startsWith("2001:db8:") ||
      hostname.startsWith("::ffff:")
    ));
  } catch {
    return false;
  }
}

export const publicHttpsUrlSchema = z
  .url()
  .max(2_048)
  .refine(isPublicHttpsUrl, "Must be a public HTTPS URL");

export const httpsUrlSchema = z.url().max(2_048).startsWith("https://");

export const API_TOKEN_SCOPES = [
  "notifications:send",
  "interactions:create",
  "interactions:read",
  "activities:write",
  "activities:read",
  "sessions:write",
  "devices:read",
  "services:read",
  "services:write",
] as const;
export const apiTokenScopeSchema = z.enum(API_TOKEN_SCOPES);
export type ApiTokenScope = z.infer<typeof apiTokenScopeSchema>;

export const identifierSchema = z.string().regex(/^[a-z]+_[A-Za-z0-9_-]{12,}$/);
export const hexTokenSchema = z.string().regex(/^[a-fA-F0-9]{32,512}$/);
export const isoTimestampSchema = z.iso.datetime({ offset: true });

export const notificationPrivacySchema = z.literal("standard");
export const idempotencyKeySchema = z.string().trim().min(1).max(200);
export const safeContextSchema = z
  .object({
    providerName: z.string().trim().min(1).max(80).optional(),
    producerKind: z.enum(["agent", "service", "webhook", "manual"]).optional(),
    computer: z.string().trim().min(1).max(120).optional(),
    account: z.string().trim().min(1).max(40).optional(),
    project: z.string().trim().min(1).max(120).optional(),
    providerThreadId: z.string().trim().min(1).max(200).optional(),
    providerWorkItemId: z.string().trim().min(1).max(200).optional(),
    threadName: z.string().trim().min(1).max(160).optional(),
    taskTitle: z.string().trim().min(1).max(160).optional(),
    threadNameSource: z.enum(["provider", "explicit", "fallback"]).optional(),
    taskTitleSource: z.enum(["provider", "prompt_summary", "explicit", "fallback"]).optional(),
  })
  .strict();
export const originDescriptorSchema = z
  .object({
    sourceInstance: z.string().trim().min(1).max(160),
    project: z.string().trim().min(1).max(160),
    thread: z.string().trim().min(1).max(200),
    channel: z.string().trim().min(1).max(80),
  })
  .strict();
export type OriginDescriptor = z.infer<typeof originDescriptorSchema>;
export const agentLifecycleIdentitySchema = z.object({
  provider: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,39}$/),
  runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/),
}).strict();
export type AgentLifecycleIdentity = z.infer<typeof agentLifecycleIdentitySchema>;
export const operationHeadersSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema.optional(),
  })
  .strict();
export const notificationBodyFormatSchema = z.enum(["text","markdown"]);
export const notificationLongBodySchema = z.string().trim().min(1).refine(
  (value) => new TextEncoder().encode(value).byteLength <= 65_536,
  "Notification body must be at most 65,536 UTF-8 bytes.",
);
export const notificationSummarySchema = z.string().trim().min(1).refine(
  (value) => Array.from(value).length <= 240,
  "Notification summary must be at most 240 characters.",
);
export const notificationRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    body: notificationLongBodySchema,
    summary: notificationSummarySchema.optional(),
    bodyFormat: notificationBodyFormatSchema.optional(),
    sourceName: z.string().trim().min(1).max(80),
    imageUrl: publicHttpsUrlSchema.optional(),
    destinationUrl: httpsUrlSchema.optional(),
    deviceIds: z.array(identifierSchema).min(1).max(50).optional(),
    context: safeContextSchema.optional(),
    origin: originDescriptorSchema.optional(),
    lifecycle: agentLifecycleIdentitySchema.optional(),
  })
  .strict();

export type NotificationRequest = z.infer<typeof notificationRequestSchema>;

export const serviceCreateRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    imageUrl: publicHttpsUrlSchema.nullable().optional(),
    destinationUrl: httpsUrlSchema.nullable().optional(),
  })
  .strict();
export const serviceUpdateRequestSchema = serviceCreateRequestSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required.",
);

export const serviceSchema = z
  .object({
    id: identifierSchema,
    title: z.string().trim().min(1).max(80),
    imageUrl: publicHttpsUrlSchema.nullable(),
    destinationUrl: httpsUrlSchema.nullable(),
    prefix: z.string().min(1),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();

export const serviceCreateResponseSchema = z
  .object({
    service: serviceSchema,
    webhookUrl: z.url(),
  })
  .strict();

export const serviceListResponseSchema = z.object({ services: z.array(serviceSchema) }).strict();

export type ServiceCreateRequest = z.infer<typeof serviceCreateRequestSchema>;
export type ServiceUpdateRequest = z.infer<typeof serviceUpdateRequestSchema>;
export type Service = z.infer<typeof serviceSchema>;

export const deliveryStateSchema = z.enum([
  "queued",
  "sending",
  "accepted_by_apns",
  "retryable",
  "rejected",
  "token_invalid",
]);

export const notificationEventSchema = z
  .object({
    id: identifierSchema,
    ownerId: identifierSchema,
    sourceName: z.string(),
    title: z.string(),
    body: z.string(),
    imageUrl: z.string().nullable(),
    destinationUrl: z.string().nullable(),
    createdAt: isoTimestampSchema,
  })
  .strict();

export const inboxKindSchema = z.enum(["notification", "live_activity", "response"]);
export const chosenOptionSchema = z.object({ optionId: z.string(), label: z.string() }).strict();
export const inboxInteractionSchema = z.object({
  id: identifierSchema,
  kind: z.enum(["approval", "yes_no", "text", "choice"]),
  prompt: z.string(),
  state: z.enum(["pending", "approved", "denied", "yes", "no", "replied", "expired", "canceled"]),
  expiresAt: isoTimestampSchema,
  respondedAt: isoTimestampSchema.nullable(),
  /** Choice questions only: the options, and the one picked once answered. */
  options: z.array(choiceOptionSchema).optional(),
  response: chosenOptionSchema.nullable().optional(),
}).strict();
export const inboxContextSchema = safeContextSchema;

export const liveActivityStyleSchema = z.enum([
  "standard", "hero", "terminal", "steps",
  "approval", "shell", "verdict", "signal",
]);
export const TASK_LIVE_ACTIVITY_STYLES = ["standard", "hero", "terminal", "steps"] as const;
export const taskLiveActivityStyleSchema = z.enum(TASK_LIVE_ACTIVITY_STYLES);
export const LIVE_ACTIVITY_SYMBOLS = ["terminal", "code", "build", "success", "warning"] as const;
export const liveActivitySymbolSchema = z.enum(LIVE_ACTIVITY_SYMBOLS);
export const LIVE_ACTIVITY_DEFAULT_ACCENT_COLOR = "#5ED8B7" as const;
export const liveActivityAccentColorSchema = z.string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Accent color must use #RRGGBB format");
export const LIVE_ACTIVITY_PRESENTATION_PRESETS = [
  "automatic",
  "standard",
  "terminal",
  "steps",
] as const;
export const liveActivityPresentationPolicySchema = z.object({
  preset: z.enum(LIVE_ACTIVITY_PRESENTATION_PRESETS).default("automatic"),
  theme: z.enum(["system", "light", "dark"]).default("system"),
  symbol: z.union([z.literal("automatic"), liveActivitySymbolSchema]).default("automatic"),
  colorStrategy: z.enum(["fixed", "thread", "project"]).default("thread"),
  accentColor: liveActivityAccentColorSchema.default(LIVE_ACTIVITY_DEFAULT_ACCENT_COLOR),
}).strict();
export type LiveActivityPresentationPolicy = z.infer<typeof liveActivityPresentationPolicySchema>;
export const LIVE_ACTIVITY_DEFAULT_EXPIRES_IN_SECONDS = 28_800 as const;
export const LIVE_ACTIVITY_DEFAULT_STALE_AFTER_SECONDS = 14_400 as const;

export const inboxLiveActivityInteractionSchema = z.object({
  id: identifierSchema,
  notificationId: identifierSchema,
  kind: z.enum(["approval", "yes_no", "choice"]),
  state: z.enum(["pending", "approved", "denied", "yes", "no", "replied", "expired", "canceled"]),
  credential: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: isoTimestampSchema,
}).strict();

export const inboxLiveActivitySchema = z.object({
  operation: z.enum(["start", "update", "end"]),
  activityId: identifierSchema,
  generation: z.number().int().positive(),
  targetDeviceId: identifierSchema,
  style: liveActivityStyleSchema,
  sourceName: z.string(),
  headline: z.string(),
  detail: z.string().nullable(),
  status: z.string(),
  progress: z.number().min(0).max(1).nullable(),
  symbol: liveActivitySymbolSchema.default("terminal"),
  privacy: notificationPrivacySchema.default("standard"),
  privacyMode: notificationPrivacySchema.default("standard"),
  accentColor: liveActivityAccentColorSchema.default(LIVE_ACTIVITY_DEFAULT_ACCENT_COLOR),
  expiresAt: isoTimestampSchema.nullable().default(null),
  staleAt: isoTimestampSchema.nullable().default(null),
  primaryLabel: z.string().min(1).max(24).nullable().default(null),
  secondaryLabel: z.string().min(1).max(24).nullable().default(null),
  alertOwner: z.enum(["apns", "app", "none"]).default("none"),
  sequence: z.number().int().min(0).default(0),
  relevanceScore: z.number().min(0).max(1).default(0.5),
  presentationState: z.enum([
    "eligible", "foreground", "background", "pending_token", "not_presented", "ending", "ended", "unknown",
  ]).default("unknown"),
  otherActiveCount: z.number().int().min(0).default(0),
  dismissAfterSeconds: z.number().int().min(0).max(14_400).nullable().default(null),
  interaction: inboxLiveActivityInteractionSchema.nullable().default(null),
}).strict();

export const inboxItemSchema = z
  .object({
    id: identifierSchema,
    kind: inboxKindSchema,
    sourceName: z.string(),
    sourceImageUrl: z.string().nullable(),
    title: z.string(),
    detail: z.string().nullable(),
    content: z.object({
      summary: z.string().min(1).max(240),
      body: notificationLongBodySchema,
      format: notificationBodyFormatSchema,
      byteLength: z.number().int().min(1).max(65_536),
    }).strict().nullable().default(null),
    readAt: isoTimestampSchema.nullable().default(null),
    withdrawnAt: isoTimestampSchema.nullable().default(null),
    result: z.string().nullable(),
    deliveryState: deliveryStateSchema.nullable(),
    apnsAcceptedAt: isoTimestampSchema.nullable(),
    receivedAt: isoTimestampSchema.nullable(),
    openedAt: isoTimestampSchema.nullable(),
    createdAt: isoTimestampSchema,
    destinationUrl: httpsUrlSchema.nullable().default(null),
    privacy: notificationPrivacySchema.default("standard"),
    interaction: inboxInteractionSchema.nullable(),
    context: inboxContextSchema.nullable(),
    resources: z.object({
      source: z.object({
        id: z.string().regex(/^src_[0-9a-f-]{36}$/i),
        kind: z.enum(["agent","cli","service","webhook","dashboard","manual"]),
        name: z.string(),
      }).strict(),
      project: z.object({
        id: z.string().regex(/^prj_[0-9a-f-]{36}$/i),
        name: z.string(),
        isDirect: z.boolean(),
        palette: z.object({
          slot: z.number().int().min(0).max(11),
          generation: z.number().int().min(0),
        }).strict(),
        icon: z.string(),
        revision: z.number().int().positive(),
      }).strict(),
      conversationId: z.string().regex(/^cnv_[0-9a-f-]{36}$/i).nullable(),
      workItemId: z.string().regex(/^wrk_[0-9a-f-]{36}$/i).nullable(),
    }).strict().nullable().optional(),
    liveActivity: inboxLiveActivitySchema.nullable().default(null),
  })
  .strict();

export type InboxItem = z.infer<typeof inboxItemSchema>;

export const inboxPageSchema = z
  .object({
    items: z.array(inboxItemSchema),
    /** Durable high-water mark after applying this page; echoed when the page is empty. */
    cursor: z.string().min(1).nullable(),
    /** Fetch another page using `cursor` when true. */
    hasMore: z.boolean(),
    serverTime: isoTimestampSchema,
    readWatermark: z.string().min(1).nullable().optional(),
    unread: z.object({
      account: z.number().int().min(0),
      projects: z.record(z.string(),z.number().int().min(0)),
    }).strict().optional(),
  })
  .strict();

export type InboxPage = z.infer<typeof inboxPageSchema>;

export const inboxHistoryQuerySchema = z
  .object({
    /** Opaque exclusive boundary returned as `cursor` by the previous history page. */
    before: z.string().min(1).optional(),
    limit: z.union([
      z.number().int(),
      z.string().regex(/^\d+$/).transform((value) => Number(value)),
    ]).pipe(z.number().int().min(1).max(100)).default(20),
  })
  .strict();

export const inboxHistoryPageSchema = z
  .object({
    /** Newest-first items ordered by `(createdAt,id)` descending. */
    items: z.array(inboxItemSchema),
    /** Pass as `before` for the next page; null exactly when `hasMore` is false. */
    cursor: z.string().min(1).nullable(),
    hasMore: z.boolean(),
    /** Current count of all events visible to this authenticated device/account. */
    total: z.number().int().min(0),
    serverTime: isoTimestampSchema,
    readWatermark: z.string().min(1).nullable().optional(),
    unread: z.object({
      account: z.number().int().min(0),
      projects: z.record(z.string(),z.number().int().min(0)),
    }).strict().optional(),
  })
  .strict()
  .superRefine((page,context) => {
    if (page.hasMore === (page.cursor === null)) {
      context.addIssue({
        code: "custom",
        path: ["cursor"],
        message: "A history cursor is required exactly when more items are available.",
      });
    }
  });

export type InboxHistoryQuery = z.infer<typeof inboxHistoryQuerySchema>;
export type InboxHistoryPage = z.infer<typeof inboxHistoryPageSchema>;

export const inboxReadMutationSchema = z.object({
  notificationId: identifierSchema.optional(),
  watermark: z.string().min(1).optional(),
}).strict().refine(
  (value) => (value.notificationId === undefined) !== (value.watermark === undefined),
  "Provide exactly one of notificationId or watermark.",
);
export const notificationWithdrawalResponseSchema = z.object({
  eventId: identifierSchema,
  state: z.literal("withdrawn"),
  withdrawnAt: isoTimestampSchema,
  canceledDeliveries: z.number().int().min(0).optional(),
  replayed: z.boolean(),
}).strict();

export const interactionKindSchema = z.enum(["approval", "yes_no", "text", "choice"]);
export const interactionStateSchema = z.enum([
  "pending", "approved", "denied", "yes", "no", "replied", "expired", "canceled",
]);
export const interactionResultSchema = z.object({
  id: identifierSchema,
  eventId: identifierSchema,
  type: interactionKindSchema,
  prompt: z.string(),
  options: z.array(choiceOptionSchema).optional(),
  state: interactionStateSchema,
  action: z.enum(["approve", "deny", "yes", "no", "reply", "choose"]).nullable(),
  response: z.unknown().nullable(),
  respondingDevice: z.object({
    id: identifierSchema,
    name: z.string().trim().min(1).max(100),
  }).strict().nullable(),
  expiresAt: isoTimestampSchema,
  respondedAt: isoTimestampSchema.nullable(),
  createdAt: isoTimestampSchema,
  callback: z.unknown().optional(),
}).strict();
export const interactionResultResponseSchema = z.object({ interaction: interactionResultSchema }).strict();
export const interactionResponseSchema = z
  .object({
    interactionId: identifierSchema,
    deviceId: identifierSchema,
    action: z.enum(["approve", "deny", "yes", "no", "reply"]),
    response: z.string().trim().min(1).max(4_000).optional(),
    responseToken: z.string().min(32),
    idempotencyKey: z.string().trim().min(1).max(200),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === "reply" && value.response === undefined) {
      context.addIssue({ code: "custom", message: "A text reply requires response text." });
    }
    if (value.action !== "reply" && value.response !== undefined) {
      context.addIssue({ code: "custom", message: "Only a text reply may include response text." });
    }
  });

export type InteractionResponse = z.infer<typeof interactionResponseSchema>;

export const liveActivityStartRequestSchema = z
  .object({
    key: z.string().trim().min(1).max(100).optional(),
    replace: z.boolean().default(false),
    acquireMode: z.enum(["start","ensure"]).optional(),
    title: z.string().trim().min(1).max(80),
    status: z.string().trim().min(1).max(60),
    detail: z.string().trim().min(1).max(240).optional(),
    progress: z.number().min(0).max(1).optional(),
    symbol: liveActivitySymbolSchema.optional(),
    style: taskLiveActivityStyleSchema.optional(),
    preset: z.enum(LIVE_ACTIVITY_PRESENTATION_PRESETS).optional(),
    theme: z.enum(["system", "light", "dark"]).optional(),
    accentColor: liveActivityAccentColorSchema.optional(),
    deviceIds: z.array(identifierSchema).min(1).max(50).optional(),
    expiresInSeconds: z.number().int().min(60).max(28_800)
      .default(LIVE_ACTIVITY_DEFAULT_EXPIRES_IN_SECONDS),
    staleAfterSeconds: z.number().int().min(0).max(28_800)
      .default(LIVE_ACTIVITY_DEFAULT_STALE_AFTER_SECONDS),
    context: safeContextSchema.optional(),
    origin: originDescriptorSchema.optional(),
    lifecycle: agentLifecycleIdentitySchema.optional(),
  })
  .strict()
  .superRefine((value,context) => {
    if (value.lifecycle !== undefined && value.origin === undefined) {
      context.addIssue({ code: "custom",path: ["origin"],message: "Lifecycle acquisition requires an origin." });
    }
  })
;

export const liveActivityUpdateRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(80).optional(),
    status: z.string().trim().min(1).max(60).optional(),
    detail: z.string().trim().min(1).max(240).nullable().optional(),
    progress: z.number().min(0).max(1).nullable().optional(),
    symbol: liveActivitySymbolSchema.optional(),
    accentColor: liveActivityAccentColorSchema.optional(),
    style: taskLiveActivityStyleSchema.optional(),
    staleAfterSeconds: z.number().int().min(0).max(28_800).optional(),
    deliveryPriority: z.literal(10).optional(),
    lifecycle: agentLifecycleIdentitySchema.optional(),
    ifSequence: z.number().int().min(0).optional(),
  })
  .strict()
  .refine((value) => Object.entries(value).some(([key,part]) => !["ifSequence","lifecycle"].includes(key) && part !== undefined), {
    message: "At least one field is required.",
  })
;

export const liveActivityEndRequestSchema = z
  .object({
    status: z.string().trim().min(1).max(60).default("Complete"),
    detail: z.string().trim().min(1).max(240).nullable().optional(),
    progress: z.number().min(0).max(1).nullable().optional(),
    symbol: liveActivitySymbolSchema.default("success"),
    accentColor: liveActivityAccentColorSchema.optional(),
    dismissAfterSeconds: z.number().int().min(0).max(14_400).default(0),
    ifSequence: z.number().int().min(0).optional(),
    lifecycle: agentLifecycleIdentitySchema.optional(),
  })
  .strict();

export const liveActivityUpdateTokenRequestSchema = z.object({
  token: hexTokenSchema,
  nativeActivityId: z.string().trim().min(1).max(200),
  environment: z.enum(["sandbox","production"]),
  generation: z.number().int().positive(),
}).strict();

export const deliverySummarySchema = z
  .object({
    eligibleDevices: z.number().int().min(0),
    durableCommands: z.number().int().min(0),
    apnsJobs: z.number().int().min(0),
  })
  .strict();

export const taskLiveActivityStateSchema = z.enum(["active", "ended", "expired", "replaced"]);
export const taskLiveActivitySchema = z.object({
  id: identifierSchema,
  generation: z.number().int().positive(),
  key: z.string().nullable(),
  title: z.string().trim().min(1).max(80),
  status: z.string().trim().min(1).max(60),
  detail: z.string().nullable(),
  progress: z.number().min(0).max(1).nullable(),
  symbol: liveActivitySymbolSchema,
  privacy: notificationPrivacySchema,
  privacyMode: notificationPrivacySchema,
  accentColor: liveActivityAccentColorSchema,
  style: taskLiveActivityStyleSchema,
  state: taskLiveActivityStateSchema,
  sequence: z.number().int().min(0),
  expiresAt: isoTimestampSchema,
  staleAt: isoTimestampSchema.nullable(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  endedAt: isoTimestampSchema.nullable(),
  ownerKind: z.enum([
    "provider_run","service_run","manual_key","credential_session","dashboard_test",
  ]).optional(),
}).strict();

export const taskLiveActivityMutationResponseSchema = z.object({
  activity: taskLiveActivitySchema,
  delivery: deliverySummarySchema,
  queued: z.number().int().min(0),
  replayed: z.boolean(),
  reused: z.boolean().default(false),
  resumed: z.boolean().default(false),
  disposition: z.enum(["created","reused","replayed","replaced","blocked"]).optional(),
  replaced: z.number().int().min(0).optional(),
  dismissAfterSeconds: z.number().int().min(0).max(14_400).nullable().optional(),
}).strict();

export const liveActivityResolveRequestSchema = z.object({
  origin: originDescriptorSchema.optional(),
  lifecycle: agentLifecycleIdentitySchema.optional(),
  current: z.literal(true).optional(),
}).strict().superRefine((value,context) => {
  const selectors = [value.origin,value.lifecycle,value.current].filter((part) => part !== undefined);
  if (selectors.length !== 1) {
    context.addIssue({ code: "custom",message: "Provide exactly one lifecycle resolver" });
  }
});

export const liveActivityResolveResponseSchema = z.object({
  found: z.boolean(),
  activity: taskLiveActivitySchema.nullable(),
}).strict();

export type LiveActivityStartRequest = z.infer<typeof liveActivityStartRequestSchema>;
export type LiveActivityUpdateRequest = z.infer<typeof liveActivityUpdateRequestSchema>;
export type LiveActivityEndRequest = z.infer<typeof liveActivityEndRequestSchema>;
export type LiveActivityUpdateTokenRequest = z.infer<typeof liveActivityUpdateTokenRequestSchema>;
export type DeliverySummary = z.infer<typeof deliverySummarySchema>;
export type TaskLiveActivity = z.infer<typeof taskLiveActivitySchema>;
export type LiveActivityResolveRequest = z.infer<typeof liveActivityResolveRequestSchema>;
export type LiveActivityResolveResponse = z.infer<typeof liveActivityResolveResponseSchema>;

/** History is an authoritative bounded repair window, never current action authority. */
export const inboxHistorySummarySchema = inboxItemSchema.omit({
  detail: true, content: true, liveActivity: true, interaction: true, privacy: true, deliveryState: true,
}).extend({
  title: z.string().refine(value => Array.from(value).length <= 200),
  sourceName: z.string().refine(value => Array.from(value).length <= 200),
  privacy: z.enum(["standard", "private"]),
  deliveryState: z.enum(["queued", "sending", "accepted_by_apns", "retryable", "rejected", "token_invalid", "reconciliation_required"]).nullable(),
  updatedAt: isoTimestampSchema,
  contentSummary: z.object({
    summary: z.string().refine(value => Array.from(value).length <= 240),
    format: z.enum(["text", "markdown"]), byteLength: z.number().int().min(0).max(65_536),
  }).strict(),
  interaction: inboxInteractionSchema.extend({ prompt: z.string().refine(value => Array.from(value).length <= 240) }).nullable(),
  activityEvent: z.object({
    id: z.string().regex(/^act_[0-9a-f-]{36}$/), operation: z.enum(["start", "update", "end"]),
    generation: z.number().int().positive(), sequence: z.number().int().nonnegative(),
  }).strict().nullable(),
  // Where the card behind this event stands now, so a list can say how the work turned out.
  activity: z.object({
    state: z.enum(["active", "ended", "expired", "replaced"]),
    outcome: z.enum(["completed", "failed"]).nullable(),
    status: z.string().refine(value => Array.from(value).length <= 160).nullable(),
    progress: z.number().min(0).max(1).nullable(),
    steps: z.object({
      done: z.number().int().nonnegative(), total: z.number().int().positive(),
      current: z.string().refine(value => Array.from(value).length <= 80).nullable(),
    }).strict().nullable(),
    updates: z.number().int().nonnegative(),
    startedAt: isoTimestampSchema, endedAt: isoTimestampSchema.nullable(),
  }).strict().nullable().optional(),
  relevance: z.object({
    subjectId: z.string().regex(/^sub_[0-9a-f-]{36}$/),
    generation: z.number().int().positive(), revision: z.number().int().positive(),
    status: z.string().max(40), supersededAt: isoTimestampSchema.nullable(),
    currentUntil: isoTimestampSchema.nullable(), actionExpiresAt: isoTimestampSchema.nullable(),
    freshUntil: isoTimestampSchema.nullable(), deliverUntil: isoTimestampSchema,
  }).strict().nullable(),
  /** End-to-end sealed text for this phone; title and summaries are placeholders until opened. */
  sealed: z.object({ alert: z.unknown().nullable(),content: z.unknown() }).nullable().optional(),
}).strict();
export const inboxSnapshotResponseSchema = z.object({
  items: z.array(inboxHistorySummarySchema).max(250),
  total: z.number().int().nonnegative(), serverTime: isoTimestampSchema,
  readWatermark: z.string().max(512).nullable(),
  unread: z.object({ account: z.number().int().nonnegative(), projects: z.record(z.string(), z.number().int().nonnegative()) }).strict(),
  // Live and recent agent sessions (last 24 hours, at most 20); absent from servers that predate them.
  sessions: agentSessionListSchema.optional(),
}).strict().refine(value => value.total >= value.items.length && new Set(value.items.map(item => item.id)).size === value.items.length);
export type InboxHistorySummary = z.infer<typeof inboxHistorySummarySchema>;
export type InboxSnapshotResponse = z.infer<typeof inboxSnapshotResponseSchema>;

const exactNotificationIdSchema = z.string().regex(/^ntf_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const inboxReadItemsRequestSchema = z.object({notificationIds: z.array(exactNotificationIdSchema).min(1).max(250)}).strict();
export const inboxReadItemsResponseSchema = z.object({
  results: z.array(z.object({notificationId: exactNotificationIdSchema, outcome: z.enum(["read","already_read","not_found"])}).strict()).min(1).max(250),
  unread: z.object({account: z.number().int().nonnegative(), projects: z.record(z.string(),z.number().int().nonnegative())}).strict(),
}).strict().refine(value=>new Set(value.results.map(item=>item.notificationId)).size===value.results.length);
export type InboxReadItemsResponse = z.infer<typeof inboxReadItemsResponseSchema>;
