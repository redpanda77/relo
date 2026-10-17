import { z } from "zod"
import { deliveryEvidenceItemSchema } from "../delivery-evidence.js"
import { absenceSchema,nowSummarySchema } from "../owner-state.js"

const nullableDate = z.string().nullable()

/**
 * Agent sessions (`ags_…`) whose sealed names envelopes name the handles on this page. Ids only: a
 * linked browser opens them (GET /api/dashboard/sealed) to show names where the page's own
 * envelopes carry none; the server never sends a sealed name in the page.
 */
export const namesFromSchema = z.array(z.string().regex(/^ags_[A-Za-z0-9-]{1,64}$/)).max(20).optional()

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
  account: z.string().nullable(),
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
  // End-to-end sealed (ADR 0005): the readable text is a placeholder; the Dashboard has no key.
  encrypted: z.boolean().optional(),
  // Card digest, additive: matches what the iPhone History row shows.
  outcome: z.enum(["completed", "failed"]).nullable().optional(),
  steps: z
    .object({ done: z.number(), total: z.number(), current: z.string().nullable(), currentIndex: z.number().optional(), fill: z.number().optional() })
    .nullable()
    .optional(),
  updates: z.number().nullable().optional(),
  /** Why the work left the screen or dimmed (the server's derivation); absent for work that needs none. Words: `absenceText`. */
  absence: absenceSchema.optional(),
})

const questionSchema = z.object({
  kind: z.string(),
  // End-to-end sealed (ADR 0005): the readable text is a placeholder; the Dashboard has no key.
  encrypted: z.boolean().optional(),
  prompt: z.string(),
  state: z.string(),
  respondedAt: nullableDate,
  expiresAt: nullableDate,
  /** A choice question's picked option, once answered. */
  chosenLabel: z.string().nullable().optional(),
})

const notificationSummarySchema = z.object({
  id: z.string(),
  // End-to-end sealed (ADR 0005): the readable text is a placeholder; the Dashboard has no key.
  encrypted: z.boolean().optional(),
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
  question: questionSchema.nullable().optional(),
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
  // End-to-end sealed (ADR 0005): the readable text is a placeholder; the Dashboard has no key.
  encrypted: z.boolean().optional(),
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
      encrypted: z.boolean().optional(),
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
  runningActivities: z.array(notificationSummarySchema).optional(),
  /** The derived Now (`/dashboard?since=<ISO>`), the same summary phones read from GET /api/now (no sealed names). */
  now: nowSummarySchema.optional(),
  namesFrom: namesFromSchema,
})

export const notificationHistorySchema = z.object({
  version: z.literal(1),
  kind: z.literal("notification-history"),
  route: z.object({
    path: z.string(),
    page: z.number(),
    /**
     * History's filters, applied on the server across every page. Kinds and states are the owner's
     * words (as on the iPhone); `q` searches only readable fields (sealed items match by source).
     */
    filters: z.object({
      kind: z.enum(["message", "decision", "live_activity", "response"]).nullable(),
      state: z
        .enum(["running", "done", "failed", "stopped", "answered", "missed"])
        .nullable(),
      project: z.string().nullable(),
      source: z.string().nullable().default(null),
      computer: z.string().nullable().default(null),
      q: z.string().nullable().default(null),
    }),
  }),
  filterOptions: z.object({
    projects: z.array(z.string()),
    sources: z.array(z.string()).default([]),
    computers: z.array(z.string()).default([]),
  }),
  shell: inboxShellSchema,
  unread: z.object({
    total: z.number(),
    byProject: z.array(z.object({ project: z.string(), count: z.number() })),
  }).optional(),
  notifications: z.array(notificationSummarySchema),
  pagination: paginationSchema,
  namesFrom: namesFromSchema,
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
    encrypted: z.boolean().optional(),
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
      stepItems: z.array(z.object({ label: z.string(), state: z.string() })).optional(),
      // The work's plan as the phone reads it (plan 12b): steps with parents and rounds, and the rounds.
      // Absent on a card that is not a plan; labels are absent when sealed (opened by step id from the card text).
      plan: z
        .array(
          z.object({
            id: z.string(),
            state: z.enum(["open", "current", "done", "skipped"]),
            label: z.string().optional(),
            parent: z.string().optional(),
            round: z.number().int().positive().optional(),
            detail: z.string().optional(),
            startedAt: z.string().optional(),
            doneAt: z.string().optional(),
          })
        )
        .optional(),
      rounds: z
        .array(
          z.object({
            n: z.number().int().positive(),
            state: z.enum(["open", "closed"]),
            title: z.string().optional(),
            outcome: z.string().optional(),
            openedAt: z.string().optional(),
            closedAt: z.string().optional(),
          })
        )
        .optional(),
      threadHistory: z.array(
        z.object({
          id: z.string(),
          encrypted: z.boolean().optional(),
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
            encrypted: z.boolean().optional(),
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
      /** The question's id (`int_…`), so a linked browser can answer it. */
      id: z.string().optional(),
      kind: z.string(),
      encrypted: z.boolean().optional(),
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
  namesFrom: namesFromSchema,
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
