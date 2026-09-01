import { z } from "zod"

import { accountDashboardBootstrapSchema } from "@/features/account/types"
import { dashboardAuthSchema } from "@/features/auth/types"
import { connectionsDashboardBootstrapSchema } from "@/features/connections/types"
import { documentationDashboardBootstrapSchema } from "@/features/docs/types"
import { inboxDashboardBootstrapSchema } from "@/features/inbox/types"
import { projectsDashboardBootstrapSchema } from "@/features/projects/types"
import { activityHistorySchema } from "@/features/test-lab/activity-history"
import { testLabBootstrapSchema } from "@/features/test-lab/types"

export const dashboardBootstrapSchema = z.union([
  dashboardAuthSchema,
  testLabBootstrapSchema,
  activityHistorySchema,
  inboxDashboardBootstrapSchema,
  projectsDashboardBootstrapSchema,
  connectionsDashboardBootstrapSchema,
  accountDashboardBootstrapSchema,
  documentationDashboardBootstrapSchema,
])

export type DashboardBootstrap = z.infer<typeof dashboardBootstrapSchema>
export type AuthenticatedDashboardBootstrap = Exclude<
  DashboardBootstrap,
  { kind: "auth" }
>

export function readDashboardBootstrap(
  documentRoot: Document = document
): DashboardBootstrap {
  const node = documentRoot.getElementById("relo-dashboard-bootstrap")
  if (!node?.textContent)
    throw new Error("Dashboard bootstrap data is unavailable.")
  return dashboardBootstrapSchema.parse(JSON.parse(node.textContent))
}
