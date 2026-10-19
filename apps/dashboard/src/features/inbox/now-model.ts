import {
  absenceText,
  SEALED_CARD_PLACEHOLDERS,
  type ComputerIcon,
  nowSummarySchema,
  type NowItem,
  type NowSummary,
  type SessionRow,
  type SinceYouLooked,
} from "@relo/notification-contracts"

import { hashSlot } from "@/features/inbox/activity-model"
import { displayNameOrNull } from "@/lib/encrypted"
import { projectColor } from "@/lib/project-palette"
import { stepsCaption, workOutcome, type WorkOutcome, type WorkTone } from "@/lib/work-outcome"

/**
 * Now, as the server derived it. Every string the Dashboard shows on Now comes from here, and each
 * one matches the iPhone's NowScreenModel (plan 1.14). Nothing here decides a state, section, fold
 * or visibility from a clock: the only time inputs are instants the server sent, formatted.
 */

export type { NowItem, NowSummary, SessionRow }

/** The server's `now` on the overview, when present and valid. */
export function overviewNow(overview: unknown): NowSummary | null {
  if (!overview || typeof overview !== "object" || !("now" in overview)) return null
  const parsed = nowSummarySchema.safeParse((overview as { now: unknown }).now)
  return parsed.success ? parsed.data : null
}

const HISTORY_WINDOW_MS = 8 * 60 * 60_000

function clock(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.valueOf())) return ""
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date)
}

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** "3 finished", "1 failed", "2 waiting on you", "1 stopped without finishing"; zero parts omitted. */
export function sinceParts(since: SinceYouLooked): string[] {
  return [
    since.finished ? `${since.finished} finished` : null,
    since.failed ? `${since.failed} failed` : null,
    since.waitingOnYou ? `${since.waitingOnYou} waiting on you` : null,
    since.stoppedWithoutFinishing ? `${since.stoppedWithoutFinishing} stopped without finishing` : null,
  ].filter((part): part is string => part !== null)
}

/** The prefix: "Since 18:40", "Since yesterday 18:40", or "In the last 8 hours" for the server default. */
function sincePrefix(since: string, serverTime: string): string {
  const at = new Date(since)
  const server = new Date(serverTime)
  if (Math.abs(server.valueOf() - HISTORY_WINDOW_MS - at.valueOf()) < 60_000) return "In the last 8 hours"
  const yesterday = new Date(server)
  yesterday.setDate(server.getDate() - 1)
  if (sameDay(at, server)) return `Since ${clock(since)}`
  if (sameDay(at, yesterday)) return `Since yesterday ${clock(since)}`
  return `Since ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(at)} ${clock(since)}`
}

/** The Now top line, and whether it is the muted "nothing new" variant. */
export function sinceLine(summary: Pick<NowSummary, "sinceYouLooked" | "serverTime">): { text: string; muted: boolean } {
  const parts = sinceParts(summary.sinceYouLooked)
  const prefix = sincePrefix(summary.sinceYouLooked.since, summary.serverTime)
  if (parts.length === 0) {
    const text = prefix === "In the last 8 hours" ? "Nothing new in the last 8 hours." : `Nothing new ${prefix.charAt(0).toLowerCase()}${prefix.slice(1)}.`
    return { text, muted: true }
  }
  return { text: `${prefix}: ${parts.join(", ")}`, muted: false }
}

/** A sealed card's placeholder title (the server's SEALED_CARD_PLACEHOLDERS, or a sealed question's). */
const SEALED_TITLES = new Set<string>([SEALED_CARD_PLACEHOLDERS.title, "Encrypted question"])
const SEALED_STATUSES = new Set<string>([SEALED_CARD_PLACEHOLDERS.status, "Open Relo on your iPhone to read this question."])

/** True for a card whose text is sealed end to end: the Dashboard holds no key, so it shows a lock instead. */
export function isSealedItem(item: Pick<NowItem, "title">): boolean {
  return SEALED_TITLES.has(item.title.trim())
}

/**
 * One Now card, ready for `WorkCard`: words, tone and meter from the server's owner state (named by
 * lib/work-outcome.ts), facts as the iPhone's NowScreenModel writes them. Instants that tick
 * ("updated 3 min ago") come back through `relative`, so a leaf can keep them current.
 */
