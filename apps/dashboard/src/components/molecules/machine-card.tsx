import type { LucideIcon } from "lucide-react"
import * as React from "react"

import { PresenceList } from "@/components/molecules/presence-list"
import { cn } from "@/lib/utils"

/**
 * The machine card of Connections and Devices (the Now sessions' machine header, board C3): a glass card
 * whose head is a 30px tile with the machine's glyph and a status dot, its name, one summary line and harness
 * chips. `onClick` (or `hit`, to wrap the button in a sheet trigger) makes the head open something; `actions`
 * sit at its end, outside that button; `children` hang under the head (a state line, an approval).
 */
export function MachineCard({
  glyph: Glyph,
  name,
  summary,
  dot = "slate",
  chips,
  actions,
  onClick,
  hit,
  busy,
  note,
  children,
}: {
  glyph: LucideIcon
  name: React.ReactNode
  /** "Last seen 4 min ago · 2 harnesses": 11px, muted, one line. */
  summary?: React.ReactNode
  dot?: "mint" | "slate" | "orange" | "amber"
  /** `MachineChip`s (harnesses) at the end of the head. */
  chips?: React.ReactNode
  actions?: React.ReactNode
  onClick?: () => void
  /** Wraps the head's button (a `SheetTrigger asChild`). */
  hit?: (element: React.ReactElement) => React.ReactElement
  busy?: boolean
  /** A line under the head, inset past the tile (a state, an approval, chips for what differs). */
  note?: React.ReactNode
  /** Rendered after the card's body but outside its layout (a sheet's content opens in a portal). */
  children?: React.ReactNode
}) {
  const head = (
    <span className="sess-head" data-line={note ? true : undefined}>
      <span className="sess-machine-tile">
        <Glyph aria-hidden="true" />
        <i className="sess-dot" data-tone={dot} aria-hidden="true" />
      </span>
      <span className="sess-head-text">
        <span className="sess-machine-name">{name}</span>
        {summary ? <span className="sess-machine-summary">{summary}</span> : null}
      </span>
      {chips}
    </span>
  )
  const button = onClick ? (
    <button type="button" className="sess-head-button" onClick={onClick}>
      {head}
    </button>
  ) : null
  const target = button ? (hit ? hit(button) : button) : head
  return (
    <div className="sess-card glass machine-card" data-slot="machine-card" aria-busy={busy || undefined}>
      <div className="machine-head-row">
        <div className="machine-head">{target}</div>
        {actions ? <div className="machine-actions">{actions}</div> : null}
      </div>
      {note ? <div className="machine-note">{note}</div> : null}
      {children}
    </div>
  )
}

/** A 22px chip at the end of a machine head: a harness mark and, when it has one, its count. */
export function MachineChip({ children, count, className }: { children: React.ReactNode; count?: number; className?: string }) {
  return (
    <span className={cn("sess-harness-chip", className)}>
      {children}
      {count != null ? <span>{count}</span> : null}
    </span>
  )
}

/** The machine cards as a list, 14px apart (the Now sessions' rhythm); items arrive and leave like any list. */
export function MachineList<T>({
  label,
  items,
  getKey,
  children,
}: {
  label: string
  items: readonly T[]
  getKey: (item: T) => string
  children: (item: T) => React.ReactNode
}) {
  return (
    <PresenceList label={label} items={items} getKey={getKey} className="machine-list" itemClassName="machine-item">
      {children}
    </PresenceList>
  )
}
