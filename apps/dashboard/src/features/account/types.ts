import { z } from "zod"
import { presentationPolicySchema } from "@/features/presentation-policy/types"

export const accountDashboardBootstrapSchema = z.object({
  version: z.literal(1),
  kind: z.literal("account"),
  route: z.object({ path: z.literal("/dashboard/account") }),
  shell: z.object({
    title: z.literal("Account"),
    description: z.string(),
    active: z.literal("account"),
    releaseIdentity: z.string(),
    account: z.object({
      id: z.string(),
      initial: z.string(),
      name: z.string(),
      email: z.string(),
    }),
  }),
  account: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    serverOrigin: z.string().url(),
    authentication: z.literal("Better Auth email/password session"),
    liveActivityPolicy: presentationPolicySchema,
    liveActivityPolicySource: z.enum(["account", "system"]),
  }),
  users: z.array(z.object({
    id: z.string(), name: z.string(), email: z.string(),
    role: z.enum(["owner", "member"]), disabled: z.boolean(),
    sessions: z.number(), devices: z.number(),
  })),
})

export type AccountDashboardBootstrap = z.infer<
  typeof accountDashboardBootstrapSchema
>
