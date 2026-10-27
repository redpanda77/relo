import { ArrowRight } from "lucide-react"
import { LazyMotion, m, type TargetAndTransition } from "motion/react"
import * as React from "react"

import { ComputerIcon } from "@/components/atoms/computer-icon"
import type { StandbyMachine } from "@/features/inbox/sessions-model"
import { useNowStage } from "@/features/inbox/now-context"
import { canEndWork, EndWorkButton } from "@/features/inbox/end-work"
import { MissedActions } from "@/features/inbox/missed-question"
import { isMissedQuestion, nowCardView, type NowItem } from "@/features/inbox/now-model"
import { relativeTime } from "@/lib/format"
import { DUR, EASE_IN, EASE_OUT, loadMotionFeatures } from "@/lib/motion"
import { useTicker } from "@/lib/ticker"
import { type WorkTone } from "@/lib/work-outcome"
import { cn } from "@/lib/utils"
import { SECTION_CAPTION_CLASS } from "@/components/list"
import { AnimatedNumber } from "@/components/atoms/animated-number"
import { FoldOpenContext } from "@/components/molecules/fold-context"
import { PresenceList } from "@/components/molecules/presence-list"
import { sessionTitle } from "@/lib/encrypted"
import { WorkCard, type WorkState } from "@/components/organisms/work-card"
import { AnswerControls } from "@/components/molecules/answer-controls"
import { isOpenQuestion, useAnswerableQuestion } from "@/hooks/use-answerable-question"

const HEADING_IN = { opacity: 1, y: 0, transition: { duration: DUR.fast, ease: EASE_OUT } }

/**
 * The caption that opens every Now section (the one section caption, components/list.tsx): the
 * title muted, the count in the section's meaning colour, so "NEEDS YOU 2" is orange and "RUNNING
 * 3" is cyan. 12px from caption to content. A section that appears after the first paint leads with
 * its heading; its items follow a beat later.
 */
export function NowSection({
  title,
  count,
  color,
  detail,
  className,
  children,
}: {
  title: string
  count?: number
  color?: string
  /** One muted word after the count (the one computer the sessions run on), so no row of its own is needed. */
  detail?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  const { ready } = useNowStage()
  const id = `now-${title.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`
  return (
    <section aria-labelledby={id} className={cn("now-section space-y-2.5", className)}>
      <LazyMotion features={loadMotionFeatures} strict>
        <m.h2 id={id} className={SECTION_CAPTION_CLASS} initial={ready ? { opacity: 0, y: 6 } : false} animate={HEADING_IN}>
          <span>{title}</span>
          {count != null ? (
            <span className="now-section-count tabular-nums" style={{ color: color ?? "var(--muted-foreground)" }}>
              <AnimatedNumber value={count} />
            </span>
          ) : null}
          {detail ? <span className="now-section-detail">{detail}</span> : null}
        </m.h2>
      </LazyMotion>
      {children}
    </section>
  )
}

/**
 * Relative times live in their own leaf: only the words "3 min ago" re-render on the page's 1 s
 * clock, never the card or the list around them. Copy comes from `nowCardView` with each instant
 * marked, then split here.
 */
const TIME_MARK = "\u0001"
const markTime = (iso: string) => `${TIME_MARK}${iso}${TIME_MARK}`

/** Copy with marked instants (`\u0001iso\u0001`), each shown as a relative time kept current: a leaf, so only these words re-render each second. */
export function NowTimeText({ text }: { text: string }) {
  const marked = text.includes(TIME_MARK)
  useTicker(marked)
  if (!marked) return <>{text}</>
  return <>{text.split(TIME_MARK).map((part, index) => (index % 2 ? relativeTime(part) : part)).join("")}</>
}

const itemKey = (item: NowItem) => item.id
/** Shared by the card lists (Needs you, Waiting on you, Running, Quiet, Paused), so an item the server moves between them travels. */
const cardLayoutId = (item: NowItem) => `now-item-${item.id}`

const FOLD_PLACES = new Set(["quiet", "paused"])
/** A finished card holds its completion beat (tone to mint, Done, steps full), then lifts away. */
const FINISH_EXIT: TargetAndTransition = { opacity: 0, scale: 0.96, y: -6, transition: { duration: DUR.fast, ease: EASE_IN, delay: 0.35 } }
/** An item moving into a closed fold drops toward its summary line. */
const TO_FOLD_EXIT: TargetAndTransition = { opacity: 0, scale: 0.98, y: 4, transition: { duration: DUR.fast, ease: EASE_IN } }

/**
 * The tone a card first shows: the one it last had on Now (an item the server moves from Running to
 * Needs you arrives cyan and crossfades to orange in place), then its own on the next frame.
 */
function useToneHandoff(id: string, tone: WorkTone): WorkTone {
  const { tones } = useNowStage()
  const [shown, setShown] = React.useState(() => tones.get(id) ?? tone)
  React.useEffect(() => {
    if (shown === tone) return
    const frame = window.requestAnimationFrame(() => setShown(tone))
    return () => window.cancelAnimationFrame(frame)
  }, [shown, tone])
  React.useEffect(() => {
    tones.set(id, tone)
  }, [tones, id, tone])
  return shown
}

const NOW_CLOCK = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })

