import { z } from "zod"
import { deliveryEvidenceItemSchema } from "../delivery-evidence.js"

const nullableDate = z.string().nullable()

export const inboxShellSchema = z.object({
  title: z.string(),
  description: z.string(),
  active: z.enum(["inbox", "inbox-notifications", "inbox-delivery"]),
  releaseIdentity: z.string(),
  account: z.object({
    id: z.string(),
    initial: z.string(),
    name: z.string(),
    email: z.string(),
  }),
  counts: z.object({
    pending: z.number(),
    notifications: z.number(),
    deliveries: z.number(),
  }),
})

const paginationSchema = z.object({
  page: z.number(),
  pageSize: z.literal(25),
  total: z.number(),
  pageCount: z.number(),
  previousHref: z.string().nullable(),
  nextHref: z.string().nullable(),
})

const activityContextSchema = z.object({
  providerName: z.string().nullable(),
  producerKind: z.string().nullable(),
  computer: z.string().nullable(),
  project: z.string().nullable(),
  providerThreadId: z.string().nullable(),
  providerWorkItemId: z.string().nullable(),
  threadName: z.string().nullable(),
  taskTitle: z.string().nullable(),
  threadNameSource: z.string().nullable(),
  taskTitleSource: z.string().nullable(),
})

const activitySummarySchema = z.object({
  id: z.string(),
  operation: z.string(),
  eventSequence: z.number(),
  generation: z.number(),
  sequence: z.number(),
  state: z.string(),
  title: z.string(),
  status: z.string(),
  detail: z.string().nullable(),
  progress: z.number().nullable(),
  originThreadId: z.string().nullable(),
  conversationId: z.string().nullable(),
  workItemId: z.string().nullable(),
  lifecycle: z.object({ provider: z.string(), runId: z.string() }).nullable(),
  context: activityContextSchema,
  createdAt: nullableDate,
  updatedAt: nullableDate,
  staleAt: nullableDate,
  expiresAt: nullableDate,
  endedAt: nullableDate,
  terminalReason: z.string().nullable(),
  terminalActor: z.string().nullable(),
  terminalPolicy: z.string().nullable(),
  terminalTransitionAt: nullableDate,
  presentationPresetId: z.string().nullable(),
  presentationPresetRevision: z.number().nullable(),
  presentationPolicySource: z.string().nullable(),
})

const notificationSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  body: z.string(),
  source: z.string(),
  requesterKind: z.enum(["cli", "webhook", "dashboard"]),
  kind: z.string(),
  state: z.string(),
  readAt: nullableDate.optional(),
  withdrawnAt: nullableDate.optional(),
  createdAt: nullableDate,
  destination: z.discriminatedUnion("state", [
    z.object({ state: z.literal("safe"), href: z.string().url() }),
    z.object({ state: z.enum(["unsafe", "not-set"]), href: z.null() }),
  ]),
  targetDeviceNames: z.array(z.string()),
  response: z
    .object({ action: z.string(), respondedAt: nullableDate })
    .nullable(),
  context: activityContextSchema,
  originThreadId: z.string().nullable(),
  activity: activitySummarySchema.nullable(),
  resources: z.object({
    source: z.object({
      id: z.string(),
      kind: z.string(),
      name: z.string(),
    }),
    project: z.object({
      id: z.string(),
      name: z.string(),
      isDirect: z.boolean(),
      palette: z.object({ slot: z.number(), generation: z.number() }),
      icon: z.string(),
      revision: z.number(),
    }),
    conversationId: z.string().nullable(),
    workItemId: z.string().nullable(),
  }).nullable().optional(),
})

const deliverySummarySchema = z.object({
  id: z.string(),
  notificationId: z.string(),
  title: z.string(),
  source: z.string(),
  deviceName: z.string(),
  transport: z.string(),
  state: z.string(),
  attemptCount: z.number(),
  providerMessageId: z.string().nullable(),
  serialization: z.object({
    canonicalIntent: z.string().nullable(),
    deviceProjection: z.string().nullable(),
    providerBytes: z.string().nullable(),
  }).optional(),
  error: z
    .object({ code: z.string(), message: z.string().nullable() })
    .nullable(),
  reconciliation: z.object({
    required: z.boolean(),
    allowedActions: z.array(z.enum(["mark_accepted", "retry", "cancel"])),
    resolvedAction: z.string().nullable(),
  }),
  acceptedAt: nullableDate,
  createdAt: nullableDate,
  updatedAt: nullableDate,
})

export const inboxOverviewSchema = z.object({
  version: z.literal(1),
  kind: z.literal("inbox-overview"),
  route: z.object({ path: z.string(), page: z.number() }),
  shell: inboxShellSchema,
  summary: z.object({
    pendingResponses: z.number(),
    pendingApprovals: z.number(),
    notifications: z.number(),
    deliveries: z.number(),
  }),
  pendingResponses: z.array(
    z.object({
      notificationId: z.string(),
      title: z.string(),
      source: z.string(),
      kind: z.string(),
      state: z.string(),
      prompt: z.string(),
      targetDeviceNames: z.array(z.string()),
      createdAt: nullableDate,
      expiresAt: nullableDate,
    })
  ),
  approvalRequests: z.array(
    z.object({
      userCode: z.string(),
      clientName: z.string(),
      requestedScopes: z.array(z.string()),
      approvalExpiresAt: nullableDate,
      credentialExpiresAt: nullableDate,
    })
  ),
  approvalPagination: paginationSchema,
  recentNotifications: z.array(notificationSummarySchema),
})

