import type { DashboardBootstrap } from "@/app/bootstrap"

export const loadAccountPage = () =>
  import("@/features/account/account-page").then((module) => ({
    default: module.AccountPage,
  }))

export const loadConnectionsFeature = () =>
  import("@/features/connections/connections-feature").then((module) => ({
    default: module.ConnectionsFeature,
  }))

export const loadDocumentationPage = () =>
  import("@/features/docs/documentation-page").then((module) => ({
    default: module.DocumentationPage,
  }))

export const loadInboxFeature = () =>
  import("@/features/inbox/inbox-feature").then((module) => ({
    default: module.InboxFeature,
  }))

export const loadProjectsPage = () =>
  import("@/features/projects/projects-page").then((module) => ({
    default: module.ProjectsPage,
  }))

export const loadActivityHistoryPage = () =>
  import("@/features/test-lab/activity-history-page").then((module) => ({
    default: module.ActivityHistoryPage,
  }))

export const loadTestLabPage = () =>
  import("@/features/test-lab/test-lab-page").then((module) => ({
    default: module.TestLabPage,
  }))

export function preloadDashboardPage(bootstrap: DashboardBootstrap) {
  switch (bootstrap.kind) {
    case "auth":
      return Promise.resolve()
    case "test-lab":
      return loadTestLabPage()
    case "activity-history":
      return loadActivityHistoryPage()
    case "connections":
      return loadConnectionsFeature()
    case "account":
      return loadAccountPage()
    case "docs":
      return loadDocumentationPage()
    case "inbox-overview":
    case "notification-history":
    case "delivery-history":
    case "notification-detail":
      return loadInboxFeature()
    case "projects":
      return loadProjectsPage()
    default:
      return bootstrap satisfies never
  }
}

/** Fetch every section's code after first paint so later navigations never show a loading frame. */
export function preloadAllDashboardPages() {
  const load = () => {
    for (const loader of [loadInboxFeature, loadProjectsPage, loadConnectionsFeature, loadTestLabPage,
      loadActivityHistoryPage, loadAccountPage, loadDocumentationPage]) void loader().catch(() => undefined)
  }
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(load, { timeout: 2000 })
  else setTimeout(load, 300)
}
