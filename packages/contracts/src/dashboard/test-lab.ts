import { z } from "zod"

const evidenceSchema = z.object({
  provider: z.object({
    state: z.string().nullable(),
    durableCommands: z.number(),
    apnsJobs: z.number(),
  }),
  phone: z.object({ expected: z.number(), confirmed: z.number() }),
  activityKit: z
    .object({ state: z.string().nullable(), summary: z.string().nullable() })
    .default({ state: null, summary: null }),
  response: z.object({
    kind: z.string().nullable(),
    state: z.string().nullable(),
    action: z.string().nullable(),
    respondedAt: z.string().nullable(),
  }),
})

const actionSchema = z.object({ action: z.string(), label: z.string() })
const contentSchema = z.object({
  header: z.string().nullable(),
  title: z.string(),
  subtitle: z.string().nullable(),
  status: z.string(),
})
const stepSchema = z.object({
  id: z.string(),
  label: z.string(),
  state: z.enum(["complete", "current", "pending"]),
})
const behaviorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("informational") }),
  z.object({ type: z.literal("progress") }),
  z.object({
    type: z.literal("approval"),
    primary: actionSchema,
    secondary: actionSchema,
  }),
  z.object({
    type: z.literal("yes_no"),
    primary: actionSchema,
    secondary: actionSchema,
  }),
])

const identityRoleSchema = z.enum([
  "project",
  "thread",
  "state",
  "control",
  "neutral",
])
const identityTokenSchema = z.object({
  label: z.string(),
  color: z.string(),
  icon: z.string(),
  revision: z.number().int().positive(),
  provenance: z.enum(["generated", "owner"]),
})
const presentationComponentSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string(),
    type: z.literal("progress_bar"),
    colorRole: identityRoleSchema,
    value: z.number(),
    label: z.string().nullable(),
  }),
  z.object({
    id: z.string(),
    type: z.literal("steps"),
    colorRole: identityRoleSchema,
    items: z.array(stepSchema),
  }),
  z.object({
    id: z.string(),
    type: z.literal("image"),
    colorRole: identityRoleSchema,
    asset: z.record(z.string(), z.unknown()),
    altText: z.string(),
    contentMode: z.enum(["fit", "fill"]),
  }),
])
const presentationSchema = z.object({
  content: contentSchema,
  identity: z.object({
    project: identityTokenSchema.nullable(),
    thread: identityTokenSchema.nullable(),
    direct: z.boolean(),
  }),
  state: z.object({ kind: z.string(), tone: z.string(), icon: z.string() }),
  components: z.array(presentationComponentSchema),
  surfaces: z.object({
    lock_screen: z.array(z.string()),
    expanded_leading: z.array(z.string()),
    expanded_trailing: z.array(z.string()),
    expanded_bottom: z.array(z.string()),
    compact_leading: z.array(z.string()),
    compact_trailing: z.array(z.string()),
    minimal: z.array(z.string()),
  }),
  behavior: behaviorSchema,
  appearance: z.object({
    theme: z.enum(["system", "light", "dark"]),
    roles: z.object({
      cardIdentity: identityRoleSchema,
      componentIdentity: identityRoleSchema,
      statusEmphasis: identityRoleSchema,
    }),
    progressDisplay: z.enum(["bar", "ring"]).optional(),
  }),
  privacy: z.enum(["standard", "private"]),
})
export const testLabBootstrapSchema = z.object({
  version: z.literal(1),
  kind: z.literal("test-lab"),
  route: z.object({
    path: z.string(),
    selectedActivityId: z.string().nullable(),
    compose: z.boolean(),
  }),
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
  summary: z.object({
    total: z.number(),
    active: z.number(),
    awaitingProvider: z.number(),
    awaitingPhone: z.number(),
    awaitingResponse: z.number(),
  }),
  devices: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      model: z.string().nullable(),
      appVersion: z.string().nullable(),
      osVersion: z.string().nullable(),
      notificationAuthorization: z.string(),
      liveActivityAuthorization: z.string(),
      lastSeenAt: z.string().nullable(),
      ready: z.boolean(),
    })
  ),
  runs: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      detail: z.string().nullable(),
      style: z.string(),
      status: z.string(),
      state: z.string(),
      progress: z.number().nullable(),
      generation: z.number().int().positive(),
      sequence: z.number(),
      presentation: presentationSchema.nullable(),
      targetDeviceIds: z.array(z.string()),
      targetDeviceName: z.string().nullable(),
      requesterLabel: z.string(),
      ownerControlled: z.boolean(),
      ownerKind: z.enum([
        "provider_run",
        "service_run",
        "manual_key",
        "credential_session",
        "dashboard_test",
      ]),
      evidence: evidenceSchema,
      createdAt: z.string().nullable(),
      updatedAt: z.string().nullable(),
    })
  ),
  composer: z.object({
    defaultPreset: z.string(),
    presets: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        presentation: presentationSchema,
      })
    ),
  }),
})

export type TestLabBootstrap = z.infer<typeof testLabBootstrapSchema>
export type TestRun = TestLabBootstrap["runs"][number]
export type TestDevice = TestLabBootstrap["devices"][number]

export type BuilderDraft = {
  deviceId: string
  preset: string
  behavior: string
  visual: string
  progress: number
  progressLabel: string
  stepLabels: string
  stepCurrent: number
  primaryLabel: string
  secondaryLabel: string
  title: string
  status: string
  header: string
  subtitle: string
  symbol: string
  theme: string
  accentColor: string
  allowParallel: boolean
}

export type RouteState =
  { kind: "monitor" } | { kind: "new" } | { kind: "run"; runId: string }
