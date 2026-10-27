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
 * Where the data stands, in mono caps: a lit dot and "LIVE 2:14 PM" / "OFFLINE · 2:14 PM" / "SYNCING", turning stale on its own clock; it sits at the trailing end of the header row. While
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
  const text = mode === "syncing" ? "SYNCING" : settled === "live" ? `LIVE ${time}` : settled === "stale" ? `STALE · ${time}` : `OFFLINE · ${time}`
  // One ring per successful sync after the first paint (adjusted while rendering, no effect).
  const [pings, setPings] = React.useState({ syncedAt, count: 0 })
  if (pings.syncedAt !== syncedAt) setPings({ syncedAt, count: pings.count + 1 })
  return (
    <span
      className={cn("sync-status inline-flex items-center gap-1.5 font-mono text-[9px] leading-3 font-semibold tracking-[1px] uppercase", className)}
      style={{ ["--tone" as string]: COLOR[mode === "syncing" ? "syncing" : settled], color: "var(--tone)" }}
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