export const notificationHistorySchema = z.object({
  version: z.literal(1),
  kind: z.literal("notification-history"),
  route: z.object({
    path: z.string(),
    page: z.number(),
    filters: z.object({
      kind: z
        .enum(["notification", "approval", "question", "live_activity"])
        .nullable(),
      state: z
        .enum([
          "active",
          "recorded",
          "ended",
          "responded",
          "expired",
          "replaced",
          "canceled",
        ])
        .nullable(),
      project: z.string().nullable(),
    }),
  }),
  filterOptions: z.object({ projects: z.array(z.string()) }),
  shell: inboxShellSchema,
  unread: z.object({
    total: z.number(),
    byProject: z.array(z.object({ project: z.string(), count: z.number() })),
  }).optional(),
  notifications: z.array(notificationSummarySchema),
  pagination: paginationSchema,
})

export const deliveryHistorySchema = z.object({
  version: z.literal(1),
  kind: z.literal("delivery-history"),
  route: z.object({ path: z.string(), page: z.number() }),
  shell: inboxShellSchema,
  deliveries: z.array(deliverySummarySchema),
  pagination: paginationSchema,
})

export const notificationDetailSchema = z.object({
  version: z.literal(1),
  kind: z.literal("notification-detail"),
  route: z.object({
    path: z.string(),
    backHref: z.literal("/dashboard/inbox/notifications"),
  }),
  shell: inboxShellSchema,
  notification: z.object({
    id: z.string(),
    source: z.string(),
    serviceTitle: z.string().nullable(),
    kind: z.string(),
    title: z.string(),
    body: z.string(),
    bodyFormat: z.enum(["text", "markdown"]).optional(),
    readAt: nullableDate.optional(),
    withdrawnAt: nullableDate.optional(),
    state: z.string(),
    privacy: z.string(),
    targetMode: z.string(),
    createdAt: nullableDate,
    updatedAt: nullableDate,
    expiresAt: nullableDate,
    destination: z.discriminatedUnion("state", [
      z.object({ state: z.literal("safe"), href: z.string().url() }),
      z.object({ state: z.enum(["unsafe", "not-set"]), href: z.null() }),
    ]),
  }),
  activity: activitySummarySchema
    .extend({
      threadHistory: z.array(
        z.object({
          id: z.string(),
          generation: z.number().int().positive(),
          state: z.string(),
          title: z.string(),
          status: z.string(),
          taskTitle: z.string().nullable(),
          createdAt: nullableDate,
          updatedAt: nullableDate,
          endedAt: nullableDate,
          terminalReason: z.string().nullable(),
          current: z.boolean(),
        })
      ),
      timeline: z.array(
        z.object({
          operation: z.string(),
          sequence: z.number(),
          state: z.string().nullable(),
          status: z.string().nullable(),
          createdAt: nullableDate,
        })
      ),
      presentationLeases: z.array(
        z.object({
          deviceId: z.string(),
          deviceName: z.string(),
          state: z.string(),
          reason: z.string(),
          relevanceScore: z.number(),
          lastCommandSequence: z.number().nullable(),
          selectedAt: nullableDate,
          lastAppliedAt: nullableDate,
          endedAt: nullableDate,
        })
      ),
      relationships: z.array(
        z.object({
          id: z.string(),
          kind: z.string(),
          direction: z.enum(["predecessor", "successor"]),
          relatedActivity: z.object({
            id: z.string(),
            title: z.string(),
            state: z.string(),
            generation: z.number().int().positive(),
          }),
          actor: z.string(),
          reason: z.string(),
          provenance: z.string(),
          createdAt: nullableDate,
        })
      ),
      correlationDecisions: z.array(
        z.object({
          id: z.string(),
          outcome: z.string(),
          matchedBy: z.string(),
          actor: z.string(),
          reason: z.string(),
          provenance: z.string(),
          relationshipId: z.string().nullable(),
          createdAt: nullableDate,
        })
      ),
    })
    .nullable(),
  interaction: z
    .object({
      kind: z.string(),
      state: z.string(),
      action: z.string().nullable(),
      prompt: z.string(),
      responseText: z.string().nullable(),
      respondingDevice: z
        .object({ id: z.string(), name: z.string() })
        .nullable(),
      createdAt: nullableDate,
      expiresAt: nullableDate,
      respondedAt: nullableDate,
    })
    .nullable(),
  deliveries: z.array(deliverySummarySchema),
  evidenceTimeline: z.array(deliveryEvidenceItemSchema),
  receipts: z.array(
    z.object({
      kind: z.string(),
      deviceName: z.string(),
      createdAt: nullableDate,
    })
  ),
})

export const inboxDashboardBootstrapSchema = z.discriminatedUnion("kind", [
  inboxOverviewSchema,
  notificationHistorySchema,
  deliveryHistorySchema,
  notificationDetailSchema,
])

export type InboxDashboardBootstrap = z.infer<
  typeof inboxDashboardBootstrapSchema
>
export type InboxOverview = z.infer<typeof inboxOverviewSchema>
export type NotificationHistory = z.infer<typeof notificationHistorySchema>
export type DeliveryHistory = z.infer<typeof deliveryHistorySchema>
export type NotificationDetail = z.infer<typeof notificationDetailSchema>
export type NotificationSummary = z.infer<typeof notificationSummarySchema>
export type DeliverySummary = z.infer<typeof deliverySummarySchema>
export type InboxPagination = z.infer<typeof paginationSchema>
