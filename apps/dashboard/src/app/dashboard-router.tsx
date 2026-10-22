import * as React from "react"
import { flushSync } from "react-dom"

import type { DashboardBootstrap } from "@/app/bootstrap"
import { DashboardApp } from "@/app/dashboard-app"
import { preloadDashboardPage } from "@/app/dashboard-page-loaders"
import {
  fetchDashboardRoute,
  type DashboardRouteResult,
} from "@/app/dashboard-route-loader"
import { setLoadingPage } from "@/app/loading-page"
import { RouteLoadingIndicator } from "@/app/route-loading-fallback"
import { classifyPageEnter, markPageEnter } from "@/app/page-enter"
import { openFirstPageSealed } from "@/app/sealed-bootstrap"
import { useSealedRetry } from "@/app/use-sealed-retry"
import { dashboardTitle, dashboardWaiting } from "@/app/dashboard-title"
import { setFavicon, useLiveNeedsYou } from "@/lib/attention"
import { setSealedOpening } from "@/lib/sealed-opening"
import { navigateDashboard } from "@/state/use-dashboard-route"

const CACHE_TTL_MS = 15_000
const SCROLL_STATE_KEY = "__reloScrollY"

type CachedRoute = {
  createdAt: number
  promise: Promise<DashboardRouteResult>
}

type NavigationMode = "push" | "replace" | "pop"

function isDashboardPath(pathname: string) {
  return pathname === "/dashboard" || pathname.startsWith("/dashboard/")
}

/** A same-origin link the client may handle: not a download, not external, not another tab. */
function clientAnchor(target: EventTarget | null): HTMLAnchorElement | null {
  if (!(target instanceof Element)) return null
  const anchor = target.closest<HTMLAnchorElement>("a[href]")
  if (
    !anchor ||
    anchor.hasAttribute("download") ||
    anchor.dataset.noClientNavigation === "true" ||
    (anchor.target && anchor.target !== "_self") ||
    anchor.rel.split(/\s+/u).includes("external")
  ) {
    return null
  }
  return new URL(anchor.href, window.location.href).origin === window.location.origin ? anchor : null
}

function dashboardAnchor(target: EventTarget | null): HTMLAnchorElement | null {
  const anchor = clientAnchor(target)
  return anchor && isDashboardPath(new URL(anchor.href, window.location.href).pathname) ? anchor : null
}

/** Fired by `navigateDashboard` (keyboard jumps, the command menu) after it pushes the new URL. */
const NAVIGATION_EVENT = "relo:navigation"

function isClientOwnedTestLabRoute(url: URL) {
  return /^\/dashboard\/testing(?:\/runs\/[^/]+)?$/u.test(url.pathname)
}

/** Swap pages instantly: a crossfade over frosted layers reads as lag, not polish. */
function commitBootstrap(
  bootstrap: DashboardBootstrap,
  update: (value: DashboardBootstrap) => void
) {
  flushSync(() => update(bootstrap))
}

/** The new page's title, once it is on screen (a lazy page may take a few frames). */
function whenPageTitle(callback: (heading: HTMLElement | null) => void, frames = 12) {
  const heading = document.querySelector<HTMLElement>("#main-content h1")
  if (heading || frames <= 0) callback(heading)
  else window.requestAnimationFrame(() => whenPageTitle(callback, frames - 1))
}

function settleViewport(
  url: URL,
  mode: NavigationMode,
  scrollY = 0,
  announce?: (title: string) => void
) {
  window.requestAnimationFrame(() => {
    if (url.hash) {
      const target = document.getElementById(decodeURIComponent(url.hash.slice(1)))
      target?.scrollIntoView()
      if (target instanceof HTMLElement) target.focus({ preventScroll: true })
      return
    }
    window.scrollTo({ top: mode === "pop" ? scrollY : 0, behavior: "instant" })
    whenPageTitle((heading) => {
      // Focus lands on the new page's name, so a screen reader starts there; Back keeps its place.
      if (mode !== "pop") {
        ;(heading ?? document.getElementById("main-content"))?.focus({ preventScroll: true })
      }
      const title = heading?.textContent?.trim()
      if (title) announce?.(`${title} loaded`)
    })
  })
}

/** A link to a section of the page already shown: glide there (jump under reduced motion). */
function scrollToSection(hash: string) {
  const target = hash ? document.getElementById(decodeURIComponent(hash.slice(1))) : null
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
  const behavior: ScrollBehavior = reduced ? "instant" : "smooth"
  if (target) {
    target.scrollIntoView({ behavior, block: "start" })
    // Keyboard focus follows the reader (the skip link relies on it).
    if (target.tabIndex >= 0 || target.hasAttribute("tabindex")) target.focus({ preventScroll: true })
  } else window.scrollTo({ top: 0, behavior })
}

/** A fetch that never reached the server (offline, DNS, a dropped connection): not an HTTP answer. */
function isNetworkFailure(cause: unknown) {
  return cause instanceof TypeError
}