/**
 * One Now card on the shared `WorkCard`. It shows the latest copy of its item (`NowStage.items`), so
 * a card that is already leaving shows what became of it: finished work turns mint with Done and
 * full steps for its beat.
 */
const NowCard = React.memo(function NowCard({
  item: listed,
  onOpen,
}: {
  item: NowItem
  onOpen: (item: NowItem) => void
}) {
  const stage = useNowStage()
  const item = stage.items.get(listed.id) ?? listed
  const session = stage.sessionByWork.get(item.id)
  const view = nowCardView(item, markTime, session ? sessionTitle(session.id) : null, session?.computer ?? null)
  const tone = useToneHandoff(listed.id, view.tone)
  const needsYou = item.owner.state === "needs_you"
  // A pending question is answered right on its card, as on the iPhone (permission prompts are not
  // answerable here).
  const answerable = needsYou && item.owner.needsYou !== "permission" ? item.question?.id ?? null : null
  const question = useAnswerableQuestion(answerable)
  const asking = question && isOpenQuestion(question) ? question : null
  // A missed question: Dismiss, or Answer late right on the card (a note for the session, never permission).
  const missed = isMissedQuestion(item)
  const lateQuestion = missed && question?.state === "expired" ? question : null
  const [answeringLate, setAnsweringLate] = React.useState(false)
  // Offline, moving work is only last known: say so instead of claiming it still runs (iPhone parity).
  const unconfirmed = stage.offline && (item.owner.state === "moving" || item.owner.state === "working_quietly")
  const time = (text: string) => <NowTimeText text={text} />
  const owner = item.owner.state
  // The header chip (live cards): needs you leads with the blinking dot and its countdown, running with the
  // glowing dot, quiet with a moon and its minutes, your turn with the return arrow, done and failed with their marks.
  const chipState: WorkState | null = unconfirmed
    ? { label: "Unconfirmed" }
    : missed
      ? { label: "Missed", icon: view.state?.icon }
      : needsYou
        ? { label: "Needs you", dot: true }
        : owner === "moving" || owner === "working_quietly"
          ? { label: view.state?.label ?? "Running", dot: true }
          : owner === "stale" && view.state
            ? { label: view.state.label, icon: view.state.icon, quietSince: item.owner.evidenceAt ?? item.declaredAt }
            : view.state
  const quiet = owner === "stale"
  // A quiet card says since when; the facts that repeat the chip ("updated 14 min ago") are dropped.
  const quietStatus = quiet && !view.summary && !view.encrypted ? `No update since ${NOW_CLOCK.format(new Date(item.owner.evidenceAt ?? item.declaredAt))}.` : view.summary
  const facts = quiet ? view.facts.filter((fact) => !fact.startsWith("updated ")) : view.facts
  // The owner's End, for the states the iPhone offers it in (never moving work), when the server is reachable.
  const actions = stage.actions
  const end = actions && !stage.offline && canEndWork(owner) ? (
    <EndWorkButton workId={item.id} goal={view.encrypted ? "this work" : view.title} end={actions.end} />
  ) : null
  const missedActions = actions && missed && item.question ? (
    <MissedActions
      questionId={item.question.id}
      dismiss={actions.dismiss}
      answering={answeringLate}
      onAnswerLate={() => setAnsweringLate((value) => !value)}
    />
  ) : undefined
  return (
    <WorkCard
      variant="live"
      tone={tone}
      title={view.title}
      encrypted={view.encrypted}
      origin={{ ...view.origin, hasLink: Boolean(item.notificationId && stage.links.has(item.notificationId)) }}
      summary={quietStatus}
      summaryLines={needsYou ? 4 : 2}
      eyebrow={null}
      note={needsYou ? view.note : null}
      asked={needsYou && !missed}
      // Needs you and quiet cards draw no bar: the step words stay in the footer.
      meter={needsYou || quiet ? null : view.meter}
      caption={needsYou ? null : view.caption}
      state={chipState}
      facts={facts.map(time)}
      runningSince={unconfirmed ? null : view.runningSince}
      at={view.at}
      computer={view.computer}
      computerIcon={view.computerIcon}
      deadline={asking?.expiresAt ?? null}
      answers={
        asking ? (
          <AnswerControls question={asking} showPrompt={false} countdown={false} layout="card" />
        ) : lateQuestion && answeringLate ? (
          <AnswerControls question={lateQuestion} showPrompt={false} countdown={false} layout="card" late />
        ) : undefined
      }
      actions={missedActions}
      end={end}
      tint={needsYou || owner === "waiting_on_you"}
      className={quiet ? "now-card-quiet" : undefined}
      live={view.live && !unconfirmed}
      onOpen={() => onOpen(listed)}
      openLabel={view.encrypted ? "Open encrypted item" : `Open ${item.title}`}
      open={stage.openId === listed.id}
      attrs={{
        "data-owner-state": item.owner.state,
        "data-live": view.live ? "true" : undefined,
      }}
    />
  )
})

