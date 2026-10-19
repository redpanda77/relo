import { ArrowRight, Check, Minus, MessageSquareText, type LucideIcon } from "lucide-react"
import { LazyMotion, m, type TargetAndTransition } from "motion/react"
import * as React from "react"

import {
  signalOf,
  openLabel,
  type ActivityCard,
  type TodayActivity,
} from "@/features/inbox/activity-model"
import { useNowStage } from "@/features/inbox/now-context"
import { nowCardView, type NowItem } from "@/features/inbox/now-model"
import { relativeTime } from "@/lib/format"
import { DUR, EASE_IN, EASE_OUT, loadMotionFeatures } from "@/lib/motion"
import { useTicker } from "@/lib/ticker"
import { SIGNALS, SIGNAL_CSS, type Signal } from "@/lib/signal"
import { workOutcome, type WorkTone } from "@/lib/work-outcome"
import { cn } from "@/lib/utils"
import { SignalGlyph } from "@/components/atoms/signal-glyph"
import { SECTION_CAPTION_CLASS } from "@/components/list"
import { AnimatedNumber } from "@/components/atoms/animated-number"
import { FoldOpenContext } from "@/components/molecules/fold-context"
import { PresenceList } from "@/components/molecules/presence-list"
import { sessionTitle } from "@/lib/encrypted"
import { CardList, CardListItem } from "@/components/card"
import { WorkCard, WorkRow } from "@/components/organisms/work-card"
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
    <section aria-labelledby={id} className={cn("now-section space-y-3", className)}>
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
/** Rows morph only between rows: finished work does not stretch a card into a row, it hands over. */
const rowLayoutId = (item: NowItem) => `now-row-${item.id}`

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

/** The leading glyph of a needs-you card: its reason's icon. */
function NeedsGlyph({ item }: { item: NowItem }) {
  const outcome = workOutcome({ state: item.owner.state, needsYou: item.owner.needsYou })
  return <SignalGlyph icon={outcome?.icon} color="var(--tone)" />
}

/**
 * One Now card on the shared `WorkCard`. It shows the latest copy of its item (`NowStage.items`), so
 * a card that is already leaving shows what became of it: finished work turns mint with Done and
 * full steps for its beat.
 */
const NowCard = React.memo(function NowCard({
  item: listed,
  onOpen,
  variant,
  arrived = false,
}: {
  item: NowItem
  onOpen: (item: NowItem) => void
  variant: "live" | "row"
  /** A row that just arrived (finished work landing in Since you looked) washes in its tone once. */
  arrived?: boolean
}) {
  const stage = useNowStage()
  const item = stage.items.get(listed.id) ?? listed
  const session = stage.sessionByWork.get(item.id)
  const view = nowCardView(item, markTime, session ? sessionTitle(session.id) : null, session?.computer ?? null)
  const tone = useToneHandoff(listed.id, view.tone)
  const needsYou = item.owner.state === "needs_you" && variant === "live"
  // A pending question is answered right on its card, as on the iPhone (permission prompts are not
  // answerable here).
  const answerable = needsYou && item.owner.needsYou !== "permission" ? item.question?.id ?? null : null
  const question = useAnswerableQuestion(answerable)
  const asking = question && isOpenQuestion(question) ? question : null
  // Offline, moving work is only last known: say so instead of claiming it still runs (iPhone parity).
  const unconfirmed = stage.offline && (item.owner.state === "moving" || item.owner.state === "working_quietly")
  const time = (text: string) => <NowTimeText text={text} />
  return (
    <WorkCard
      variant={variant}
      tone={tone}
      title={view.title}
      encrypted={view.encrypted}
      origin={view.origin}
      summary={view.summary}
      summaryLines={needsYou ? 4 : 2}
      eyebrow={needsYou ? view.chip : null}
      note={needsYou ? view.note : null}
      // Needs you: the steps stay in words on the standing line; the bar would only add a row.
      meter={needsYou ? null : view.meter}
      state={unconfirmed ? { label: "Unconfirmed" } : view.state ?? (variant === "row" && view.chip ? { label: view.chip.charAt(0) + view.chip.slice(1).toLowerCase() } : null)}
      // A needs-you card draws no progress row, so its step words stay in the footer.
      facts={(needsYou && view.caption ? [view.caption, ...view.facts] : view.facts).map(time)}
      runningSince={unconfirmed ? null : view.runningSince}
      at={view.at}
      computer={view.computer}
      computerIcon={view.computerIcon}
      glyph={needsYou ? <NeedsGlyph item={item} /> : undefined}
      deadline={asking?.expiresAt ?? null}
      actions={asking ? <AnswerControls question={asking} showPrompt={false} countdown={false} /> : undefined}
      tint={needsYou}
      live={view.live && variant === "live" && !unconfirmed}
      onOpen={() => onOpen(listed)}
      openLabel={view.encrypted ? "Open encrypted item" : `Open ${item.title}`}
      open={stage.openId === listed.id}
      attrs={{
        "data-owner-state": item.owner.state,
        "data-live": view.live ? "true" : undefined,
        "data-arrived": arrived ? "true" : undefined,
      }}
    />
  )
})

