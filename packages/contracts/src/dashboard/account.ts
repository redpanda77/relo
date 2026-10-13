import { z } from "zod"
import { liveActivityPresentationPolicySchema as presentationPolicySchema } from "../index.js"

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
  /** Present only for the server admin (ADR 0004): account metadata, never account content. */
  server: z.object({
    registrationMode: z.enum(["closed", "approval", "open"]),
    accounts: z.array(z.object({
      id: z.string(), name: z.string(), email: z.string(),
      status: z.enum(["active", "pending", "disabled"]), admin: z.boolean(),
      createdAt: z.string(), devices: z.number(), sessions: z.number(),
    })),
  }).nullable(),
})

export type AccountDashboardBootstrap = z.infer<
  typeof accountDashboardBootstrapSchema
>
