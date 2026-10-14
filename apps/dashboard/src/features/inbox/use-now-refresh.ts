import { useEffect, useState } from "react"

import { fetchDashboardRoute } from "@/app/dashboard-route-loader"
import { overviewNow, type NowSummary } from "@/features/inbox/now-model"
import { readLastLooked, writeLastLooked } from "@/lib/last-looked"

const REFRESH_MS = 60_000

async function fetchNow(accountId: string): Promise<NowSummary | null> {
  const query = new URLSearchParams({ only: "now" })
  const since = readLastLooked(accountId)
  if (since) query.set("since", since)
  const route = await fetchDashboardRoute(`/dashboard?${query}`)
  return route.kind === "dashboard" ? overviewNow(route.bootstrap) : null
}

/**
 * The server's Now, kept current by refetching (never by re-deriving on a client clock): on mount
 * (with this browser's last look as `since`), every 60 s while the tab is visible, when it becomes
 * visible, and once at the server's `refreshAt`. The last look is recorded when the tab hides.
 */
export function useNowRefresh(accountId: string | undefined, initial: NowSummary | null) {
  const [fetched, setFetched] = useState<{ from: NowSummary | null; value: NowSummary } | null>(null)
  const [offline, setOffline] = useState(false)
  const summary = fetched && fetched.from === initial ? fetched.value : initial

  useEffect(() => {
    if (!accountId) return
    let cancelled = false
    const refresh = async () => {
      if (document.visibilityState === "hidden") return
      try {
        const next = await fetchNow(accountId)
        if (cancelled) return
        setOffline(false)
        if (next) setFetched({ from: initial, value: next })
      } catch {
        if (!cancelled) setOffline(true)
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === "hidden") writeLastLooked(accountId)
      else void refresh()
    }
    const onHide = () => writeLastLooked(accountId)

    void refresh()
    const timer = window.setInterval(() => void refresh(), REFRESH_MS)
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("pagehide", onHide)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("pagehide", onHide)
    }
  }, [accountId, initial])

  // One refetch at the server's own next-change instant (category B), when sooner than the poll.
  const refreshAt = summary?.refreshAt ?? null
  const serverTime = summary?.serverTime ?? null
  useEffect(() => {
    if (!accountId || !refreshAt || !serverTime) return
    const delay = new Date(refreshAt).valueOf() - new Date(serverTime).valueOf()
    if (!Number.isFinite(delay) || delay <= 0 || delay >= REFRESH_MS) return
    let cancelled = false
    const timeout = window.setTimeout(() => {
      fetchNow(accountId)
        .then((next) => {
          if (!cancelled && next) setFetched({ from: initial, value: next })
        })
        .catch(() => {
          if (!cancelled) setOffline(true)
        })
    }, delay + 500)
    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [accountId, initial, refreshAt, serverTime])

  return { summary, offline }
}