/**
 * One Now list: cards styled by the server's owner state, never by a client clock. Live work is a
 * card (`cards`); settled and parked work (`rows`: Since you looked, Quiet, Paused) is one glass list
 * of unframed rows. Items arrive, leave and move with the server's refreshes (`PresenceList`); the
 * first paint is still. Cards travel between card lists (one layout id) unless the destination is a
 * closed fold, where they drop toward its summary instead; finished cards hold a beat and lift away
 * while their row arrives at the top of Since you looked.
 */
export function NowItemList({
  label,
  items,
  onOpen,
  variant = "cards",
  className,
}: {
  label: string
  items: readonly NowItem[]
  onOpen: (item: NowItem) => void
  variant?: "cards" | "rows"
  className?: string
}) {
  const stage = useNowStage()
  const foldOpen = React.useContext(FoldOpenContext)
  const itemAttributes = (item: NowItem) => ({ "data-announce": stage.announce.has(item.id) ? "true" : undefined })
  if (variant === "rows") {
    return (
      <CardList
        label={label}
        items={items}
        getKey={itemKey}
        layoutId={rowLayoutId}
        animateFirst={stage.ready}
        enterDelay={stage.ready ? 0.32 : 0}
        className={className}
      >
        {(item, { entering }) => <NowCard item={item} onOpen={onOpen} variant="row" arrived={entering && stage.ready} />}
      </CardList>
    )
  }
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
      {(item) => <NowCard item={item} onOpen={onOpen} variant="live" />}
    </PresenceList>
  )
}

/** "finished", "failed": the strip's key in the since line's words, so both say the same thing. */
const LEGEND_WORD: Record<Signal, (count: number) => string> = {
  done: () => "finished",
  running: () => "running",
  needsYou: () => "waiting on you",
  attention: () => "to review",
  failed: () => "failed",
  message: (count) => (count === 1 ? "message" : "messages"),
}

const BAR_HEIGHT = 52