export type NowCardView = {
  id: string
  title: string
  /** Sealed end to end: the title is a placeholder and the summary is dropped. */
  encrypted: boolean
  summary: string | null
  tone: WorkTone
  state: WorkOutcome | null
  /** A needs-you card's mono chip ("QUESTION", "PERMISSION"); nothing else has one. */
  chip: string | null
  /** A needs-you card's footnote under its summary (what a late answer means). */
  note: string | null
  facts: string[]
  /** The progress row's step caption ("Step 3 of 5 · Run local gates"); not a footer fact. */
  caption: string | null
  /** Moving work: a live "running 12:40" from the server's start instant. */
  runningSince: string | null
  /** Otherwise the clock time that matters for the state (since your turn, finished, last seen). */
  at: string | null
  meter: { steps: (NonNullable<NowItem["steps"]> & { currentIndex?: number | null; fill?: number | null }) | null; live: boolean; finished: boolean } | null
  /** The steps sweep and the live hairline: moving work only. */
  live: boolean
  /** Where it runs: the computer of the session that holds it (closes the standing line, as on iOS). */
  computer: string | null
  /** That computer's icon, when the server sent one. */
  computerIcon: ComputerIcon | null
  origin: { source: string | null; project: string | null; projectColor: string | null; topic?: string | null }
}

function evidence(item: NowItem) {
  return item.owner.evidenceAt ?? item.declaredAt
}

/** Card copy by owner state (spec 6.2; iOS NowScreenModel rows). Quiet cards never say "Running". */
export function nowCardView(item: NowItem, relative: (iso: string) => string, topic: string | null = null, computer: string | null = null): NowCardView {
  const encrypted = isSealedItem(item)
  const status = encrypted || !item.status || SEALED_STATUSES.has(item.status.trim()) ? null : item.status
  const state = workOutcome({ state: item.owner.state, needsYou: item.owner.needsYou })
  const project = displayNameOrNull(item.project)
  // The plan's count is the server's `progress` (top-level steps, the current one and its fraction); the older
  // `steps` (whole-plan window) only when a server sends no `progress`. Nothing is counted here.
  const plan = item.progress && item.progress.total > 0 ? item.progress : null
  const steps = plan
    ? { done: plan.done, total: plan.total, current: encrypted ? null : (item.steps?.current ?? plan.stepLabel ?? null), currentIndex: plan.current, fill: plan.fill }
    : item.steps && item.steps.total > 0 ? { ...item.steps, current: encrypted ? null : item.steps.current } : null
  const finished = item.owner.state === "done"
  const view: NowCardView = {
    id: item.id,
    title: item.title,
    encrypted,
    summary: status,
    tone: state?.tone ?? "neutral",
    state,
    chip: null,
    note: null,
    facts: [],
    caption: stepsCaption(steps, { finished }),
    runningSince: null,
    at: evidence(item),
    meter: steps ? { steps, live: false, finished } : null,
    live: false,
    computer,
    computerIcon: item.computerIcon ?? null,
    origin: {
      source: displayNameOrNull(item.sourceName),
      project,
      projectColor: project ? projectColor(hashSlot(project)) : null,
      // The session's own name, unless the card is titled the same.
      topic: topic && topic !== item.title ? topic : null,
    },
  }
  switch (item.owner.state) {
    case "needs_you": {
      const reason = item.owner.needsYou
      view.at = item.question?.askedAt ?? item.declaredAt
      if (reason === "permission") {
        view.chip = "PERMISSION"
        // The hint rides the footer's metadata: where to answer it.
        view.facts.push("Answer it on your computer")
      } else {
        view.chip = "QUESTION"
      }
      // The chip names the state; the standing line keeps the facts.
      view.state = null
      break
    }
    case "moving":
      view.live = true
      view.runningSince = item.startedAt
      view.at = null
      if (view.meter) view.meter.live = true
      break
    case "working_quietly":
      view.facts.push(`updated ${relative(evidence(item))}`)
      view.at = null
      break
    case "stale":
      view.facts.push(`updated ${relative(evidence(item))}`)
      view.at = null
      break
    case "stopped_responding":
      view.facts = [`at ${steps?.current ?? status ?? "its last step"}`, `last seen ${clock(evidence(item))}`]
      view.at = null
      break
    case "no_signal":
      view.facts.push(`since ${clock(evidence(item))}`)
      view.at = null
      break
    case "left_unfinished":
      view.facts.push(`last update ${clock(evidence(item))}`)
      view.at = null
      break
    default:
      break
  }
  // Why it dimmed or left, in the server's reason (one line, first among the facts).
  if (item.owner.absence) view.facts.unshift(absenceText(item.owner.absence, { computer }))
  return view
}

