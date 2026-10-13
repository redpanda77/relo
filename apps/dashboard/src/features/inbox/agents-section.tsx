import { Laptop } from "lucide-react"

import {
  groupSessions,
  harnessLabel,
  presenceView,
  sessionElapsed,
  type AgentSession,
} from "@/features/inbox/sessions-model"
import { NowSection } from "@/features/inbox/now-all-clear"
import { EncryptedText } from "@/components/atoms/encrypted-text"
import { displayName } from "@/lib/encrypted"
import { SIGNAL_CSS } from "@/lib/signal"
import { useTicker } from "@/lib/ticker"
import { cn } from "@/lib/utils"

export type SessionCardLink = { title: string; encrypted?: boolean; open: () => void }

function PresenceChip({ session, syncedAt, now }: { session: AgentSession; syncedAt: number; now: number }) {
  const view = presenceView(session, now, syncedAt)
  return (
    <span
      className={cn("outcome-badge", `tone-${view.tone}`)}
      data-presence={session.presence}
      style={session.presence === "quiet" ? { color: SIGNAL_CSS.attention } : undefined}
    >
      {view.label}
    </span>
  )
}

function SessionRow({
  session,
  link,
  syncedAt,
  now,
  live,
}: {
  session: AgentSession
  link?: SessionCardLink
  syncedAt: number
  now: number
  live: boolean
}) {
  const elapsed = live ? sessionElapsed(session, now) : null
  return (
    <li className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 py-2" data-session-presence={session.presence}>
      <div className="min-w-0">
        <p className="truncate text-[15px] leading-snug font-medium text-foreground">
          {harnessLabel(session.harness)}
          {session.project ? <span className="text-muted-foreground">{` · ${displayName(session.project)}`}</span> : null}
        </p>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5">
          {elapsed ? <span className="micro tabular-nums normal-case tracking-wide" data-part="elapsed">{elapsed}</span> : null}
          {session.presence === "working" && link ? (
            <button
              type="button"
              onClick={link.open}
              aria-label={link.encrypted ? "Open encrypted item" : `Open ${link.title}`}
              className="micro max-w-full cursor-pointer truncate normal-case tracking-wide underline-offset-2 hover:underline"
              style={{ color: SIGNAL_CSS.running }}
            >
              {link.encrypted ? <EncryptedText /> : link.title}
            </button>
          ) : null}
        </div>
      </div>
      <PresenceChip session={session} syncedAt={syncedAt} now={now} />
    </li>
  )
}

/** Live agent sessions by computer · account, with the recent ones folded away. Hidden without sessions. */
export function AgentsSection({
  sessions,
  cards,
  syncedAt,
}: {
  sessions: readonly AgentSession[] | undefined
  /** Open cards by id, to link a working session to its card. */
  cards: ReadonlyMap<string, SessionCardLink>
  /** When the sessions were fetched, so quiet text keeps counting. */
  syncedAt: number
}) {
  const enabled = (sessions?.length ?? 0) > 0
  const now = useTicker(enabled)
  if (!enabled) return null
  const view = groupSessions(sessions, now)
  if (view.liveCount === 0 && view.recent.length === 0) return null
  return (
    <NowSection title="Agents" count={view.liveCount} color={SIGNAL_CSS.running}>
      {view.live.map((group) => (
        <div key={group.key} className="holo-card tone-cyan p-4" role="group" aria-label={group.label}>
          <span className="micro inline-flex items-center gap-1.5 normal-case tracking-wide">
            <Laptop className="size-3 shrink-0" aria-hidden="true" />
            {group.label}
          </span>
          <ul aria-label={`Agents on ${group.label}`} className="mt-1 divide-y divide-white/5">
            {group.sessions.map((session) => (
              <SessionRow
                key={session.id}
                session={session}
                link={session.card ? cards.get(session.card.id) : undefined}
                syncedAt={syncedAt}
                now={now}
                live
              />
            ))}
          </ul>
        </div>
      ))}
      {view.recent.length > 0 ? (
        <details className="group">
          <summary className="micro cursor-pointer select-none">{`Recent ${view.recent.length}`}</summary>
          <ul aria-label="Recent agent sessions" className="mt-1 divide-y divide-white/5">
            {view.recent.map((session) => (
              <SessionRow key={session.id} session={session} syncedAt={syncedAt} now={now} live={false} />
            ))}
          </ul>
        </details>
      ) : null}
    </NowSection>
  )
}
