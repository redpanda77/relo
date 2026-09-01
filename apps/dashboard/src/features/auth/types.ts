import { z } from "zod"

export const dashboardAuthSchema = z.object({
  version: z.literal(1),
  kind: z.literal("auth"),
  route: z.object({ path: z.literal("/"), nextPath: z.string() }),
  mode: z.enum(["sign-in", "sign-up"]),
  title: z.string(),
  description: z.string(),
})

export type DashboardAuth = z.infer<typeof dashboardAuthSchema>
