import { useCallback, useEffect, useRef, useState } from "react"

import { fetchDashboardRoute } from "@/app/dashboard-route-loader"
import { overviewNow, type NowSummary } from "@/features/inbox/now-model"
import { connectNowLive } from "@/features/inbox/use-now-live"
import { currentBrowserLink } from "@/lib/e2ee/browser-link"
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
 * (with this browser's last look as `since`), on the server's live hints (`connectNowLive`: within
 * about a second of a write), every 60 s while the tab is visible as reconciliation, when it becomes
 * visible, and once at the server's `refreshAt`. The last look is recorded when the tab hides.
 * `syncing` is true while a refetch is in flight (no clock: the fetch sets and clears it).
 */
export function useNowRefresh(accountId: string | undefined, initial: NowSummary | null) {
  const [fetched, setFetched] = useState<{ from: NowSummary | null; value: NowSummary } | null>(null)
  const [offline, setOffline] = useState(false)
  // A refetch in flight: shown as the sync dot's pulse. Set and cleared by the fetches themselves.
  const [syncing, setSyncing] = useState(false)
  const refreshRef = useRef<(() => Promise<void>) | null>(null)
  const retry = useCallback(() => void refreshRef.current?.(), [])
  // A new page object (sealed text opened in place) keeps the newer Now: the page load's summary never
  // replaces a later refetch, or sections would flash back to how they were when the page loaded.
  const summary = fetched && (fetched.from === initial || !initial || fetched.value.serverTime >= initial.serverTime)
    ? fetched.value : initial

  useEffect(() => {
    if (!accountId) return
    let cancelled = false
    const refresh = async () => {
      if (document.visibilityState === "hidden") return
      setSyncing(true)
      try {
        const next = await fetchNow(accountId)
        if (cancelled) return
        setOffline(false)
        if (next) setFetched({ from: initial, value: next })
      } catch {
        if (!cancelled) setOffline(true)
      } finally {
        if (!cancelled) setSyncing(false)
      }
    }
    refreshRef.current = refresh
    const onVisibility = () => {
      if (document.visibilityState === "hidden") writeLastLooked(accountId)
      else void refresh()
    }
    const onHide = () => writeLastLooked(accountId)

    void refresh()
    const timer = window.setInterval(() => void refresh(), REFRESH_MS)
    const stopLive = connectNowLive(() => void refresh())
    // Linked while this page is open: read the Now cards again, now opened (no reload).
    const link = currentBrowserLink()
    let wasLinked = link?.isLinked() ?? false
    const stopLink = link?.subscribe(() => {
      const linked = link.isLinked()
      if (linked && !wasLinked) void refresh()
      wasLinked = linked
    })
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("pagehide", onHide)
    return () => {
      cancelled = true
      refreshRef.current = null
      window.clearInterval(timer)
      stopLive()
      stopLink?.()
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
      setSyncing(true)
      fetchNow(accountId)
        .then((next) => {
          if (!cancelled && next) setFetched({ from: initial, value: next })
        })
        .catch(() => {
          if (!cancelled) setOffline(true)
        })
        .finally(() => {
          if (!cancelled) setSyncing(false)
        })
    }, delay + 500)
    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [accountId, initial, refreshAt, serverTime])

  return { summary, offline, syncing, retry }
}
