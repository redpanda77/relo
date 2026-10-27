import { Check, Minus, Moon, Pause, X } from "lucide-react"
import * as React from "react"

import { PresenceList } from "@/components/molecules/presence-list"
import { canEndWork, EndWorkButton } from "@/features/inbox/end-work"
import { useNowStage } from "@/features/inbox/now-context"
import { settledView, type NowItem, type SettledKind } from "@/features/inbox/now-model"
import { cn } from "@/lib/utils"

/**
 * The compact rows of Since you looked and the Quiet and Paused line (the iPhone's settledRow, C2-Settled):
 * a 26px circle icon, the title, "project · computer" under it and the time. A failed row opens a panel in
 * place (Open, Close); every other row opens its details. A Quiet or Paused row also offers End (the iPhone's swipe).
 */

const itemKey = (item: NowItem) => item.id
/** Rows morph only between rows: finished work does not stretch a card into a row, it hands over. */
const rowLayoutId = (item: NowItem) => `now-row-${item.id}`

function SettledIcon({ kind }: { kind: SettledKind }) {
  const props = { "aria-hidden": true, strokeWidth: 2.6, className: "settled-glyph" } as const
  return (
    <span className="settled-icon" data-kind={kind} aria-hidden="true">
      {kind === "done" ? <Check {...props} /> : kind === "failed" ? <X {...props} /> : kind === "quiet" ? <Moon {...props} strokeWidth={2} /> : kind === "paused" ? <Pause {...props} strokeWidth={2} /> : <Minus {...props} />}
    </span>
  )
}

function SettledRow({
  item,
  parked,
  open,
  onToggle,
  onOpen,
}: {
  item: NowItem
  parked?: "quiet" | "paused"
  /** A failed row's panel is open. */
  open: boolean
  onToggle: () => void
  onOpen: (item: NowItem) => void
}) {
  const stage = useNowStage()
  const listed = stage.items.get(item.id) ?? item
  const view = settledView(listed, stage.sessionByWork.get(item.id)?.computer ?? null, parked)
  const failed = view.kind === "failed"
  const end = stage.actions && !stage.offline && canEndWork(listed.owner.state) ? (
    <span className="settled-end">
      <EndWorkButton workId={listed.id} goal={listed.title} end={stage.actions.end} />
    </span>
  ) : null
  const row = (
    <>
      <SettledIcon kind={view.kind} />
      <span className="settled-text">
        <span className="settled-title">{view.title}</span>
        {view.subline ? <span className="settled-sub">{view.subline}</span> : null}
      </span>
      {view.time ? <time className="settled-time" dateTime={view.at ?? undefined}>{view.time}</time> : null}
    </>
  )
  return (
    <>
      {failed ? (
        <button type="button" className="settled-row" aria-expanded={open} onClick={onToggle}>
          {row}
        </button>
      ) : (
        <div className="settled-line">
          <button type="button" className="settled-row" aria-label={`Open ${view.title}`} onClick={() => onOpen(listed)}>
            {row}
          </button>
          {end}
        </div>
      )}
      {failed && open ? (
        <div className="settled-panel" role="group" aria-label={`${view.title} failed`}>
          <p>{view.status ?? "It failed."}</p>
          <div className="settled-panel-chips">
            <button type="button" className="settled-chip" data-filled onClick={() => onOpen(listed)}>
              Open
            </button>
            <button type="button" className="settled-chip" onClick={onToggle}>
              Close
            </button>
          </div>
        </div>
      ) : null}
    </>
  )
}

/** The rows as one list (inside a `SettledGroup`): dividers inset past the icon, none under an open panel. */
export function SettledList({
  label,
  items,
  parked,
  onOpen,
  className,
}: {
  label: string
  items: readonly NowItem[]
  /** The fold these rows sit in (their icons are the moon and the pause, not an outcome). */
  parked?: "quiet" | "paused"
  onOpen: (item: NowItem) => void
  className?: string
}) {
  const stage = useNowStage()
  const [panels, setPanels] = React.useState<ReadonlySet<string>>(new Set())
  const toggle = (id: string) =>
    setPanels((current) => {
      const next = new Set(current)
      if (!next.delete(id)) next.add(id)
      return next
    })
  return (
    <PresenceList
      label={label}
      items={items}
      getKey={itemKey}
      layoutId={rowLayoutId}
      itemAttributes={(item) => ({ "data-panel-open": panels.has(item.id) && item.owner.state === "failed" ? "true" : undefined })}
      animateFirst={stage.ready}
      enterDelay={stage.ready ? 0.32 : 0}
      className={cn("settled-list", className)}
    >
      {(item) => <SettledRow item={item} parked={parked} open={panels.has(item.id)} onToggle={() => toggle(item.id)} onOpen={onOpen} />}
    </PresenceList>
  )
}

/** The glass the settled rows and the fold line share. */
export function SettledGroup({ className, children, ...rest }: React.ComponentProps<"div">) {
  return (
    <div className={cn("settled-group glass", className)} {...rest}>
      {children}
    </div>
  )
}

/**
 * Quiet and Paused as one 44px line in a glass group ("Quiet 2 · Paused 1   Show ›"); opened, both kinds list as
 * compact rows with the moon and the pause. The counts are the server's `folds`.
 */
export function ParkedFold({
  quiet,
  paused,
  onOpen,
  onOpenChange,
}: {
  quiet: { count: number; items: NowItem[] }
  paused: { count: number; items: NowItem[] }
  onOpen: (item: NowItem) => void
  onOpenChange?: (open: boolean) => void
}) {
  const [open, setOpen] = React.useState(false)
  const toggle = () => {
    setOpen(!open)
    onOpenChange?.(!open)
  }
  const spoken = [quiet.count ? `Quiet, ${quiet.count}` : null, paused.count ? `Paused, ${paused.count}` : null].filter(Boolean).join(", ")
  return (
    <SettledGroup data-fold="parked">
      <button type="button" className="parked-line" aria-expanded={open} aria-label={spoken} onClick={toggle}>
        {quiet.count ? <Moon className="parked-glyph" fill="currentColor" aria-hidden="true" /> : <Pause className="parked-glyph" fill="currentColor" aria-hidden="true" />}
        <span className="parked-label">
          {quiet.count ? (
            <>
              Quiet <b>{quiet.count}</b>
            </>
          ) : null}
          {quiet.count && paused.count ? " \u00b7 " : null}
          {paused.count ? (
            <>
              Paused <b>{paused.count}</b>
            </>
          ) : null}
        </span>
        <span className="parked-end">{open ? "Hide" : "Show \u203a"}</span>
      </button>
      {open && quiet.items.length ? <SettledList label="Quiet" items={quiet.items} parked="quiet" onOpen={onOpen} className="settled-list-parked" /> : null}
      {open && paused.items.length ? <SettledList label="Paused" items={paused.items} parked="paused" onOpen={onOpen} className="settled-list-parked" /> : null}
    </SettledGroup>
  )
}
