import type { DashboardBootstrap } from "@/app/bootstrap"
import { waitingPrefix } from "@/lib/attention"

/** What waits on the owner: Now's live count while it is open, else the page's own (0 off the dashboard). */
export function dashboardWaiting(bootstrap: DashboardBootstrap, live: number | null) {
  if (bootstrap.kind === "auth" || bootstrap.kind === "docs") return 0
  const { shell } = bootstrap
  return live ?? ("counts" in shell && shell.counts ? shell.counts.pending : 0)
}

/** The tab's title; a waiting count leads it ("(3) Now · Relo"), as the iPhone badges its icon. */
export function dashboardTitle(bootstrap: DashboardBootstrap, live: number | null = null) {
  if (bootstrap.kind === "auth" && bootstrap.view === "landing") return "Relo · Every agent, one place"
  if (bootstrap.kind === "auth") return `${bootstrap.title} · Relo`
  if (bootstrap.kind === "docs") return `${bootstrap.page?.title ?? "Page not found"} · Relo docs`
  return `${waitingPrefix(dashboardWaiting(bootstrap, live))}${bootstrap.shell.title} · Relo`
}
