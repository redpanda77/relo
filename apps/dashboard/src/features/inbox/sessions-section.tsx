import * as React from "react"

import type { NowSummary } from "@relo/notification-contracts"

import { ComputerIcon } from "@/components/atoms/computer-icon"
import { sourceLogo } from "@/components/atoms/source-logo"
import { SourceMark } from "@/components/atoms/source-mark"
import { PresenceList } from "@/components/molecules/presence-list"
import { NowSection, NowTimeText } from "@/features/inbox/now-cards"
import { useNowStage } from "@/features/inbox/now-context"
import {
  activeSessionCount,
  groupSessionRows,
  machineView,
  sessionRowView,
  type MachineView,
  type SessionRow,
} from "@/features/inbox/sessions-model"
import { SESSIONS_CSS } from "@/lib/signal"

export type SessionWorkLink = { title: string; open: () => void }

const rowKey = (row: SessionRow) => row.id
// One id per session wherever it is listed, so a session the server folds as idle travels there.
const rowLayoutId = (row: SessionRow) => `now-session-${row.id}`
// Instants are marked and rendered by a leaf that keeps them current; this list itself never re-renders on a clock.
const markTime = (iso: string) => `\u0001${iso}\u0001`
const rowAttributes = (row: SessionRow) => ({ "data-session-phase": row.phase ?? "unobserved" })
const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
const clock = (iso: string) => clockFormat.format(new Date(iso))

/** A harness as its mark in a tile or chip; a harness without a logo shows its initial. */
function Harness({ source, size }: { source: string | null; size: number }) {
  if (!source) return null
  if (sourceLogo(source)) return <SourceMark name={source} size={size} />
  return <span className="sess-harness-initial" aria-hidden="true">{source.charAt(0).toUpperCase()}</span>
}

/** "62% · $1.84" under a session's name, with the 46 x 3 context bar (amber from 80%). */
function ContextLine({ usage, seen }: { usage: ReturnType<typeof sessionRowView>["usage"]; seen: string | null }) {
  if (!usage && !seen) return null
  return (
    <div className="sess-context" data-heavy={usage?.heavy || undefined}>
      {usage?.pct != null ? (
        <span className="sess-bar" aria-hidden="true">
          <b style={{ width: `${usage.pct}%` }} />
        </span>
      ) : null}
      <span>
        {usage?.pct != null ? <em className="sess-pct">{usage.pct}%</em> : null}
        {usage?.pct != null && usage.cost ? " · " : null}
        {usage?.cost}
        {!usage && seen ? <time dateTime={seen}>{clock(seen)}</time> : null}
      </span>
    </div>
  )
}

/** One session: the harness tile, its name and context, and its phase chip (a waveform while it works). */
function SessionRowBody({ row, link }: { row: SessionRow; link?: SessionWorkLink }) {
  const view = sessionRowView(row, markTime)
  const content = (
    <>
      <span className="sess-tile" aria-hidden="true">
        <Harness source={row.source} size={11} />
      </span>
      <span className="sess-text">
        <span className="sess-title">{view.heading}</span>
        <ContextLine usage={view.usage} seen={view.lastSeenAt} />
      </span>
      <span className="sess-chip" data-tone={view.chip.tone} data-session-standing>
        {view.chip.working ? (
          <span className="sess-wave" aria-hidden="true">
            <s />
            <s />
            <s />
          </span>
        ) : null}
        <NowTimeText text={view.chip.label} />
      </span>
    </>
  )
  return link ? (
    <button type="button" className="sess-row" data-working={view.chip.working || undefined} onClick={link.open} aria-label={`${view.heading}, ${view.chip.label}. Open ${link.title}`}>
      {content}
    </button>
  ) : (
    <div className="sess-row" data-working={view.chip.working || undefined}>
      {content}
    </div>
  )
}

