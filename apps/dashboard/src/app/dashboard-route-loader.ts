import {
  readDashboardBootstrap,
  type DashboardBootstrap,
} from "@/app/bootstrap"
import { openSealedBootstrap } from "@/app/sealed-bootstrap"

export type DashboardRouteResult =
  | { kind: "dashboard"; bootstrap: DashboardBootstrap; url: string }
  | { kind: "document"; url: string }

function isDashboardPath(pathname: string) {
  return pathname === "/dashboard" || pathname.startsWith("/dashboard/")
}

export async function fetchDashboardRoute(
  href: string,
  options: {
    fetcher?: typeof window.fetch
    signal?: AbortSignal
  } = {}
): Promise<DashboardRouteResult> {
  const requested = new URL(href, window.location.href)
  const response = await (options.fetcher ?? window.fetch)(requested, {
    credentials: "same-origin",
    headers: { accept: "text/html" },
    redirect: "follow",
    signal: options.signal,
  })
  if (!response.ok) throw new Error(`Dashboard navigation failed (${response.status}).`)

  const resolved = new URL(response.url || requested.href, requested)
  if (
    resolved.origin !== window.location.origin ||
    !isDashboardPath(resolved.pathname)
  ) {
    return { kind: "document", url: resolved.href }
  }

  const documentRoot = new DOMParser().parseFromString(
    await response.text(),
    "text/html"
  )
  return {
    kind: "dashboard",
    bootstrap: await openSealedBootstrap(readDashboardBootstrap(documentRoot)),
    url: resolved.href,
  }
}
