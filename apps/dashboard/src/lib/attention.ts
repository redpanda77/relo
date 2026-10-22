import { useSyncExternalStore } from "react"

/**
 * What needs the owner, live. The page's own bootstrap counts it once per navigation; Now keeps the
 * server's summary current (its live hints and refetches), so while it is open its count drives the
 * tab title and the favicon (ADR 0013, section 4). Null means "no live count": the bootstrap's.
 */
let live: number | null = null
const listeners = new Set<() => void>()

export function setLiveNeedsYou(count: number | null) {
  if (live === count) return
  live = count
  for (const listener of listeners) listener()
}

export function useLiveNeedsYou() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    () => live,
    () => null
  )
}

/** "(3) " ahead of a title, as the iPhone badges its icon; nothing at zero. */
export function waitingPrefix(count: number) {
  return count > 0 ? `(${count > 99 ? "99+" : count}) ` : ""
}

const icon = (dot: string) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#08080d"/><circle cx="16" cy="16" r="7" fill="${dot}"/></svg>`
  )}`
const CALM = icon("#ede9f7")
const ATTENTION = icon("#FF7A66")

/**
 * Relo's dot as the tab icon, coral while something needs the owner. Set from here because the
 * server drops the build's `<link rel="icon">` from every document it renders.
 */
export function setFavicon(needsYou: boolean) {
  if (typeof document === "undefined") return
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!link) {
    link = document.createElement("link")
    link.rel = "icon"
    link.type = "image/svg+xml"
    document.head.appendChild(link)
  }
  const href = needsYou ? ATTENTION : CALM
  if (link.getAttribute("href") !== href) link.setAttribute("href", href)
}
