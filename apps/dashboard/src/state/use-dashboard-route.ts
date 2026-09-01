import * as React from "react"

import type { RouteState } from "@/features/test-lab/types"

const NAVIGATION_EVENT = "relo:navigation"

export function parseDashboardRoute(location: Pick<Location, "pathname" | "search">): RouteState {
  const params = new URLSearchParams(location.search)
  if (params.get("compose") === "1") return { kind: "new" }

  const match = location.pathname.match(/^\/dashboard\/testing\/runs\/([^/]+)$/)
  if (match) return { kind: "run", runId: decodeURIComponent(match[1]) }
  return { kind: "monitor" }
}

export function navigateDashboard(path: string, replace = false) {
  window.history[replace ? "replaceState" : "pushState"]({}, "", path)
  window.dispatchEvent(new Event(NAVIGATION_EVENT))
}

export function useDashboardRoute() {
  const [route, setRoute] = React.useState(() => parseDashboardRoute(window.location))

  React.useEffect(() => {
    const update = () => setRoute(parseDashboardRoute(window.location))
    window.addEventListener("popstate", update)
    window.addEventListener(NAVIGATION_EVENT, update)
    return () => {
      window.removeEventListener("popstate", update)
      window.removeEventListener(NAVIGATION_EVENT, update)
    }
  }, [])

  return route
}
