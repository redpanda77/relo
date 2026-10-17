import * as React from "react"

export type SyncMode = "live" | "syncing" | "stale" | "offline"

/** The browser's own connectivity, live. */
export function useOnline() {
  const [online, setOnline] = React.useState(() => (typeof navigator === "undefined" ? true : navigator.onLine))
  React.useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener("online", update)
    window.addEventListener("offline", update)
    return () => {
      window.removeEventListener("online", update)
      window.removeEventListener("offline", update)
    }
  }, [])
  return online
}

/** Live while synced in the last five minutes; stale after; offline when the browser or the last refetch is. */
export function syncModeOf({ syncing = false, online, syncedAt, now }: { syncing?: boolean; online: boolean; syncedAt: number; now: number }): SyncMode {
  if (syncing) return "syncing"
  if (!online) return "offline"
  return now - syncedAt > 5 * 60_000 ? "stale" : "live"
}
