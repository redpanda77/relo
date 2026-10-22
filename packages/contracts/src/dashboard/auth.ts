import { z } from "zod"

export const dashboardAuthSchema = z.object({
  version: z.literal(1),
  kind: z.literal("auth"),
  /** The landing page at "/" for signed-out visitors to a claimed server; the form otherwise. */
  view: z.enum(["landing", "form"]),
  route: z.object({ path: z.enum(["/", "/sign-in"]), nextPath: z.string() }),
  mode: z.enum(["sign-in", "sign-up"]),
  registration: z.enum(["closed", "approval", "open"]),
  title: z.string(),
  description: z.string(),
  /** The launch film under the landing hero: its files' base URL (the server's RELO_LANDING_FILM_URL). */
  film: z.object({ base: z.url() }).optional(),
})

export type DashboardAuth = z.infer<typeof dashboardAuthSchema>