function Rows({ rows, works, label }: { rows: readonly SessionRow[]; works: ReadonlyMap<string, SessionWorkLink>; label: string }) {
  const { ready } = useNowStage()
  return (
    <PresenceList
      label={label}
      items={rows}
      getKey={rowKey}
      layoutId={rowLayoutId}
      itemAttributes={rowAttributes}
      animateFirst={ready}
      enterDelay={ready ? 0.06 : 0}
      className="sess-rows"
      itemClassName="sess-item"
    >
      {(row) => <SessionRowBody row={row} link={row.workId ? works.get(row.workId) : undefined} />}
    </PresenceList>
  )
}

/** The machine's header: its glyph with a status dot, its name and summary, and its harness counts. */
function MachineHeader({ view, trailing, open, line }: { view: MachineView; trailing?: string; open: boolean; line: boolean }) {
  return (
    <span className="sess-head" data-line={line || undefined}>
      <span className="sess-machine-tile">
        <ComputerIcon icon={view.group.icon ?? "laptop"} className="size-4" />
        <i className="sess-dot" data-tone={view.dot ?? "idle"} aria-hidden="true" />
      </span>
      <span className="sess-head-text">
        <span className="sess-machine-name">{view.group.label}</span>
        <span className="sess-machine-summary">{view.summary}</span>
      </span>
      {view.harnesses.map((harness) => (
        <span key={harness.source} className="sess-harness-chip" data-source={harness.source}>
          <Harness source={harness.source} size={10} />
          <span>{harness.count}</span>
        </span>
      ))}
      {trailing ? (
        <span className="sess-trailing">
          {trailing}
          <span className="sess-trailing-chevron" data-open={open || undefined} aria-hidden="true">{"›"}</span>
        </span>
      ) : null}
    </span>
  )
}

/** One machine: its header, its sessions, and its idle sessions behind "N idle". */
function MachineCard({ view, works }: { view: MachineView; works: ReadonlyMap<string, SessionWorkLink> }) {
  const { group } = view
  const [open, setOpen] = React.useState(false)
  const idleCount = group.idle.length
  const idleOnly = view.idleOnly
  const body = !idleOnly || (open && idleCount > 0)
  return (
    <div className="sess-card glass" role="group" aria-label={group.label} data-idle-only={idleOnly || undefined}>
      {idleOnly && idleCount > 0 ? (
        <button type="button" className="sess-head-button" aria-expanded={open} aria-label={`${group.label}, ${view.summary}, ${idleCount} idle`} onClick={() => setOpen((value) => !value)}>
          <MachineHeader view={view} trailing={`${idleCount} idle`} open={open} line={body} />
        </button>
      ) : (
        <MachineHeader view={view} open={false} line={body} />
      )}
      {group.rows.length ? <Rows rows={group.rows} works={works} label={`Sessions on ${group.label}`} /> : null}
      {!idleOnly && idleCount > 0 ? (
        <button type="button" className="sess-idle-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {idleCount} idle {open ? "⌃" : "›"}
        </button>
      ) : null}
      {open && idleCount > 0 ? <Rows rows={group.idle} works={works} label={`Idle sessions on ${group.label}`} /> : null}
    </div>
  )
}

/**
 * The server's sessions view (the iPhone's sessionsSection): a caption counting every session that is
 * not idle, then one glass card per machine, 14px apart. Phase, order and the idle fold all come from
 * the server. Hidden when the server lists no sessions.
 */
export function SessionsSection({
  sessions,
  works,
}: {
  sessions: NowSummary["sessions"]
  /** Linked works by id (Running, Your turn, Needs you). */
  works: ReadonlyMap<string, SessionWorkLink>
}) {
  if (sessions.sessions.length === 0) return null
  const machines = groupSessionRows(sessions.sessions).map((group) => machineView(group, clock))
  return (
    <NowSection title="Sessions" count={activeSessionCount(sessions.sessions)} color={SESSIONS_CSS}>
      <div className="now-sessions">
        {machines.map((view) => (
          <MachineCard key={view.group.key} view={view} works={works} />
        ))}
      </div>
    </NowSection>
  )
}
