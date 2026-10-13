import { z } from "zod"
import { liveActivityPresentationPolicySchema as presentationPolicySchema } from "../index.js"

const nullableDate = z.string().nullable()

export const connectionsShellSchema = z.object({
  title: z.string(),
  description: z.string(),
  active: z.enum([
    "connections",
    "connections-services",
    "connections-phones",
    "connections-clients",
  ]),
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

const summarySchema = z.object({
  services: z.number(),
  phones: z.number(),
  clients: z.number(),
})

const paginationSchema = z.object({
  page: z.number(),
  pageSize: z.literal(25),
  total: z.number(),
  pageCount: z.number(),
  previousHref: z.string().nullable(),
  nextHref: z.string().nullable(),
})

const base = {
  version: z.literal(1),
  route: z.object({ path: z.string(), page: z.number() }),
  shell: connectionsShellSchema,
  summary: summarySchema,
  pagination: paginationSchema,
}

const serviceSchema = z.object({
  id: z.string(),
  title: z.string(),
  prefix: z.string(),
  imageUrl: z.string().nullable(),
  destinationUrl: z.string().nullable(),
  liveActivityPolicy: presentationPolicySchema.nullable(),
  effectiveLiveActivityPolicy: presentationPolicySchema,
  liveActivityPolicySource: z.enum(["service", "account", "system"]),
  createdAt: nullableDate,
})

const phoneSchema = z.object({
  id: z.string(),
  name: z.string(),
  model: z.string(),
  appVersion: z.string(),
  osVersion: z.string(),
  notificationAuthorization: z.string(),
  liveActivityAuthorization: z.string(),
  lastSeenAt: nullableDate,
})

const clientSchema = z.object({
  id: z.string(),
  label: z.string(),
  prefix: z.string(),
  scopes: z.array(z.string()),
  createdAt: nullableDate,
  expiresAt: nullableDate,
  lastUsedAt: nullableDate,
  liveActivityPolicy: presentationPolicySchema.nullable(),
  effectiveLiveActivityPolicy: presentationPolicySchema,
  liveActivityPolicySource: z.enum(["client", "account", "system"]),
  /** At most this many open cards for this login (null: no limit). */
  maxActiveCards: z.number().int().nullable().optional(),
})

export const connectionsOverviewSchema = z.object({
  ...base,
  kind: z.literal("connections"),
  phones: z.array(phoneSchema),
  clients: z.array(clientSchema),
  services: z.array(serviceSchema),
})

export const connectionsDashboardBootstrapSchema = z.discriminatedUnion(
  "kind",
  [connectionsOverviewSchema]
)

export type ConnectionsDashboardBootstrap = z.infer<
  typeof connectionsDashboardBootstrapSchema
>
export type ConnectionsOverview = z.infer<typeof connectionsOverviewSchema>
export type ConnectionService = z.infer<typeof serviceSchema>
export type ConnectionPhone = z.infer<typeof phoneSchema>
export type ConnectionClient = z.infer<typeof clientSchema>
export type ConnectionsPagination = z.infer<typeof paginationSchema>
