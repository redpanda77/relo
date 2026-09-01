import { z } from "zod"
import { presentationPolicySchema } from "@/features/presentation-policy/types"

const nullableDate = z.string().nullable()

export const connectionsShellSchema = z.object({
  title: z.string(),
  description: z.string(),
  active: z.enum([
    "connections-pairing",
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

export const connectionsPairingSchema = z.object({
  ...base,
  kind: z.literal("connections-pairing"),
  grants: z.array(
    z.object({
      id: z.string(),
      prefix: z.string(),
      status: z.enum(["pending", "consumed", "expired", "revoked"]),
      createdAt: z.string(),
      expiresAt: z.string(),
      consumedAt: z.string().nullable(),
    })
  ),
})

export const connectionsServicesSchema = z.object({
  ...base,
  kind: z.literal("connections-services"),
  services: z.array(
    z.object({
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
  ),
})

export const connectionsPhonesSchema = z.object({
  ...base,
  kind: z.literal("connections-phones"),
  phones: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      model: z.string(),
      appVersion: z.string(),
      osVersion: z.string(),
      notificationAuthorization: z.string(),
      liveActivityAuthorization: z.string(),
      lastSeenAt: nullableDate,
    })
  ),
})

export const connectionsClientsSchema = z.object({
  ...base,
  kind: z.literal("connections-clients"),
  clients: z.array(
    z.object({
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
    })
  ),
})

export const connectionsDashboardBootstrapSchema = z.discriminatedUnion(
  "kind",
  [
    connectionsPairingSchema,
    connectionsServicesSchema,
    connectionsPhonesSchema,
    connectionsClientsSchema,
  ]
)

export type ConnectionsDashboardBootstrap = z.infer<
  typeof connectionsDashboardBootstrapSchema
>
export type ConnectionsServices = z.infer<typeof connectionsServicesSchema>
export type ConnectionsPairing = z.infer<typeof connectionsPairingSchema>
export type ConnectionsPhones = z.infer<typeof connectionsPhonesSchema>
export type ConnectionsClients = z.infer<typeof connectionsClientsSchema>
export type ConnectionService = ConnectionsServices["services"][number]
export type ConnectionPhone = ConnectionsPhones["phones"][number]
export type ConnectionClient = ConnectionsClients["clients"][number]
export type ConnectionsPagination = z.infer<typeof paginationSchema>