export type NowFold = "quiet" | "paused"

export const FOLD_LABEL: Record<NowFold, string> = {
  quiet: "Quiet",
  paused: "Paused",
}

export type NowBlock =
  | { kind: "sinceYouLooked"; text: string; muted: boolean; recent: NowItem[]; more: NowItem[] }
  | { kind: "needsYou"; items: NowItem[] }
  | { kind: "waitingOnYou"; items: NowItem[] }
  | { kind: "fold"; fold: NowFold; count: number; items: NowItem[] }
  | { kind: "running"; title: "Running" | "Last known"; items: NowItem[] }
  | { kind: "sessions"; sessions: NowSummary["sessions"] }
  | { kind: "allClear"; text: string }

/**
 * The fixed block order: Needs you, Waiting on you, Running, Since you looked (finished work never
 * sits above running work), Quiet, Paused, Sessions. Waiting on you is an open section (the owner's turn is shown, never folded); Quiet and
 * Paused fold. A block with nothing to show is omitted; All clear when nothing is open.
 */
export function nowBlocks(summary: NowSummary, options: { offline?: boolean } = {}): NowBlock[] {
  const since = sinceLine(summary)
  const blocks: NowBlock[] = []
  if (summary.needsYou.length) blocks.push({ kind: "needsYou", items: summary.needsYou })
  if (summary.waitingOnYou.length) blocks.push({ kind: "waitingOnYou", items: summary.waitingOnYou })
  if (summary.running.length) blocks.push({ kind: "running", title: options.offline ? "Last known" : "Running", items: summary.running })
  blocks.push({ kind: "sinceYouLooked", text: since.text, muted: since.muted, recent: summary.recent.slice(0, 3), more: summary.recent.slice(3) })
  if (summary.folds.quiet) blocks.push({ kind: "fold", fold: "quiet", count: summary.folds.quiet, items: summary.quiet })
  if (summary.folds.paused) blocks.push({ kind: "fold", fold: "paused", count: summary.folds.paused, items: summary.paused })
  if (summary.sessions.sessions.length) blocks.push({ kind: "sessions", sessions: summary.sessions })
  const open = summary.needsYou.length + summary.waitingOnYou.length + summary.running.length + summary.folds.quiet + summary.folds.paused
  if (open === 0) blocks.push({ kind: "allClear", text: "Standing by" })
  return blocks
}

/**
 * A linked browser opens every card sealed for it, so what it still cannot open was sealed before the
 * link: unreadable here, it is not shown (the iPhone reads it). Display only: an item that needs the
 * owner stays, and the counts drop exactly the items left out. Nothing left out: the same summary.
 */
export function withoutUnreadable(summary: NowSummary): NowSummary {
  const readable = (list: NowItem[]) => list.filter((item) => !isSealedItem(item))
  const recent = readable(summary.recent)
  const waitingOnYou = readable(summary.waitingOnYou)
  const running = readable(summary.running)
  const quiet = readable(summary.quiet)
  const paused = readable(summary.paused)
  const dropped = summary.recent.length - recent.length + summary.waitingOnYou.length - waitingOnYou.length
    + summary.running.length - running.length + summary.quiet.length - quiet.length + summary.paused.length - paused.length
  if (dropped === 0) return summary
  const left = (state: NowItem["owner"]["state"]) =>
    summary.recent.filter((item) => item.owner.state === state).length - recent.filter((item) => item.owner.state === state).length
  const since = summary.sinceYouLooked
  return {
    ...summary,
    sinceYouLooked: {
      ...since,
      finished: since.finished - left("done"),
      failed: since.failed - left("failed"),
      stoppedWithoutFinishing: since.stoppedWithoutFinishing - left("left_unfinished"),
      waitingOnYou: waitingOnYou.length,
    },
    recent,
    waitingOnYou,
    running,
    quiet,
    paused,
    folds: {
      ...summary.folds,
      waitingOnYou: waitingOnYou.length,
      quiet: summary.folds.quiet - (summary.quiet.length - quiet.length),
      paused: summary.folds.paused - (summary.paused.length - paused.length),
    },
  }
}

/** The deck's readouts, all from the server's summary: SESSIONS · WAITING · RUNNING · NEEDS YOU. */
export function nowCounts(summary: NowSummary) {
  return {
    needsYou: summary.needsYou.length,
    running: summary.running.length,
    sessionsWorking: summary.sessions.sessions.filter((row) => row.phase === "working").length,
    waitingOnYou: summary.waitingOnYou.length,
  }
}
