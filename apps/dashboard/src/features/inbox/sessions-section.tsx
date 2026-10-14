import { Laptop } from "lucide-react"

import type { NowSummary } from "@relo/notification-contracts"

import { NowSection } from "@/features/inbox/now-all-clear"
import { groupSessionRows, sessionRowView, type SessionRow } from "@/features/inbox/sessions-model"
import { relativeTime } from "@/lib/format"
import { SESSIONS_CSS, SIGNAL_CSS } from "@/lib/signal"
import { cn } from "@/lib/utils"

export type SessionWorkLink = { title: string; open: () => void }

function Row({ row, link }: { row: SessionRow; link?: SessionWorkLink }) {
  const view = sessionRowView(row, relativeTime)
  return (
    <li className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 py-2" data-session-phase={row.phase ?? "unobserved"}>
      <div className="min-w-0">
        <p className="truncate text-[15px] leading-snug font-medium text-foreground">{view.title}</p>
        {link ? (
          <button
            type="button"
            onClick={link.open}
            aria-label={`Open ${link.title}`}
            className="micro max-w-full cursor-pointer truncate normal-case tracking-wide underline-offset-2 hover:underline"
            style={{ color: SIGNAL_CSS.running }}
          >
            {link.title}
          </button>
        ) : null}
      </div>
      <span className={cn("outcome-badge", `tone-${view.chip.tone}`)}>{view.chip.label}</span>
    </li>
  )
}

/**
 * The server's sessions view by computer: phase, order and the idle fold all come from the server.
 * Hidden when the server lists no sessions.
 */
export function SessionsSection({
  sessions,
  works,
}: {
  sessions: NowSummary["sessions"]
  /** Linked works by id (Running, Waiting on you, Needs you). */
  works: ReadonlyMap<string, SessionWorkLink>
}) {
  if (sessions.sessions.length === 0) return null
  const working = sessions.sessions.filter((row) => row.phase === "working").length
  return (
    <NowSection title="Sessions" count={working} color={SESSIONS_CSS}>
      {groupSessionRows(sessions.sessions).map((group) => (
        <div key={group.key} className="holo-card tone-violet p-4" role="group" aria-label={group.label}>
          <span className="micro inline-flex items-center gap-1.5 normal-case tracking-wide">
            <Laptop className="size-3 shrink-0" aria-hidden="true" />
            {group.label}
          </span>
          {group.rows.length ? (
            <ul aria-label={`Sessions on ${group.label}`} className="mt-1 divide-y divide-white/5">
              {group.rows.map((row) => (
                <Row key={row.id} row={row} link={row.workId ? works.get(row.workId) : undefined} />
              ))}
            </ul>
          ) : null}
          {group.idle.length ? (
            <details className="group" data-fold="idle">
              <summary className="micro cursor-pointer select-none">{`Idle (${group.idle.length})`}</summary>
              <ul aria-label={`Idle sessions on ${group.label}`} className="mt-1 divide-y divide-white/5">
                {group.idle.map((row) => (
                  <Row key={row.id} row={row} link={row.workId ? works.get(row.workId) : undefined} />
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ))}
    </NowSection>
  )
}
