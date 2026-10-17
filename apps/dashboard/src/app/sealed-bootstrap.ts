import type { DashboardBootstrap } from "@/app/bootstrap"

import { setBrowserLinked, setSealedOpening } from "@/lib/sealed-opening"
import { browserLinkFor, currentBrowserLink, type BrowserLink } from "@/lib/e2ee/browser-link"
import { openSealedTree } from "@/lib/e2ee/open-sealed"

/** The signed-in account of a Dashboard page, or null on the sign-in page. */
export function accountIdOf(bootstrap: DashboardBootstrap): string | null {
  if (bootstrap.kind === "auth" || bootstrap.kind === "docs") return null
  const account = (bootstrap.shell as { account?: { id?: unknown } }).account
  return typeof account?.id === "string" && account.id ? account.id : null
}

/**
 * A synchronous hint that this browser was linked to this account last time it looked: the page can
 * then wait a moment for its sealed text instead of first saying "open on iPhone". Only a hint (the
 * keys and the server decide); written whenever the link's state is known, gone when it is unlinked.
 */
const LINKED_HINT = "relo-linked-browser:"

export function linkedHint(accountId: string | null): boolean {
  if (!accountId) return false
  try {
    return window.localStorage.getItem(LINKED_HINT + accountId) === "1"
  } catch {
    return false
  }
}

function rememberLinked(link: BrowserLink) {
  const write = () => {
    const state = link.getState()
    if (state.status === "linked") setBrowserLinked(true)
    else if (state.status === "unlinked") setBrowserLinked(false)
    try {
      if (state.status === "linked") window.localStorage.setItem(LINKED_HINT + link.accountId, "1")
      else if (state.status === "unlinked") window.localStorage.removeItem(LINKED_HINT + link.accountId)
    } catch {
      // Storage blocked: the page simply never waits for sealed text.
    }
  }
  write()
  link.subscribe(write)
}

const remembered = new WeakSet<BrowserLink>()

/** Starts this browser's keys and registration for the signed-in account (once per page). */
export function startBrowserLink(bootstrap: DashboardBootstrap) {
  const accountId = accountIdOf(bootstrap)
  if (!accountId) return null
  const link = browserLinkFor(accountId)
  if (link) {
    if (!remembered.has(link)) {
      remembered.add(link)
      rememberLinked(link)
    }
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
    const opened = (await openSealedTree(bootstrap, opener)).tree
    // Names this page already shows come back on every retry: an open that changed nothing is the same
    // page, so the retry stops and nothing on screen is swapped (a swap reverts Now to the page load's).
    return opened === bootstrap || JSON.stringify(opened) === JSON.stringify(bootstrap) ? bootstrap : opened
  } catch {
    return bootstrap
  }
}

/** After this long a linked browser stops saying "Opening" and shows the honest lock. */
export const SEALED_OPENING_CAP_MS = 5000

/** One open per page object: the first frame and the router share it. */
const openings = new WeakMap<DashboardBootstrap, Promise<DashboardBootstrap>>()

/** The first page's sealed text, opened once (shared by `openSealedFirst` and the router). */
export function openFirstPageSealed(bootstrap: DashboardBootstrap): Promise<DashboardBootstrap> {
  let opening = openings.get(bootstrap)
  if (!opening) {
    opening = startBrowserLink(bootstrap) ? openSealedBootstrap(bootstrap) : Promise.resolve(bootstrap)
    openings.set(bootstrap, opening)
  }
  return opening
}

/**
 * The first page, opened if a linked browser manages it within `budgetMs`, so it appears already
 * readable. Past the budget the page renders as it came and sealed text says "Opening on this
 * device" until the open lands (the router swaps the text in), fails, or `SEALED_OPENING_CAP_MS`
 * passes; then the lock says "open on iPhone". An unlinked browser waits for nothing.
 */
export async function openSealedFirst(bootstrap: DashboardBootstrap, budgetMs: number): Promise<DashboardBootstrap> {
  const linked = linkedHint(accountIdOf(bootstrap))
  const opening = openFirstPageSealed(bootstrap)
  if (!linked) {
    setSealedOpening(false)
    return bootstrap
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = Symbol("late")
  const first = await Promise.race([
    opening,
    new Promise<typeof late>((resolve) => {
      timer = setTimeout(() => resolve(late), budgetMs)
    }),
  ])
  clearTimeout(timer)
  if (first !== late) return first
  setSealedOpening(true)
  const cap = setTimeout(() => setSealedOpening(false), Math.max(0, SEALED_OPENING_CAP_MS - budgetMs))
  void opening.finally(() => {
    clearTimeout(cap)
    // A success lets the router swap the text in first (it clears the state as it does).
    setTimeout(() => setSealedOpening(false), 0)
  })
  return bootstrap
}
