import type { DashboardBootstrap } from "@/app/bootstrap"

/**
 * A page's code, loaded once. The promise is marked fulfilled when it settles (React reads that
 * mark), so once main.tsx has preloaded the page React's first render finds it ready instead of
 * committing the loading fallback over the server's first frame.
 */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let promise: (Promise<T> & { status?: string; value?: T }) | null = null
  return () => {
    if (!promise) {
      const pending: Promise<T> & { status?: string; value?: T } = load().then((value) => {
        pending.status = "fulfilled"
        pending.value = value
        return value
      })
      pending.catch(() => {
        // A failed load is retried by the next call (a navigation, a reload).
        if (promise === pending) promise = null
      })
      promise = pending
    }
    return promise
  }
}

export const loadAccountPage = once(() =>
  import("@/features/account/account-page").then((module) => ({
    default: module.AccountPage,
  })))

export const loadConnectionsFeature = once(() =>
  import("@/features/connections/connections-feature").then((module) => ({
    default: module.ConnectionsFeature,
  })))

export const loadInboxFeature = once(() =>
  import("@/features/inbox/inbox-feature").then((module) => ({
    default: module.InboxFeature,
  })))

export const loadActivityHistoryPage = once(() =>
  import("@/features/test-lab/activity-history-page").then((module) => ({
    default: module.ActivityHistoryPage,
  })))

export const loadTestLabPage = once(() =>
  import("@/features/test-lab/test-lab-page").then((module) => ({
    default: module.TestLabPage,
  })))

export function preloadDashboardPage(bootstrap: DashboardBootstrap) {
  switch (bootstrap.kind) {
    case "auth":
    case "docs":
      return Promise.resolve()
    case "test-lab":
      return loadTestLabPage()
    case "activity-history":
      return loadActivityHistoryPage()
    case "connections":
      return loadConnectionsFeature()
    case "account":
      return loadAccountPage()
    case "inbox-overview":
    case "notification-history":
    case "delivery-history":
    case "notification-detail":
      return loadInboxFeature()
    default:
      return bootstrap satisfies never
  }
}

/** Fetch every section's code after first paint so later navigations never show a loading frame. */
export function preloadAllDashboardPages() {
  const load = () => {
    for (const loader of [loadInboxFeature, loadConnectionsFeature, loadTestLabPage,
      loadActivityHistoryPage, loadAccountPage]) void loader().catch(() => undefined)
  }
  if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(load, { timeout: 2000 })
  else setTimeout(load, 300)
}
