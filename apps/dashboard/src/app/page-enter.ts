/**
 * How a new page enters, set on <html data-page-enter> for one short window (`nav.css`):
 * - `tab`: a sibling page (sidebar, tab bar, a jump): a quick crossfade, nothing travels.
 * - `push`: a detail page (it has a way back): it slides in from the right.
 * - `pop`: back up to the parent from a detail page: the parent returns from the left.
 * - `fade`: the page replaces its loading skeleton: opacity only, so the shape never shifts.
 * History traversal (Back, Forward) clears it: the page appears at once, as the browser expects.
 */
export type PageEnter = "tab" | "push" | "pop" | "fade"

/** How long an entrance may run; afterwards nothing new mounting inside the page animates. */
export const PAGE_ENTER_MS = 600

let timer: number | undefined

export function markPageEnter(kind: PageEnter | null) {
  const root = document.documentElement
  window.clearTimeout(timer)
  if (!kind) {
    delete root.dataset.pageEnter
    return
  }
  root.dataset.pageEnter = kind
  timer = window.setTimeout(() => delete root.dataset.pageEnter, PAGE_ENTER_MS)
}

/** Detail pages: they carry a way back to their parent (`Page`'s `back`). */
const DETAIL_PAGES = new Set(["notification-detail", "delivery-history"])

export function pageDepth(kind: string) {
  return DETAIL_PAGES.has(kind) ? 1 : 0
}

/**
 * Deeper is a push; a back link (`data-page-back`: the breadcrumb, the compact bar's chevron) is a
 * pop; anything else, a tab bar jump out of a detail page included, is a sibling switch.
 */
export function classifyPageEnter(fromKind: string, toKind: string, viaBack = false): PageEnter {
  if (viaBack) return "pop"
  return pageDepth(toKind) > pageDepth(fromKind) ? "push" : "tab"
}
