import * as React from "react"
import { flushSync } from "react-dom"

import type { DashboardBootstrap } from "@/app/bootstrap"
import { DashboardApp } from "@/app/dashboard-app"
import { preloadDashboardPage } from "@/app/dashboard-page-loaders"
import {
  fetchDashboardRoute,
  type DashboardRouteResult,
} from "@/app/dashboard-route-loader"
import { RouteLoadingIndicator } from "@/app/route-loading-fallback"
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

function dashboardAnchor(target: EventTarget | null): HTMLAnchorElement | null {
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
  const url = new URL(anchor.href, window.location.href)
  return url.origin === window.location.origin && isDashboardPath(url.pathname)
    ? anchor
    : null
}

function dashboardTitle(bootstrap: DashboardBootstrap) {
  return `${bootstrap.kind === "auth" ? bootstrap.title : bootstrap.shell.title} · Relo`
}

function isClientOwnedTestLabRoute(url: URL) {
  return /^\/dashboard\/testing(?:\/runs\/[^/]+)?$/u.test(url.pathname)
}

function commitBootstrap(
  bootstrap: DashboardBootstrap,
  update: (value: DashboardBootstrap) => void
) {
  const documentWithTransitions = document as Document & {
    startViewTransition?: (callback: () => void) => unknown
  }
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
  const commit = () => flushSync(() => update(bootstrap))
  if (!reduceMotion && documentWithTransitions.startViewTransition) {
    documentWithTransitions.startViewTransition(commit)
  } else {
    commit()
  }
}

function settleViewport(url: URL, mode: NavigationMode, scrollY = 0) {
  window.requestAnimationFrame(() => {
    if (url.hash) {
      const target = document.getElementById(decodeURIComponent(url.hash.slice(1)))
      target?.scrollIntoView()
      if (target instanceof HTMLElement) target.focus({ preventScroll: true })
      return
    }
    window.scrollTo({ top: mode === "pop" ? scrollY : 0, behavior: "instant" })
    if (mode !== "pop") {
      document.getElementById("main-content")?.focus({ preventScroll: true })
    }
  })
}

export function DashboardRouter({
  bootstrap: initialBootstrap,
}: {
  bootstrap: DashboardBootstrap
}) {
  const [bootstrap, setBootstrap] = React.useState(initialBootstrap)
  const [pending, setPending] = React.useState(false)
  const bootstrapRef = React.useRef(bootstrap)
  const cache = React.useRef(new Map<string, CachedRoute>())
  const activeRequest = React.useRef<AbortController | null>(null)
  const navigationId = React.useRef(0)

  React.useEffect(() => {
    bootstrapRef.current = bootstrap
    document.title = dashboardTitle(bootstrap)
  }, [bootstrap])

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
      restoreScrollY = 0
    ) => {
      activeRequest.current?.abort()
      const controller = new AbortController()
      activeRequest.current = controller
      const requestId = ++navigationId.current
      setPending(true)

      try {
        const result = await load(url, controller.signal)
        if (requestId !== navigationId.current) return
        if (result.kind === "document") {
          window.location.assign(result.url)
          return
        }
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

        commitBootstrap(result.bootstrap, setBootstrap)
        settleViewport(resolved, mode, restoreScrollY)
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") return
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
      const anchor = dashboardAnchor(event.target)
      if (!anchor) return
      const url = new URL(anchor.href, window.location.href)
      if (
        bootstrapRef.current.kind === "test-lab" &&
        isClientOwnedTestLabRoute(url)
      ) {
        event.preventDefault()
        if (url.href === window.location.href) return
        navigateDashboard(`${url.pathname}${url.search}${url.hash}`)
        settleViewport(url, "push")
        return
      }
      if (
        url.pathname === window.location.pathname &&
        url.search === window.location.search &&
        url.hash !== window.location.hash
      ) {
        return
      }
      event.preventDefault()
      if (url.href === window.location.href) return
      void navigate(url, "push")
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
      void navigate(url, "pop", Number(event.state?.[SCROLL_STATE_KEY]) || 0)
    }

    document.addEventListener("click", onClick)
    document.addEventListener("pointerover", onPrefetch)
    document.addEventListener("focusin", onPrefetch)
    window.addEventListener("popstate", onPopState)
    return () => {
      activeRequest.current?.abort()
      document.removeEventListener("click", onClick)
      document.removeEventListener("pointerover", onPrefetch)
      document.removeEventListener("focusin", onPrefetch)
      window.removeEventListener("popstate", onPopState)
    }
  }, [navigate, prefetch])

  React.useEffect(() => {
    const main = document.getElementById("main-content")
    if (pending) main?.setAttribute("aria-busy", "true")
    else main?.removeAttribute("aria-busy")
  }, [pending])

  return (
    <>
      <DashboardApp bootstrap={bootstrap} />
      <RouteLoadingIndicator active={pending} />
    </>
  )
}