/** Flat and quiet: each hour is a thin stacked bar of meaning colors on a faint track, no glow. */
export function ActivityStrip({ activity }: { activity: TodayActivity }) {
  // rest → rising (the first rise, staggered by hour) → settled (later changes move together).
  const [phase, setPhase] = React.useState<"rest" | "rising" | "settled">("rest")
  React.useEffect(() => {
    const frame = window.requestAnimationFrame(() => setPhase("rising"))
    const settle = window.setTimeout(() => setPhase("settled"), 800 + 24 * 20)
    return () => {
      window.cancelAnimationFrame(frame)
      window.clearTimeout(settle)
    }
  }, [])
  const total = activity.rows.length
  const pct = (hour: number) => `${((hour + 0.5) / 24) * 100}%`
  const legend = activity.legend.map((entry) => ({ ...entry, text: `${entry.count} ${LEGEND_WORD[entry.signal](entry.count)}` }))
  const legendSpoken = legend.map((entry) => entry.text).join(", ")
  return (
    <div className="space-y-2.5" data-now-strip>
      <div
        role="img"
        aria-label={`Activity by hour today: ${total} items, busiest hour has ${activity.maxTotal}`}
        aria-description={legendSpoken}
      >
        <div className="flex gap-[3px]">
          {activity.mixes.map((mix, hour) => {
            const count = activity.totals[hour] ?? 0
            const fraction = activity.maxTotal > 0 ? count / activity.maxTotal : 0
            const height = count === 0 ? 0 : Math.max(8, fraction * BAR_HEIGHT)
            // Bars rise by transform (scaleY from the bottom), never by height: no layout per frame.
            const scale = (phase === "rest" ? 3 : height) / BAR_HEIGHT
            return (
              <div key={hour} className="flex min-w-0 flex-1 flex-col items-center gap-1" data-hour={hour}>
                <div className="relative w-full" style={{ height: BAR_HEIGHT }}>
                  <span
                    className="absolute inset-0 rounded-full bg-white"
                    style={{ opacity: hour > activity.currentHour ? 0.03 : 0.06 }}
                  />
                  {count > 0 ? (
                    <span
                      className="strip-bar absolute inset-0 flex flex-col-reverse overflow-hidden rounded-full"
                      style={{ transform: `scaleY(${scale})`, transitionDelay: phase === "rising" ? `${hour * 20}ms` : "0ms" }}
                    >
                      {SIGNALS.map((signal) =>
                        (mix[signal] ?? 0) > 0 ? (
                          <span
                            key={signal}
                            data-signal={signal}
                            style={{ flexGrow: mix[signal], flexBasis: 0, background: SIGNAL_CSS[signal], opacity: 0.85 }}
                          />
                        ) : null
                      )}
                    </span>
                  ) : null}
                </div>
                <span
                  className="h-0.5 w-2 rounded-full"
                  style={{ background: hour === activity.currentHour ? "rgba(255,255,255,0.9)" : "transparent" }}
                  data-now-tick={hour === activity.currentHour || undefined}
                />
              </div>
            )
          })}
        </div>
        <div className="relative mt-1.5 h-3.5" aria-hidden="true">
          {[0, 6, 12, 18].map((hour) =>
            Math.abs(hour - activity.currentHour) > 2 ? (
              <span key={hour} className="micro absolute -translate-x-1/2 text-[9px]" style={{ left: pct(hour) }}>
                {String(hour).padStart(2, "0")}
              </span>
            ) : null
          )}
          <span
            className="micro absolute -translate-x-1/2 text-[9px]"
            style={{ left: `clamp(14px, ${pct(activity.currentHour)}, calc(100% - 14px))`, color: "rgba(255,255,255,0.85)" }}
          >
            NOW
          </span>
        </div>
      </div>
      {legend.length ? (
        <ul aria-label="What the colors mean" className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs text-muted-foreground">
          {legend.map((entry) => (
            <li key={entry.signal} className="inline-flex items-center gap-1.5 tabular-nums" data-signal={entry.signal}>
              <span aria-hidden="true" className="size-1.5 rounded-full" style={{ background: SIGNAL_CSS[entry.signal] }} />
              {entry.text}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function glyph(card: ActivityCard, signal: Signal): { icon?: LucideIcon; color: string; mark?: string } {
  const color = SIGNAL_CSS[signal]
  switch (card.outcome.kind) {
    case "done":
      return { icon: Check, color }
    case "stopped":
      return { color, mark: "!" }
    case "expired":
    case "ended":
    case "replaced":
    case "unanswered":
      return { icon: Minus, color }
    case "answered":
      return { icon: signal === "done" ? Check : Minus, color }
    default:
      return { icon: MessageSquareText, color }
  }
}

/** "Done · 33m · 6 updates": how it ended, how long, how often it spoke; sentence case. */
function logDetail(card: ActivityCard): string {
  const parts = [card.outcome.label ?? card.source]
  if (card.duration != null) {
    const value = Math.round(card.duration)
    parts.push(value < 60 ? `${Math.max(value, 1)}s` : value < 3600 ? `${Math.floor(value / 60)}m` : `${Math.floor(value / 3600)}h ${Math.floor((value % 3600) / 60)}m`)
  }
  if (card.updates && card.updates > 0) parts.push(`${card.updates} ${card.updates === 1 ? "update" : "updates"}`)
  return parts.join(" · ")
}

export function TodayLog({ rows, onOpen }: { rows: ActivityCard[]; onOpen: (id: string) => void }) {
  return (
    <CardList label="Today's log">
      {rows.map((card) => (
        <CardListItem key={card.id}>
          <WorkRow
            glyph={glyph(card, signalOf(card))}
            title={card.title}
            encrypted={card.encrypted}
            detail={logDetail(card)}
            at={card.at}
            onOpen={() => onOpen(card.id)}
            label={openLabel(card)}
          />
        </CardListItem>
      ))}
    </CardList>
  )
}

function StandingBy() {
  const { ready } = useNowStage()
  return (
    <LazyMotion features={loadMotionFeatures} strict>
      <m.div
        className="flex flex-col items-center gap-2.5 py-4 text-center"
        initial={ready ? { opacity: 0 } : false}
        animate={{ opacity: 1, transition: { duration: DUR.slow, ease: EASE_OUT } }}
      >
        <p className="micro" style={{ letterSpacing: "0.24em" }}>Standing by</p>
        <p className="mx-auto max-w-xs text-[13px] text-muted-foreground">
          When an agent starts work or sends a message, it shows up here, live.
        </p>
      </m.div>
    </LazyMotion>
  )
}

/** A quiet text link under the log, not a button. */
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

/** Today's agent time and the spectrum, where the deck does not carry them (phones, narrow windows). */
export type TodayInstruments = { agentTime: string | null; spectrum: React.ReactNode }

/**
 * TODAY: the 24h strip with its key (unless the deck carries it), and today's log (five rows, then
 * View history). The caption's count, the strip's key and the deck's Today count are the same rows.
 * Shown whenever today has items; with nothing today and nothing live, a calm "standing by".
 */
export function NowAllClear({
  activity,
  allClear,
  onOpen,
  strip = true,
  instruments,
}: {
  activity: TodayActivity
  /** Nothing needs you and nothing is live: an empty day then shows the standing-by note. */
  allClear: boolean
  onOpen: (id: string) => void
  /** Show the strip here (phones and narrow windows); the deck shows it beside the work. */
  strip?: boolean
  instruments?: TodayInstruments | null
}) {
  if (activity.rows.length === 0) {
    return allClear ? (
      <div className="now-today space-y-4" data-now-all-clear>
        <StandingBy />
        <div className="flex justify-center">
          <HistoryLink />
        </div>
      </div>
    ) : null
  }
  return (
    <NowSection title="Today" count={activity.rows.length} className="now-today">
      <div className="space-y-3.5" data-now-all-clear>
        {strip ? <ActivityStrip activity={activity} /> : null}
        {strip && instruments && (instruments.agentTime || instruments.spectrum) ? (
          <div className="flex flex-col gap-3">
            {instruments.agentTime ? (
              <span className="micro tabular-nums tracking-[0.1em]" data-hud-agent-time>{`Agent time ${instruments.agentTime}`}</span>
            ) : null}
            {instruments.spectrum}
          </div>
        ) : null}
        <TodayLog rows={activity.rows.slice(0, 5)} onOpen={onOpen} />
        <HistoryLink />
      </div>
    </NowSection>
  )
}
