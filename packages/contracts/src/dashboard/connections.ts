import { z } from "zod"
import { liveActivityPresentationPolicySchema as presentationPolicySchema } from "../index.js"
import { computerIconSchema,computerIconSourceSchema,computerReportSchema } from "../computers.js"
import { FACTS } from "../facts.js"
import { SCOPES, scopesFor, type Scope } from "../scopes.js"

const nullableDate = z.string().nullable()

export const connectionsShellSchema = z.object({
  title: z.string(),
  description: z.string(),
  active: z.literal("connections"),
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

/** What a webhook service may do: the `hooks:*` family of the scope registry. */
export type ServiceScope = {
  [K in Scope]: "service" extends (typeof SCOPES)[K]["kinds"][number] ? K : never
}[Scope]
export const SERVICE_SCOPES = scopesFor("service") as [ServiceScope, ...ServiceScope[]]
export const serviceScopeSchema = z.enum(SERVICE_SCOPES)

const serviceSchema = z.object({
  id: z.string(),
  title: z.string(),
  prefix: z.string(),
  imageUrl: z.string().nullable(),
  destinationUrl: z.string().nullable(),
  liveActivityPolicy: presentationPolicySchema.nullable(),
  effectiveLiveActivityPolicy: presentationPolicySchema,
  liveActivityPolicySource: z.enum(["service", "account", "system"]),
  /** On an account that requires encryption, may this service send readable content (services cannot seal)? */
  readableAllowed: z.boolean(),
  /** What it may do; at least one. */
  scopes: z.array(serviceScopeSchema).min(1),
  lastUsedAt: nullableDate,
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

/** What a CLI login, and so a CI token, may hold: the registry's login scopes, as a precise union. */
export type LoginScope = {
  [K in Scope]: "login" extends (typeof SCOPES)[K]["kinds"][number] ? K : never
}[Scope]
export const LOGIN_SCOPES = scopesFor("login") as [LoginScope, ...LoginScope[]]

/** What a key on principal_api_keys is: a CLI login (browser sign-in) or a CI token the owner made for a pipeline. */
export const clientKindSchema = z.enum(["login", "ci-token"])
export type ClientKind = z.infer<typeof clientKindSchema>

/** A CI token's lifetimes the Dashboard offers, in days; the default and the most a token may live come from the facts. */
export const CI_TOKEN_DEFAULT_DAYS = FACTS.credentials.ciTokenDefaultDays
export const CI_TOKEN_MAX_DAYS = FACTS.credentials.ciTokenMaxDays
export const CI_TOKEN_EXPIRY_CHOICES = [7, 30, 60, CI_TOKEN_MAX_DAYS] as const

const clientSchema = z.object({
  id: z.string(),
  /** A login, or a CI token (which always has `expiresAt`). */
  kind: clientKindSchema,
  /** The name the owner or the sign-in gave it. */
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
}).refine((client) => client.kind !== "ci-token" || client.expiresAt !== null, {
  message: "A CI token always expires.",
  path: ["expiresAt"],
})

/** A hooks credential (kind "harness"): posts observed session state only. */
const harnessCredentialSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  createdAt: z.string(),
  lastUsedAt: nullableDate,
})

/**
 * A computer (ADR 0011): one per CLI login, with the name and icon the owner chose, the tools that ran
 * there and the hooks credentials minted by it. Per-login settings (card limit, Live Activity policy,
 * revoke) are keyed by `loginId`.
 */
const computerRecordSchema = z.object({
  /** `cmp_…` */
  id: z.string(),
  /** The login's public id (`key_…`), for the per-login routes. */
  loginId: z.string(),
  /** The display name: the owner's rename, else the login's label. */
  name: z.string(),
  /** The login's own label, which a rename never changes. */
  label: z.string(),
  icon: computerIconSchema,
  iconSource: computerIconSourceSchema,
  /** Harnesses (claude-code, codex, …) that ran a work here in the last 30 days. */
  tools: z.array(z.string()),
  openCards: z.number().int().nonnegative(),
  lastSeenAt: nullableDate,
  createdAt: nullableDate,
  expiresAt: nullableDate,
  prefix: z.string(),
  scopes: z.array(z.string()),
  encryption: z.enum(["encrypts", "no_keys"]),
  hooks: z.array(harnessCredentialSchema),
  liveActivityPolicy: presentationPolicySchema.nullable(),
  effectiveLiveActivityPolicy: presentationPolicySchema,
  liveActivityPolicySource: z.enum(["client", "account", "system"]),
  /** At most this many open cards for this computer (null: no limit). */
  maxActiveCards: z.number().int().nullable(),
  /** What the machine reported about its own setup (ADR 0011); null until it sends one. */
  report: computerReportSchema.nullable(),
  reportedAt: nullableDate,
})

export const connectionsOverviewSchema = z.object({
  ...base,
  kind: z.literal("connections"),
  phones: z.array(phoneSchema),
  computers: z.array(computerRecordSchema),
  /** Hooks credentials that show under no computer (minted before computers, or by a login revoked since). */
  unlinkedHooks: z.array(harnessCredentialSchema),
  /** CI tokens (kind "ci-token"), each with its expiry. */
  ciTokens: z.array(clientSchema),
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
export type ConnectionComputer = z.infer<typeof computerRecordSchema>
export type ConnectionClient = z.infer<typeof clientSchema>
export type ConnectionHarnessCredential = z.infer<typeof harnessCredentialSchema>
export type ConnectionsPagination = z.infer<typeof paginationSchema>
