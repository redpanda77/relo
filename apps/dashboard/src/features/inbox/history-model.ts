import {
  answerPillText,
  historyCounts,
  historyCountsLine,
  historyEndingLabel,
  quietGap,
  spanLabel,
  type HistoryCount,
  type HistoryEnding,
} from "@relo/notification-contracts"

import { cardFor, signalOf, type ActivityCard } from "@/features/inbox/activity-model"
import type { NotificationHistory, NotificationSummary } from "@/features/inbox/types"

/**
 * History as the iPhone draws it (HistoryView, HistoryRowView): a timeline of what is over, a day at a
 * time, each row a time, a dot that says how it went and what it was. The server sends settled rows only,
 * each round once, with its meaning; this module turns them into what the page shows.
 */

/** The dot's glyph: a symbol as well as a colour, so meaning never rides on colour alone. */
export type HistoryGlyph = "check" | "alert" | "clock" | "stop" | "replaced" | "message" | "question"

export type HistoryRowModel = {
  card: ActivityCard
  signal: HistoryEnding
  glyph: HistoryGlyph
  /** The state word above the headline (DONE, STOPPED…), or the row's type when a message has none. */
  label: string
  /** "Relo · Question", "Relo · Fix the login": where it came from, then what it was. */
  context: string | null
  /** What became of a question: "You approved", "Ship it?: You said yes"; null when it would repeat the label. */
  pill: { text: string; tone: "done" | "attention" | "quiet" | "needsYou" } | null
  /** Why it left (the server's words), the computer, and how long it ran. */
  facts: string[]
  /** Only an unread message reads bolder: a dot on most rows read as "needs you". */
  unreadMessage: boolean
  at: number
}

function glyphOf(card: ActivityCard, isQuestion: boolean): HistoryGlyph {
  if (isQuestion) return "question"
  switch (card.outcome.kind) {
    case "done":
      return "check"
    case "stopped":
      return "alert"
    case "expired":
    case "unanswered":
      return "clock"
    case "ended":
      return "stop"
    case "replaced":
      return "replaced"
    case "answered":
      return "question"
    default:
      return "message"
  }
}

function pillOf(notification: NotificationSummary, card: ActivityCard, label: string): HistoryRowModel["pill"] {
  const question = notification.question
  let pill: HistoryRowModel["pill"] = null
  if (notification.kind !== "live_activity" && question) {
    const text = answerPillText(question.state, question.chosenLabel)
    const tone = card.outcome.kind === "answered"
      ? card.outcome.tone === "yellow" ? "attention" : "done"
      : "quiet"
    pill = { text, tone }
  } else if (card.decision) {
    const tone = card.decision.pending ? "needsYou" : card.decision.declined ? "attention" : "done"
    pill = { text: `${card.decision.answer}: ${card.decision.prompt}`, tone }
  }
  // A pill that would only repeat the state above it (Withdrawn under WITHDRAWN) is left out.
  return pill && pill.text.toLowerCase() !== label.toLowerCase() ? pill : null
}

export function historyRow(notification: NotificationSummary, now: number): HistoryRowModel {
  const card = cardFor(notification, now)
  const isQuestion = notification.kind !== "live_activity" && notification.question != null
  const signal = notification.historySignal ?? (signalOf(card) as HistoryEnding)
  const label = card.outcome.label ?? card.type
  const place = card.project?.name ?? card.source
  const what = isQuestion ? card.type : card.topic
  const span = card.duration != null ? spanLabel(card.duration) : null
  const at = card.at ? new Date(card.at).valueOf() : Number.NaN
  return {
    card,
    signal,
    glyph: glyphOf(card, isQuestion),
    label,
    context: [place, what].filter(Boolean).join(" · ") || null,
    pill: pillOf(notification, card, label),
    facts: [card.absenceLine, card.origin, span].filter((part): part is string => Boolean(part)),
    unreadMessage: card.unread && card.outcome.kind === "message",
    at,
  }
}

function dayStart(at: number): number {
  const date = new Date(at)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).valueOf()
}

