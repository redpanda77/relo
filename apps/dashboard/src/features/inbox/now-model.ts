import {
  nowSummarySchema,
  type NowItem,
  type NowSummary,
  type SessionRow,
  type SinceYouLooked,
} from "@relo/notification-contracts"

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
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date)
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

export type NowTone = "cyan" | "yellow" | "orange" | "red" | "mint" | "neutral"

/** One row of a Now list. */
export type NowRowView = {
  id: string
  title: string
  chip: { label: string; tone: NowTone } | null
  /** The status line under the title. */
  line: string | null
  /** A dimmed row ("working quietly"). */
  dim: boolean
  /** The steps or progress shimmer: moving work only. */
  shimmer: boolean
}

function lastSeen(item: NowItem) {
  return clock(item.owner.evidenceAt ?? item.declaredAt)
}

/** Row copy by owner state (spec 6.2). Quiet rows never say "Running". */
export function nowRowView(item: NowItem, relative: (iso: string) => string): NowRowView {
  const base = { id: item.id, title: item.title, dim: false, shimmer: false }
  const status = item.status
  switch (item.owner.state) {
    case "needs_you": {
      const reason = item.owner.needsYou
      if (reason === "missed_question") {
        return { ...base, chip: { label: `MISSED ${clock(item.question?.askedAt ?? item.declaredAt)}`, tone: "orange" },
          line: "Late answers reach the session marked late. An approval here is not permission: the session must ask again." }
      }
      if (reason === "permission") {
        return { ...base, chip: { label: "PERMISSION", tone: "orange" },
          line: `${item.sourceName ?? "The session"} is waiting for a permission prompt. Answer it on your computer.` }
      }
      return { ...base, chip: { label: "QUESTION", tone: "orange" }, line: status }
    }
    case "failed":
      return { ...base, chip: { label: "FAILED", tone: "red" }, line: status }
    case "done":
      return { ...base, chip: { label: "DONE", tone: "mint" }, line: status }
    case "left_unfinished":
      return { ...base, chip: { label: "STOPPED WITHOUT FINISHING", tone: "neutral" }, line: `last update ${lastSeen(item)}` }
    case "dropped":
      return { ...base, chip: { label: "DROPPED", tone: "neutral" }, line: status }
    case "waiting_on_you":
      return { ...base, chip: null, line: `Your turn · since ${lastSeen(item)}` }
    case "moving":
      return { ...base, chip: null, shimmer: true, line: status ? `${status} · ${relative(item.declaredAt)}` : `updated ${relative(item.declaredAt)}` }
    case "working_quietly":
      return { ...base, chip: null, dim: true, line: `Working quietly · updated ${relative(item.declaredAt)}` }
    case "stale":
      return { ...base, chip: null, line: `Quiet · updated ${relative(item.declaredAt)}` }
    case "stopped_responding":
      return { ...base, chip: null, line: `Stopped responding at ${item.steps?.current ?? status ?? "its last step"}, last seen ${lastSeen(item)}` }
    case "no_signal":
      return { ...base, chip: null, line: `No signal since ${lastSeen(item)}` }
    case "paused":
      return { ...base, chip: null, line: `Paused${status ? ` · ${status}` : ""}` }
    default:
      return { ...base, chip: null, line: status }
  }
}

export type NowFold = "waitingOnYou" | "quiet" | "paused"

export const FOLD_LABEL: Record<NowFold, string> = {
  waitingOnYou: "Waiting on you",
  quiet: "Quiet",
  paused: "Paused",
}

export type NowBlock =
  | { kind: "sinceYouLooked"; text: string; muted: boolean; recent: NowItem[]; more: NowItem[] }
  | { kind: "needsYou"; items: NowItem[] }
  | { kind: "fold"; fold: NowFold; count: number; items: NowItem[] }
  | { kind: "running"; title: "Running" | "Last known"; items: NowItem[] }
  | { kind: "sessions"; sessions: NowSummary["sessions"] }
  | { kind: "allClear"; text: string }

/**
 * The fixed block order: Since you looked, Needs you, Waiting on you, Running, Quiet, Paused,
 * Sessions. A block with nothing to show is omitted; All clear when nothing is open.
 */
export function nowBlocks(summary: NowSummary, options: { offline?: boolean } = {}): NowBlock[] {
  const since = sinceLine(summary)
  const blocks: NowBlock[] = [
    { kind: "sinceYouLooked", text: since.text, muted: since.muted, recent: summary.recent.slice(0, 3), more: summary.recent.slice(3) },
  ]
  if (summary.needsYou.length) blocks.push({ kind: "needsYou", items: summary.needsYou })
  if (summary.folds.waitingOnYou) blocks.push({ kind: "fold", fold: "waitingOnYou", count: summary.folds.waitingOnYou, items: summary.waitingOnYou })
  if (summary.running.length) blocks.push({ kind: "running", title: options.offline ? "Last known" : "Running", items: summary.running })
  if (summary.folds.quiet) blocks.push({ kind: "fold", fold: "quiet", count: summary.folds.quiet, items: summary.quiet })
  if (summary.folds.paused) blocks.push({ kind: "fold", fold: "paused", count: summary.folds.paused, items: summary.paused })
  if (summary.sessions.sessions.length) blocks.push({ kind: "sessions", sessions: summary.sessions })
  const open = summary.needsYou.length + summary.folds.waitingOnYou + summary.running.length + summary.folds.quiet + summary.folds.paused
  if (open === 0) blocks.push({ kind: "allClear", text: "Standing by" })
  return blocks
}

/** HUD counts from the server's summary. */
export function nowCounts(summary: NowSummary) {
  return {
    needsYou: summary.needsYou.length,
    running: summary.running.length,
    sessionsWorking: summary.sessions.sessions.filter((row) => row.phase === "working").length,
    waitingOnYou: summary.folds.waitingOnYou,
    done: summary.sinceYouLooked.finished,
  }
}
