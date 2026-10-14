import { ArrowRight, Check, Minus, MessageSquareText } from "lucide-react"
import * as React from "react"

import {
  logDetail,
  signalOf,
  timeOfDay,
  openLabel,
  type ActivityCard,
  type TodayActivity,
} from "@/features/inbox/activity-model"
import { nowRowView, type NowItem } from "@/features/inbox/now-model"
import { relativeTime } from "@/lib/format"
import { useTicker } from "@/lib/ticker"
import { SIGNALS, SIGNAL_CSS, type Signal } from "@/lib/signal"
import { cn } from "@/lib/utils"
import { EncryptedText } from "@/components/atoms/encrypted-text"

/**
 * The monospaced caption that opens every Now section: the title in muted text and the count in
 * the section's meaning color, so "NEEDS YOU 2" is orange and "LIVE NOW 3" is cyan.
 */
export function NowSection({
  title,
  count,
  color,
  children,
}: {
  title: string
  count?: number
  color?: string
  children: React.ReactNode
}) {
  const id = `now-${title.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h2 id={id} className="micro flex items-center gap-2 font-semibold" style={{ letterSpacing: "0.16em" }}>
        <span>{title}</span>
        {count != null ? (
          <span className="tabular-nums" style={{ color: color ?? "var(--muted-foreground)" }}>{count}</span>
        ) : null}
      </h2>
      {children}
    </section>
  )
}

/** One Now list: rows styled by the server's owner state, never by a client clock. */
export function NowItemList({
  label,
  items,
  onOpen,
}: {
  label: string
  items: readonly NowItem[]
  onOpen: (item: NowItem) => void
}) {
  useTicker(items.length > 0)
  return (
    <ul aria-label={label} className="space-y-2.5">
      {items.map((item) => {
        const view = nowRowView(item, relativeTime)
        const tone = view.chip?.tone ?? (item.owner.state === "moving" || item.owner.state === "working_quietly" ? "cyan" : "neutral")
        const origin = [item.sourceName, item.project].filter(Boolean).join(" · ")
        const open = () => onOpen(item)
        return (
          <li key={item.id}>
            <div
              role="button"
              tabIndex={0}
              onClick={open}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault()
                  open()
                }
              }}
              aria-label={`Open ${item.title}`}
              className={cn("holo-card block w-full cursor-pointer space-y-2.5 p-4 text-left", `tone-${tone}`, view.dim && "opacity-70")}
              data-owner-state={item.owner.state}
              data-live={view.shimmer || undefined}
            >
              <div className="flex min-w-0 items-baseline justify-between gap-3">
                <h3 className="min-w-0 text-[15px] leading-snug font-medium text-foreground [overflow-wrap:anywhere]">{item.title}</h3>
                {view.chip ? <span className={cn("outcome-badge shrink-0", `tone-${view.chip.tone}`)}>{view.chip.label}</span> : null}
              </div>
              {item.steps ? (
                <div
                  className="h-1 overflow-hidden rounded-full bg-white/10"
                  role="progressbar"
                  aria-label={item.steps.current ?? "Steps"}
                  aria-valuemin={0}
                  aria-valuemax={item.steps.total}
                  aria-valuenow={item.steps.done}
                >
                  <div className="h-full rounded-full" style={{ width: `${Math.round((item.steps.done / item.steps.total) * 100)}%`, background: "var(--tone)" }} />
                </div>
              ) : null}
              {view.line ? <p className="line-clamp-2 text-[13px] leading-5 text-muted-foreground">{view.line}</p> : null}
              {origin ? <p className="truncate text-xs text-muted-foreground">{origin}</p> : null}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

const BAR_HEIGHT = 52

/** Flat and quiet: each hour is a thin stacked bar of meaning colors on a faint track, no glow. */
export function ActivityStrip({ activity }: { activity: TodayActivity }) {
  const [risen, setRisen] = React.useState(false)
  React.useEffect(() => {
    const frame = window.requestAnimationFrame(() => setRisen(true))
    return () => window.cancelAnimationFrame(frame)
  }, [])
  const total = activity.totals.reduce((sum, value) => sum + value, 0)
  const pct = (hour: number) => `${((hour + 0.5) / 24) * 100}%`
  const legendSpoken = activity.legend.map((entry) => entry.text).join(", ")
  return (
    <div className="space-y-2.5">
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
            return (
              <div key={hour} className="flex min-w-0 flex-1 flex-col items-center gap-1" data-hour={hour}>
                <div className="relative w-full" style={{ height: BAR_HEIGHT }}>
                  <span
                    className="absolute inset-0 rounded-full bg-white"
                    style={{ opacity: hour > activity.currentHour ? 0.03 : 0.06 }}
                  />
                  {count > 0 ? (
                    <span
                      className="strip-bar absolute inset-x-0 bottom-0 flex flex-col-reverse overflow-hidden rounded-full"
                      style={{ height: risen ? height : 3, transitionDelay: `${hour * 20}ms` }}
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
      {activity.legend.length ? (
        <ul aria-label="What the colors mean" className="micro flex flex-wrap items-center gap-x-3.5 gap-y-1 normal-case tracking-normal">
          {activity.legend.map((entry) => (
            <li key={entry.signal} className="inline-flex items-center gap-1.5" data-signal={entry.signal}>
              <span aria-hidden="true" className="size-1.5 rounded-full" style={{ background: SIGNAL_CSS[entry.signal] }} />
              {entry.text}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function glyph(card: ActivityCard, signal: Signal) {
  const color = SIGNAL_CSS[signal]
  switch (card.outcome.kind) {
    case "done":
      return { Icon: Check, color }
    case "stopped":
      return { Icon: Minus, color, bang: true }
    case "expired":
    case "ended":
    case "replaced":
    case "unanswered":
      return { Icon: Minus, color }
    case "answered":
      return { Icon: signal === "done" ? Check : Minus, color }
    default:
      return { Icon: MessageSquareText, color }
  }
}

export function TodayLog({
  rows,
  onOpen,
}: {
  rows: ActivityCard[]
  onOpen: (id: string) => void
}) {
  return (
    <ul aria-label="Today's log" className="space-y-1.5">
      {rows.map((card) => {
        const signal = signalOf(card)
        const { Icon, color, bang } = glyph(card, signal)
        return (
          <li key={card.id}>
            <button
              type="button"
              onClick={() => onOpen(card.id)}
              aria-label={openLabel(card)}
              className="flex min-h-[52px] w-full items-center gap-3 rounded-[14px] bg-white/[0.04] px-3 py-2.5 text-left transition-colors hover:bg-white/[0.07]"
            >
              <span
                aria-hidden="true"
                className="grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-bold"
                style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}
              >
                {bang ? "!" : <Icon className="size-3.5" />}
              </span>
              <span className="min-w-0 flex-1">
                {card.encrypted ? (
                  <EncryptedText className="max-w-full text-sm font-medium text-muted-foreground" />
                ) : (
                  <span className="block truncate text-sm font-medium text-foreground">{card.title}</span>
                )}
                <span className="micro block truncate text-[10px] tracking-[0.06em]">{logDetail(card)}</span>
              </span>
              <time className="micro shrink-0 normal-case" dateTime={card.at ?? undefined}>{timeOfDay(card.at)}</time>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function StandingBy() {
  return (
    <div className="flex flex-col items-center gap-2.5 py-4 text-center">
      <p className="micro" style={{ letterSpacing: "0.24em" }}>Standing by</p>
      <p className="mx-auto max-w-xs text-[13px] text-muted-foreground">
        When an agent starts work or sends a message, it shows up here, live.
      </p>
    </div>
  )
}

/** A quiet text link, not a button. */
function HistoryLink() {
  return (
    <a
      href="/dashboard/inbox/notifications"
      className="micro flex min-h-11 items-center justify-center gap-1.5 border-t border-white/[0.08] font-semibold tracking-[0.14em] hover:text-foreground"
    >
      View history <ArrowRight className="size-3.5" aria-hidden="true" />
    </a>
  )
}

/**
 * TODAY: the 24h strip with its key, and today's log. Shown whenever today has items, whatever else
 * is on screen; with nothing today and nothing live, a calm "standing by".
 */
export function NowAllClear({
  activity,
  allClear,
  onOpen,
}: {
  activity: TodayActivity
  /** Nothing needs you and nothing is live: an empty day then shows the standing-by note. */
  allClear: boolean
  onOpen: (id: string) => void
}) {
  if (activity.rows.length === 0) {
    return allClear ? (
      <div className="space-y-6" data-now-all-clear>
        <StandingBy />
        <HistoryLink />
      </div>
    ) : null
  }
  return (
    <NowSection title="Today" count={activity.rows.length}>
      <div className="space-y-3.5" data-now-all-clear>
        <ActivityStrip activity={activity} />
        <TodayLog rows={activity.rows.slice(0, 5)} onOpen={onOpen} />
        <HistoryLink />
      </div>
    </NowSection>
  )
}
