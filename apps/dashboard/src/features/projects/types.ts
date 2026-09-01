import { z } from "zod"

const projectSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  displayNameSource: z.enum(["producer", "owner", "derived"]),
  isDirect: z.boolean(),
  provenance: z.string(),
  palette: z.object({
    slot: z.number().int().nonnegative(),
    generation: z.number().int().nonnegative(),
  }),
  icon: z.string(),
  revision: z.number(),
  archivedAt: z.string().nullable(),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  counts: z.object({
    conversations: z.number(),
    notifications: z.number(),
    activities: z.number(),
  }),
})

export const projectsDashboardBootstrapSchema = z.object({
  version: z.literal(1),
  kind: z.literal("projects"),
  route: z.object({ path: z.string(), selectedProjectId: z.string().nullable() }),
  shell: z.object({
    title: z.literal("Projects"),
    description: z.string(),
    active: z.literal("projects"),
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
  }),
  summary: z.object({
    active: z.number(),
    direct: z.number(),
    archived: z.number(),
    conversations: z.number(),
  }),
  projects: z.array(projectSchema),
  selected: z.object({
    project: projectSchema,
    aliases: z.array(z.object({
      id: z.string(),
      name: z.string(),
      provenance: z.string(),
      createdAt: z.string(),
    })),
    conversations: z.array(z.object({
      id: z.string(),
      name: z.string(),
      producerKind: z.string(),
      assignmentSource: z.enum(["producer", "owner"]),
      lastSeenAt: z.string(),
    })),
    recent: z.array(z.object({
      id: z.string(),
      kind: z.enum(["notification", "activity"]),
      title: z.string(),
      state: z.string(),
      occurredAt: z.string(),
    })),
  }).nullable(),
})

export type ProjectsDashboardBootstrap = z.infer<typeof projectsDashboardBootstrapSchema>
export type DashboardProject = ProjectsDashboardBootstrap["projects"][number]
