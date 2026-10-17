import * as React from "react"

import { SIGNAL_CSS } from "@/lib/signal"
import { syncModeOf, useOnline, type SyncMode } from "@/lib/sync"
import { useTicker } from "@/lib/ticker"
import { cn } from "@/lib/utils"

const COLOR: Record<SyncMode, string> = {
  live: SIGNAL_CSS.done,
  syncing: SIGNAL_CSS.running,
  stale: SIGNAL_CSS.attention,
  offline: SIGNAL_CSS.attention,
}

/**
 * Where the data stands: a lit dot and "Live · synced 14:02", turning stale on its own clock. While
 * a refetch is in flight the dot turns the running colour and pulses; each successful sync sends
 * one ring out from it. The words crossfade when the state changes, the colour eases (`--tone`), and
 * offline the dot holds still. The words never flash "Syncing" for a sub-second refetch.
 */
export function SyncStatus({ syncedAt, syncing = false, failed = false, className }: { syncedAt: number; syncing?: boolean; failed?: boolean; className?: string }) {
  const online = useOnline()
  const now = useTicker(true)
  const mode = syncModeOf({ syncing, online: online && !failed, syncedAt, now })
  const settled = syncModeOf({ online: online && !failed, syncedAt, now })
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(syncedAt)
  const text = settled === "live" ? `Live · synced ${time}` : settled === "stale" ? `Stale · ${time}` : `Offline · ${time}`
  // One ring per successful sync after the first paint (adjusted while rendering, no effect).
  const [pings, setPings] = React.useState({ syncedAt, count: 0 })
  if (pings.syncedAt !== syncedAt) setPings({ syncedAt, count: pings.count + 1 })
  return (
    <span
      className={cn("sync-status micro inline-flex items-center gap-2 tracking-[0.1em]", className)}
      style={{ ["--tone" as string]: COLOR[settled], color: "var(--tone)" }}
      data-sync={mode}
    >
      <span
        aria-hidden="true"
        className="sync-dot relative inline-grid place-items-center"
        style={{ ["--tone" as string]: COLOR[mode] }}
      >
        <span className={cn("ink-dot size-1.5", (mode === "live" || mode === "syncing") && "breathe")} />
        {pings.count > 0 ? <span key={pings.count} className="sync-ping" /> : null}
      </span>
      {/* A keyed CSS fade-in, not an exit animation: the words can change before the motion engine
          has loaded (a refetch failing at once), and an exit that never starts would leave both. */}
      <span key={settled} className="fade-in whitespace-nowrap">
        {text}
      </span>
    </span>
  )
}