export type HistoryDay = {
  /** Local midnight of the day; NaN for rows without a time. */
  start: number
  isToday: boolean
  /** "Yesterday", "Wednesday", "12 Oct"; the iPhone's band title. */
  title: string
  /** "Mon 12 Oct", beside the title. */
  date: string | null
  /** "3 done · 1 stopped". */
  counts: string
  rows: Array<HistoryRowModel & { gapAfter: string | null; dayHalf: string | null }>
}

const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" })
const shortDate = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" })
const dayMonth = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" })

/** The band's title: Yesterday, the weekday within the week, else the date. */
export function dayTitle(start: number, now: number): string {
  const today = dayStart(now)
  const days = Math.round((today - start) / 86_400_000)
  if (days === 0) return "Today"
  if (days === 1) return "Yesterday"
  if (days > 1 && days < 7) return weekday.format(start)
  return dayMonth.format(start)
}

/** AM or PM, only where the locale reads a 12-hour clock (HistoryClock.dayHalf). */
export function dayHalf(at: number): string | null {
  if (!Number.isFinite(at)) return null
  const part = new Intl.DateTimeFormat(undefined, { hour: "numeric" }).formatToParts(at).find((p) => p.type === "dayPeriod")
  return part ? part.value : null
}

/** "9:41" without its AM or PM: the half is its own line under the time. */
export function clockTime(at: number): string {
  if (!Number.isFinite(at)) return ""
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
    .formatToParts(at)
    .filter((part) => part.type !== "dayPeriod")
    .map((part) => part.value)
    .join("")
    .trim()
}

/** Rows split by local day, newest first, each with the quiet gap under it and where AM/PM shows. */
export function historyDays(rows: HistoryRowModel[], now: number): HistoryDay[] {
  const days: HistoryDay[] = []
  for (const row of rows) {
    const start = Number.isFinite(row.at) ? dayStart(row.at) : Number.NaN
    const last = days.at(-1)
    const same = last && (last.start === start || (Number.isNaN(last.start) && Number.isNaN(start)))
    const day: HistoryDay = same
      ? last
      : {
          start,
          isToday: start === dayStart(now),
          title: Number.isNaN(start) ? "Earlier" : dayTitle(start, now),
          date: Number.isNaN(start) ? null : shortDate.format(start),
          counts: "",
          rows: [],
        }
    if (!same) days.push(day)
    const newer = day.rows.at(-1)
    if (newer) newer.gapAfter = Number.isFinite(newer.at) && Number.isFinite(row.at) ? quietGap(newer.at, row.at) : null
    const half = dayHalf(row.at)
    day.rows.push({ ...row, gapAfter: null, dayHalf: !newer || dayHalf(newer.at) !== half ? half : null })
  }
  for (const day of days) day.counts = historyCountsLine(historyCounts(day.rows.map((row) => row.signal)))
  return days
}

export type TodayPanel = {
  total: number
  counts: HistoryCount[]
  /** 24 hours, each counted by meaning. */
  hours: Array<Partial<Record<HistoryEnding, number>>>
  maxTotal: number
  currentHour: number
}

/** Today's panel from the server's recent rows: the browser's own calendar day, across every page. */
export function todayPanel(recent: NotificationHistory["recent"], now: number): TodayPanel {
  const today = dayStart(now)
  const hours = Array.from({ length: 24 }, (): Partial<Record<HistoryEnding, number>> => ({}))
  const signals: HistoryEnding[] = []
  for (const row of recent) {
    const at = new Date(row.at).valueOf()
    if (!Number.isFinite(at) || dayStart(at) !== today) continue
    const hour = hours[new Date(at).getHours()]!
    hour[row.signal] = (hour[row.signal] ?? 0) + 1
    signals.push(row.signal)
  }
  const totals = hours.map((hour) => Object.values(hour).reduce((sum, count) => sum + (count ?? 0), 0))
  return {
    total: signals.length,
    counts: historyCounts(signals),
    hours,
    maxTotal: Math.max(0, ...totals),
    currentHour: new Date(now).getHours(),
  }
}

/** The chart's four hour marks: 12a 6a 12p 6p, or 00 06 12 18 on a 24-hour clock. */
export function hourAxis(): string[] {
  return dayHalf(new Date(2000, 0, 1, 9).valueOf()) ? ["12a", "6a", "12p", "6p"] : ["00", "06", "12", "18"]
}

export { historyEndingLabel }