/** Each opened row's text crossfades in (--dur-fast), 40 ms after the one before. */
const OPENED_STAGGER_MS = 40
const OPENED_FADE_MS = 180

/**
 * Marks the rows whose sealed text is about to be swapped in: their containers survive the swap
 * (React keeps the element, only its child changes), so loading.css fades each new text in place.
 */
function markOpenedRows() {
  const rows = [...document.querySelectorAll<HTMLElement>('[data-encrypted="opening"]')]
    .map((node) => node.parentElement)
    .filter((node): node is HTMLElement => node !== null)
  rows.forEach((row, index) => {
    row.dataset.sealedOpened = "true"
    row.style.setProperty("--sealed-i", String(index))
  })
  window.setTimeout(() => {
    for (const row of rows) {
      delete row.dataset.sealedOpened
      row.style.removeProperty("--sealed-i")
    }
  }, OPENED_FADE_MS + rows.length * OPENED_STAGGER_MS + 100)
}

type FailedNavigation = { url: URL; mode: NavigationMode; restoreScrollY: number; viaBack: boolean }

/** The page a URL shows, ignoring its section: only this decides whether to load a page. */
const pageOf = (url: URL | Location) => `${url.pathname}${url.search}`

export function DashboardRouter({
  bootstrap: initialBootstrap,
}: {
  bootstrap: DashboardBootstrap
}) {
  const [bootstrap, setBootstrap] = React.useState(initialBootstrap)
  const [pending, setPending] = React.useState(false)
  // The last navigation could not reach the server: the page stays, the rail turns red.
  const [failed, setFailed] = React.useState<FailedNavigation | null>(null)
  const [announcement, setAnnouncement] = React.useState("")
  const bootstrapRef = React.useRef(bootstrap)
  const cache = React.useRef(new Map<string, CachedRoute>())
  const activeRequest = React.useRef<AbortController | null>(null)
  const navigationId = React.useRef(0)
  // The page on screen; a history entry that differs from it only by #section is not a navigation.
  const shownPage = React.useRef(pageOf(window.location))

  // A linked browser opens the sealed items of the first page once its keys are ready (main.tsx
  // started it and may already have rendered the opened page; then this finds nothing new).
  React.useEffect(() => {
    let active = true
    void openFirstPageSealed(initialBootstrap).then((opened) => {
      if (active && opened !== initialBootstrap && bootstrapRef.current === initialBootstrap) {
        markOpenedRows()
        setBootstrap(opened)
      }
      setSealedOpening(false)
    })
    return () => {
      active = false
    }
  }, [initialBootstrap])

  // Sealed items a linked browser could not open yet are tried again (use-sealed-retry.ts).
  useSealedRetry(
    bootstrap,
    React.useCallback((opened: DashboardBootstrap) => {
      markOpenedRows()
      setBootstrap(opened)
    }, [])
  )

  // Now's live count (its summary refreshes without a navigation) leads the bootstrap's.
  const liveNeedsYou = useLiveNeedsYou()
  React.useEffect(() => {
    bootstrapRef.current = bootstrap
    document.title = dashboardTitle(bootstrap, liveNeedsYou)
    setFavicon(dashboardWaiting(bootstrap, liveNeedsYou) > 0)
  }, [bootstrap, liveNeedsYou])

  const load = React.useCallback((url: URL, signal?: AbortSignal) => {
    const key = `${url.origin}${url.pathname}${url.search}`
    const cached = cache.current.get(key)
    if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
      return cached.promise
    }
    const promise = fetchDashboardRoute(url.href, { signal }).catch((cause) => {
      cache.current.delete(key)
      throw cause
    })
    cache.current.set(key, { createdAt: Date.now(), promise })
    return promise
  }, [])

  const prefetch = React.useCallback(
    async (url: URL) => {
      try {
        const result = await load(url)
        if (result.kind === "dashboard") await preloadDashboardPage(result.bootstrap)
      } catch {
        // Navigation retains the normal document request as its recovery path.
      }
    },
    [load]
  )

  const navigate = React.useCallback(
    async (
      url: URL,
      mode: NavigationMode,
      restoreScrollY = 0,
      viaBack = false
    ) => {
      activeRequest.current?.abort()
      const controller = new AbortController()
      activeRequest.current = controller
      const requestId = ++navigationId.current
      setPending(true)
      setFailed(null)

      try {
        const result = await load(url, controller.signal)
        if (requestId !== navigationId.current) return
        if (result.kind === "document") {
          window.location.assign(result.url)
          return
        }
        setLoadingPage(result.bootstrap.kind, "shell" in result.bootstrap ? result.bootstrap.shell.title : "")
        await preloadDashboardPage(result.bootstrap)
        if (requestId !== navigationId.current) return

        const resolved = new URL(result.url)
        if (mode === "push") {
          window.history.replaceState(
            { ...window.history.state, [SCROLL_STATE_KEY]: window.scrollY },
            "",
            window.location.href
          )
          window.history.pushState({ [SCROLL_STATE_KEY]: 0 }, "", resolved)
        } else if (mode === "replace") {
          window.history.replaceState({ [SCROLL_STATE_KEY]: 0 }, "", resolved)
        }

        shownPage.current = pageOf(resolved)
        // Back and Forward restore a page as it was: it appears at once. Anything else enters
        // by its relation to the page it replaces (`page-enter.ts`).
        markPageEnter(
          mode === "pop" ? null : classifyPageEnter(bootstrapRef.current.kind, result.bootstrap.kind, viaBack)
        )
        commitBootstrap(result.bootstrap, setBootstrap)
        settleViewport(resolved, mode, restoreScrollY, setAnnouncement)
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") return
        // Unreachable: keep the page and say so, with a retry (and one when the network returns).
        // Anything the server answered (a 401, an error page) loads as a document.
        if (isNetworkFailure(cause)) {
          if (requestId === navigationId.current) setFailed({ url, mode, restoreScrollY, viaBack })
          return
        }
        window.location.assign(url.href)
      } finally {
        if (requestId === navigationId.current) {
          activeRequest.current = null
          setPending(false)
        }
      }
    },
    [load]
  )

  React.useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return
      }
      const link = clientAnchor(event.target)
      if (!link) return
      const url = new URL(link.href, window.location.href)
      // A section of this page (the landing's nav too): scroll to it here. Left to the browser it
      // jumps, and the history entry it adds would come back through popstate as a page load.
      if (url.hash && pageOf(url) === pageOf(window.location)) {
        event.preventDefault()
        if (url.hash !== window.location.hash) window.history.pushState(window.history.state, "", url)
        scrollToSection(url.hash)
        return
      }
      if (!dashboardAnchor(link)) return
      if (
        bootstrapRef.current.kind === "test-lab" &&
        isClientOwnedTestLabRoute(url)
      ) {
        event.preventDefault()
        if (url.href === window.location.href) return scrollToSection("")
        navigateDashboard(`${url.pathname}${url.search}${url.hash}`)
        settleViewport(url, "push")
        return
      }
      event.preventDefault()
      // The page already shown (its tab tapped again): glide back to the top, as on the iPhone.
      if (url.href === window.location.href) return scrollToSection("")
      void navigate(url, "push", 0, link.dataset.pageBack === "true")
    }
    const onPrefetch = (event: Event) => {
      const anchor = dashboardAnchor(event.target)
      if (anchor) void prefetch(new URL(anchor.href, window.location.href))
    }
    const onPopState = (event: PopStateEvent) => {
      const url = new URL(window.location.href)
      if (
        bootstrapRef.current.kind === "test-lab" &&
        isClientOwnedTestLabRoute(url)
      ) {
        return
      }
      if (pageOf(url) === shownPage.current) {
        scrollToSection(url.hash)
        return
      }
      void navigate(url, "pop", Number(event.state?.[SCROLL_STATE_KEY]) || 0)
    }
    // `navigateDashboard` has already pushed the URL: load that page in place of the entry.
    const onNavigation = () => {
      const url = new URL(window.location.href)
      if (bootstrapRef.current.kind === "test-lab" && isClientOwnedTestLabRoute(url)) return
      if (pageOf(url) === shownPage.current) return
      void navigate(url, "replace")
    }

    document.addEventListener("click", onClick)
    document.addEventListener("pointerover", onPrefetch)
    document.addEventListener("focusin", onPrefetch)
    window.addEventListener("popstate", onPopState)
    window.addEventListener(NAVIGATION_EVENT, onNavigation)
    return () => {
      activeRequest.current?.abort()
      document.removeEventListener("click", onClick)
      document.removeEventListener("pointerover", onPrefetch)
      document.removeEventListener("focusin", onPrefetch)
      window.removeEventListener("popstate", onPopState)
      window.removeEventListener(NAVIGATION_EVENT, onNavigation)
    }
  }, [navigate, prefetch])

  const retry = React.useCallback(() => {
    if (!failed) return
    void navigate(failed.url, failed.mode, failed.restoreScrollY, failed.viaBack)
  }, [failed, navigate])

  React.useEffect(() => {
    if (!failed) return
    window.addEventListener("online", retry)
    return () => window.removeEventListener("online", retry)
  }, [failed, retry])

  React.useEffect(() => {
    const main = document.getElementById("main-content")
    if (pending) main?.setAttribute("aria-busy", "true")
    else main?.removeAttribute("aria-busy")
  }, [pending])

  return (
    <>
      <DashboardApp bootstrap={bootstrap} />
      <RouteLoadingIndicator active={pending} failed={failed !== null} onRetry={retry} />
      {/* One polite announcement per client navigation ("History loaded"). */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </>
  )
}
