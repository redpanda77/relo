import { CornerDownLeft, Search } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { AnimatePresence, LazyMotion, m, useIsPresent } from "motion/react"
import * as React from "react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { loadMotionFeatures } from "@/lib/motion"

/** The highlight glides from row to row, quicker than a layout spring: it follows the keys. */
const SELECTION_SPRING = { type: "spring", stiffness: 700, damping: 45, mass: 1 } as const
/** Rows that stay slide to their new place; rows that go fade out quickly. */
const ROW_MOVE = { layout: { duration: 0.16, ease: [0.22, 1, 0.36, 1] } } as const
const ROW_EXIT = { opacity: 0, transition: { duration: 0.09, ease: [0.4, 0, 1, 1] } } as const

export type PaletteCommand = {
  id: string
  label: string
  group: "Go to" | "Sidebar" | "Account"
  icon: LucideIcon
  /** Keys shown at the row's end ("G H"). */
  shortcut?: string
  run: () => void
}

function matches(command: PaletteCommand, query: string) {
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean)
  const haystack = `${command.label} ${command.group}`.toLowerCase()
  return words.every((word) => haystack.includes(word))
}

/**
 * ⌘K: one field and the dashboard's places and actions under it. Typing filters, the arrows move,
 * Enter runs; the list is a listbox the field controls, so a screen reader hears each row.
 */
export function CommandPalette({
  open,
  onOpenChange,
  commands,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  commands: PaletteCommand[]
}) {
  const [query, setQuery] = React.useState("")
  const [index, setIndex] = React.useState(0)
  const listId = React.useId()
  const results = React.useMemo(
    () => commands.filter((command) => matches(command, query)),
    [commands, query]
  )
  const active = results[Math.min(index, results.length - 1)]

  const change = (next: boolean) => {
    if (!next) {
      setQuery("")
      setIndex(0)
    }
    onOpenChange(next)
  }
  const run = (command: PaletteCommand | undefined) => {
    if (!command) return
    change(false)
    command.run()
  }
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const step = event.key === "ArrowDown" ? 1 : -1
      setIndex((current) => (Math.min(current, results.length - 1) + step + results.length) % Math.max(results.length, 1))
    } else if (event.key === "Enter") {
      event.preventDefault()
      run(active)
    }
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent showCloseButton={false} className="command-palette nav-drop-in gap-0 p-0 sm:max-w-[560px]">
        <DialogTitle className="sr-only">Command menu</DialogTitle>
        <DialogDescription className="sr-only">
          Type to find a page or an action, then press Enter.
        </DialogDescription>
        <div className="command-palette-field">
          <Search aria-hidden="true" />
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={active ? `${listId}-${active.id}` : undefined}
            aria-label="Search pages and actions"
            placeholder="Go to a page or run an action…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setIndex(0)
            }}
            onKeyDown={onKeyDown}
          />
          <kbd>esc</kbd>
        </div>
        <LazyMotion features={loadMotionFeatures} strict>
          <m.ul
            id={listId}
            role="listbox"
            aria-label="Pages and actions"
            className="command-palette-list"
            layoutScroll
          >
            {results.length === 0 ? (
              <li className="command-palette-empty" role="presentation">
                Nothing matches “{query}”.
              </li>
            ) : null}
            <AnimatePresence initial={false} mode="popLayout">
              {results.flatMap((command, position) => {
                const heading = command.group !== results[position - 1]?.group ? command.group : null
                const selected = command === active
                const row = (
                  <PaletteRow
                    key={command.id}
                    id={`${listId}-${command.id}`}
                    command={command}
                    selected={selected}
                    onPoint={() => setIndex(results.indexOf(command))}
                    onRun={() => run(command)}
                  />
                )
                return heading ? [<PaletteGroup key={`group-${heading}`} label={heading} />, row] : [row]
              })}
            </AnimatePresence>
          </m.ul>
        </LazyMotion>
      </DialogContent>
    </Dialog>
  )
}

/** A row; while it fades out after a filter it leaves the listbox (no role, hidden). */
function PaletteRow({
  ref,
  id,
  command,
  selected,
  onPoint,
  onRun,
}: {
  /** AnimatePresence's popLayout measures a leaving row through its ref. */
  ref?: React.Ref<HTMLLIElement>
  id: string
  command: PaletteCommand
  selected: boolean
  onPoint: () => void
  onRun: () => void
}) {
  const present = useIsPresent()
  const Icon = command.icon
  return (
    <m.li
      ref={ref}
      layout="position"
      transition={ROW_MOVE}
      exit={ROW_EXIT}
      id={present ? id : undefined}
      role={present ? "option" : undefined}
      aria-selected={present ? selected : undefined}
      aria-hidden={present ? undefined : "true"}
      className="command-palette-item"
      onPointerMove={present ? onPoint : undefined}
      onClick={present ? onRun : undefined}
    >
      {selected && present ? (
        <m.span
          layoutId="palette-sel"
          className="command-palette-selection"
          transition={SELECTION_SPRING}
          aria-hidden="true"
        />
      ) : null}
      <Icon aria-hidden="true" />
      <span className="flex-1 truncate">{command.label}</span>
      {command.shortcut ? <kbd aria-hidden="true">{command.shortcut}</kbd> : null}
      {selected ? <CornerDownLeft aria-hidden="true" className="command-palette-enter" /> : null}
    </m.li>
  )
}

function PaletteGroup({ ref, label }: { ref?: React.Ref<HTMLLIElement>; label: string }) {
  const present = useIsPresent()
  return (
    <m.li
      ref={ref}
      layout="position"
      transition={ROW_MOVE}
      exit={ROW_EXIT}
      role="presentation"
      aria-hidden={present ? undefined : "true"}
      className="micro command-palette-group"
    >
      {label}
    </m.li>
  )
}

export type ShortcutGroup = { title: string; rows: Array<{ keys: string[]; label: string }> }

/** `?`: every keyboard shortcut on one card. */
export function ShortcutsDialog({
  open,
  onOpenChange,
  groups,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  groups: ShortcutGroup[]
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="nav-drop-in gap-5 p-6 sm:max-w-[440px]">
        <div>
          <DialogTitle className="text-lg font-semibold">Keyboard shortcuts</DialogTitle>
          <DialogDescription className="mt-1">Press ? any time to see this again.</DialogDescription>
        </div>
        {groups.map((group) => (
          <section key={group.title} aria-label={group.title}>
            <h3 className="micro mb-2">{group.title}</h3>
            <dl className="shortcut-list">
              {group.rows.map((row) => (
                <div key={row.label}>
                  <dt>{row.label}</dt>
                  <dd>
                    {row.keys.map((key, position) => (
                      <kbd key={`${key}-${position}`}>{key}</kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </DialogContent>
    </Dialog>
  )
}
