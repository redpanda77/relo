import { AudioWaveform, CircleDashed, Hand, MessageCircleQuestion, Moon, Square, type LucideIcon } from "lucide-react"

import type { NowSummary } from "@relo/notification-contracts"

import { ComputerIcon } from "@/components/atoms/computer-icon"
import { Card, CardHit, Origin } from "@/components/card"
import { Fold } from "@/components/molecules/fold"
import { PresenceList } from "@/components/molecules/presence-list"
import { NowSection, NowTimeText } from "@/features/inbox/now-all-clear"
import { useNowStage } from "@/features/inbox/now-context"
import { groupSessionRows, sessionRowView, type SessionIcon, type SessionRow } from "@/features/inbox/sessions-model"
import { SESSIONS_CSS } from "@/lib/signal"
import { toneClass } from "@/lib/work-outcome"
import { cn } from "@/lib/utils"

export type SessionWorkLink = { title: string; open: () => void }

const rowKey = (row: SessionRow) => row.id
// One id per session wherever it is listed, so a session the server folds as idle travels there.
const rowLayoutId = (row: SessionRow) => `now-session-${row.id}`
// Instants are marked and rendered by a leaf that keeps them current; this list itself never re-renders on a clock.
const markTime = (iso: string) => `\u0001${iso}\u0001`
const rowAttributes = (row: SessionRow) => ({ "data-session-phase": row.phase ?? "unobserved" })
const clockFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })

const STANDING_ICON: Record<SessionIcon, LucideIcon> = {
  working: AudioWaveform,
  turn: Hand,
  input: MessageCircleQuestion,
  idle: Moon,
  ended: Square,
  unobserved: CircleDashed,
}

/**
 * A session is the card set's row, two lines at most (iOS sessionRow): where it runs, the tool as
 * its logo then the project, then the session's own name after "›", with how it stands trailing
 * (its mark, a hand on your turn, and when it was last seen); the work it holds (opens it) under.
 * The computer is the group's caption.
 */
function SessionRowBody({ row, link }: { row: SessionRow; link?: SessionWorkLink }) {
  const view = sessionRowView(row, markTime)
  const seen = view.lastSeenAt ? clockFormat.format(new Date(view.lastSeenAt)) : null
  const Icon = STANDING_ICON[view.standing.icon]
  return (
    <Card variant="row">
      <CardHit>
        <div className="card-row-text">
          <div className="card-row-top">
            <Origin source={view.tool} project={view.project} projectColor={view.projectColor} topic={view.name} />
            <p className={cn("card-session-standing", toneClass(view.standing.tone))} data-session-standing>
              <span className="card-session-state">
                <Icon className="card-session-icon" aria-hidden="true" />
                <NowTimeText text={view.standing.label} />
              </span>
              {seen ? (
                <>
                  <span className="card-sep" aria-hidden="true"> · </span>
                  <time className="tabular-nums" dateTime={view.lastSeenAt ?? undefined}>{seen}</time>
                </>
              ) : null}
            </p>
          </div>
          {link ? (
            <button type="button" onClick={link.open} aria-label={`Open ${link.title}`} className="card-row-link">
              {link.title}
            </button>
          ) : null}
        </div>
      </CardHit>
    </Card>
  )
}

function Rows({
  rows,
  works,
  label,
}: {
  rows: readonly SessionRow[]
  works: ReadonlyMap<string, SessionWorkLink>
  label: string
}) {
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
      className="card-list"
    >
      {(row) => <SessionRowBody row={row} link={row.workId ? works.get(row.workId) : undefined} />}
    </PresenceList>
  )
}

/**
 * The server's sessions view: one glass card per computer (its name as the caption above), its
 * sessions as rows, and that computer's idle sessions folded at the bottom of the same card
 * ("Idle (n)"). Phase, order and the idle fold all come from the server. Hidden when the server
 * lists no sessions.
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
  const groups = groupSessionRows(sessions.sessions)
  // One computer: its name rides the section caption, so the card starts where the other columns' do.
  const single = groups.length === 1
  return (
    <NowSection
      title="Sessions"
      count={working}
      color={SESSIONS_CSS}
      detail={
        single ? (
          <>
            <ComputerIcon icon={groups[0]!.icon ?? "laptop"} />
            <span className="truncate">{groups[0]!.label}</span>
          </>
        ) : undefined
      }
    >
      <div className="now-sessions">
        {groups.map((group) => (
          <div key={group.key} className="now-session-group" role="group" aria-label={group.label}>
            {single ? null : (
              <p className="now-session-computer">
                <ComputerIcon icon={group.icon ?? "laptop"} />
                <span className="truncate">{group.label}</span>
              </p>
            )}
            <div className="card-frame glass">
              {group.rows.length ? <Rows rows={group.rows} works={works} label={`Sessions on ${group.label}`} /> : null}
              {group.idle.length ? (
                <Fold name="idle" label="Idle" count={group.idle.length} className="now-fold now-fold-inline">
                  <Rows rows={group.idle} works={works} label={`Idle sessions on ${group.label}`} />
                </Fold>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </NowSection>
  )
}
