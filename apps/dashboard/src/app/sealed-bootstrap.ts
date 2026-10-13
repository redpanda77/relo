import type { DashboardBootstrap } from "@/app/bootstrap"

import { browserLinkFor, currentBrowserLink } from "@/lib/e2ee/browser-link"
import { openSealedTree } from "@/lib/e2ee/open-sealed"

/** The signed-in account of a Dashboard page, or null on the sign-in page. */
export function accountIdOf(bootstrap: DashboardBootstrap): string | null {
  if (bootstrap.kind === "auth") return null
  const account = (bootstrap.shell as { account?: { id?: unknown } }).account
  return typeof account?.id === "string" && account.id ? account.id : null
}

/** Starts this browser's keys and registration for the signed-in account (once per page). */
export function startBrowserLink(bootstrap: DashboardBootstrap) {
  const accountId = accountIdOf(bootstrap)
  if (!accountId) return null
  const link = browserLinkFor(accountId)
  if (link) {
    void link.start()
    link.startRotationTimer()
  }
  return link
}

/**
 * The page with every sealed item this linked browser can open replaced by its text. Returns the
 * same object when there is nothing to open, the browser is not linked, or anything fails.
 */
export async function openSealedBootstrap(bootstrap: DashboardBootstrap): Promise<DashboardBootstrap> {
  const accountId = accountIdOf(bootstrap)
  const link = currentBrowserLink()
  if (!accountId || !link || link.accountId !== accountId) return bootstrap
  try {
    const opener = await link.opener()
    if (!opener) return bootstrap
    return (await openSealedTree(bootstrap, opener)).tree
  } catch {
    return bootstrap
  }
}