/**
 * One Now list of live work cards, styled by the server's owner state, never by a client clock (settled and
 * parked work is `SettledList`). Items arrive, leave and move with the server's refreshes (`PresenceList`); the
 * first paint is still. Cards travel between card lists (one layout id) unless the destination is a
 * closed fold, where they drop toward its summary instead; finished cards hold a beat and lift away
 * while their row arrives at the top of Since you looked.
 */
export function NowItemList({
  label,
  items,
  onOpen,
  className,
}: {
  label: string
  items: readonly NowItem[]
  onOpen: (item: NowItem) => void
  className?: string
}) {
  const stage = useNowStage()
  const foldOpen = React.useContext(FoldOpenContext)
  const itemAttributes = (item: NowItem) => ({ "data-announce": stage.announce.has(item.id) ? "true" : undefined })
  const exitFor = (item: NowItem): TargetAndTransition | undefined => {
    const place = stage.places.get(item.id)
    if (place === "recent") return FINISH_EXIT
    if (place && FOLD_PLACES.has(place) && !stage.isFoldOpen(place)) return TO_FOLD_EXIT
    return undefined
  }
  return (
    <PresenceList
      label={label}
      items={items}
      getKey={itemKey}
      layoutId={foldOpen ? cardLayoutId : () => undefined}
      animateFirst={stage.ready}
      enterDelay={stage.ready ? 0.06 : 0}
      exitFor={exitFor}
      itemAttributes={itemAttributes}
      className={cn("now-card-grid", className)}
      itemClassName="now-card-slot"
    >
      {(item) => <NowCard item={item} onOpen={onOpen} />}
    </PresenceList>
  )
}

/** Nothing is running: a calm card with a breathing dot and the computers Relo knows (green when seen in the last ten minutes). */
function StandingBy({ machines }: { machines: readonly StandbyMachine[] }) {
  const { ready } = useNowStage()
  return (
    <LazyMotion features={loadMotionFeatures} strict>
      <m.div
        className="standby"
        initial={ready ? { opacity: 0 } : false}
        animate={{ opacity: 1, transition: { duration: DUR.slow, ease: EASE_OUT } }}
      >
        <p className="standby-eyebrow">
          <span className="breath-dot" aria-hidden="true" />
          Standing by
        </p>
        <p className="standby-body">Nothing is running. New work appears here the moment it starts.</p>
        {machines.length ? (
          <ul className="standby-machines" aria-label="Your computers">
            {machines.map((machine) => (
              <li key={machine.key}>
                <ComputerIcon icon={machine.icon ?? "laptop"} />
                {machine.name}
                <span className="standby-seen" data-seen={machine.seen} role="img" aria-label={machine.seen ? "seen just now" : "not seen lately"} />
              </li>
            ))}
          </ul>
        ) : null}
      </m.div>
    </LazyMotion>
  )
}

/** A quiet text link at the very end of Now, not a button. */
function HistoryLink() {
  return (
    <a
      href="/dashboard/inbox/notifications"
      className="now-history-link inline-flex min-h-11 items-center gap-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground"
    >
      View history <ArrowRight className="size-3.5" aria-hidden="true" />
    </a>
  )
}

/**
 * The end of Now: "Standing by" with the computers Relo knows when nothing is open, and "View history" always last
 * (the iPhone's). Today's settled work is History's, not Now's.
 */
export function NowFooter({
  allClear,
  machines = [],
}: {
  /** Nothing needs you and nothing is live: the standing-by note shows. */
  allClear: boolean
  /** The computers on the Standing by card. */
  machines?: readonly StandbyMachine[]
}) {
  return (
    <div className="now-footer space-y-4" data-now-footer>
      {allClear ? <StandingBy machines={machines} /> : null}
      <div className="flex justify-center">
        <HistoryLink />
      </div>
    </div>
  )
}
