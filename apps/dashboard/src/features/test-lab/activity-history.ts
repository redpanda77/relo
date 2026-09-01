import { z } from "zod"

const nullableDate = z.string().nullable()

export const activityHistorySchema = z.object({
  version: z.literal(1),
  kind: z.literal("activity-history"),
  route: z.object({ path: z.string(), backHref: z.string() }),
  shell: z.object({
    title: z.string(),
    description: z.string(),
    active: z.literal("testing"),
    releaseIdentity: z.string(),
    account: z.object({
      id: z.string(),
      initial: z.string(),
      name: z.string(),
      email: z.string(),
    }),
  }),
  activity: z.object({
    id: z.string(),
    key: z.string(),
    title: z.string(),
    status: z.string(),
    detail: z.string().nullable(),
    progress: z.number().nullable(),
    symbol: z.string(),
    style: z.string(),
    privacy: z.string(),
    accentColor: z.string(),
    state: z.string(),
    generation: z.number().int().positive(),
    sequence: z.number().int().nonnegative(),
    lifecycle: z
      .object({ provider: z.string().min(1), runId: z.string().min(1) })
      .nullable(),
    requesterLabel: z.string(),
    expiresAt: nullableDate,
    staleAt: nullableDate,
    createdAt: nullableDate,
    updatedAt: nullableDate,
    endedAt: nullableDate,
  }),
  targetDevices: z.array(
    z.object({ id: z.string(), name: z.string(), lastSeenAt: nullableDate })
  ),
  operations: z.array(
    z.object({
      operation: z.string(),
      resultingSequence: z.number().int().nonnegative(),
      durableCommands: z.number().int().nonnegative(),
      apnsJobs: z.number().int().nonnegative(),
      dismissAfterSeconds: z.number().int().nonnegative().nullable(),
      companionActivityId: z.string().nullable(),
      createdAt: nullableDate,
    })
  ),
  events: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      title: z.string(),
      state: z.string(),
      createdAt: nullableDate,
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

export type ActivityHistory = z.infer<typeof activityHistorySchema>
