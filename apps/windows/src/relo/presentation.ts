// What the notch shows, read straight from the server's Now summary (`GET /api/now`, `nowSummarySchema` in
// packages/contracts/src/owner-state.ts). Ports apps/notch/ReloNotchKit/Sources/ReloNotchKit/NotchPresentation.swift.
// It decides nothing: which work leads, what needs the owner and what is visible all come from the server's
// derivation (`owner`, `lockScreen`, the Now sections). It only shapes rows for a small surface.

import type { NowItem, NowSummary, SessionPhase, SessionRow, SinceYouLooked } from "@relo/notification-contracts"
import type { Detail as SpokenDetail } from "../voice/spokenLine"
import { isDelivered, makeOutline, planBar, planLine, type BarSegment, type PlanOutline, type Standing } from "./plan"

export type Tone = "needsYou" | "yourTurn" | "working" | "quiet" | "done" | "failed" | "paused" | "dropped" | "leftUnfinished"

/** Work in motion: it shows its plan and a timer. */
export const isMoving = (tone: Tone): boolean => tone === "working"
/** Over without success: it counts as a failure for events and the closing sign. */
export const isStopped = (tone: Tone): boolean => tone === "failed" || tone === "dropped" || tone === "leftUnfinished"

/** The sealed words a card carries for the ear (ADR 0015): its gist (`spoken`), how it is called aloud (`name`), the producer's voice level (`voice`). */
export interface SpokenWords {
  spoken: string | null
  name: string | null
  voice: SpokenDetail | null
}

/** Spoken words by card (work) id: what the owner client opened from each card's sealed text. */
export type SpokenWordsById = Readonly<Record<string, SpokenWords>>

export interface Row {
  id: string
  title: string
  status: string | null
  project: string | null
  source: string | null
  tone: Tone
  stepsDone: number | null
  stepsTotal: number | null
  currentStep: string | null
  /** Epoch milliseconds. */
  startedAt: number
  questionId: string | null
  notificationId: string | null
  /** The question is still open for an answer (not missed or answered). */
  questionPending: boolean
  /** The card's text is sealed and this device could not open it. */
  unreadable: boolean
  /** The question's deadline passed unanswered (MISSED): it can be dismissed, not answered. */
  questionMissed: boolean
  /** The computer the work runs on (ADR 0011); null when the server names none. */
  computerIcon: string | null
  declaredAt: number
  /** What the last round delivered, when the work waits on the owner after a round (ADR 0012). */
  roundOutcome: string | null
  /** The plan as rounds and nested steps; null without a plan. */
  outline: PlanOutline | null
  /** Which top-level step is current (from 1) and how far its own steps are (0 to 1), from the server's plan. */
  currentIndex: number | null
  currentFill: number | null
  /** The card's sealed gist, said after "<Kind>: <name>." (see `withSpoken` in client/view.ts; absent when the card has none). */
  spoken?: string | null
  /** How the work is called aloud (`relo work --spoken-name`). */
  spokenName?: string | null
  /** The producer's voice level for this card (`relo voice`): the owner's detail never goes above it. */
  spokenVoice?: SpokenDetail | null
}

/** The plan bar, one segment per top-level step; null without steps. */
export function rowBar(row: Row): BarSegment[] | null {
  if (row.stepsTotal === null || row.stepsTotal <= 0) return null
  return planBar(row.stepsDone ?? 0, row.stepsTotal, row.currentIndex, row.currentFill)
}

/** 0...1 when the plan has steps; null otherwise. */
export function rowProgress(row: Row): number | null {
  if (row.stepsDone === null || row.stepsTotal === null || row.stepsTotal <= 0) return null
  return Math.min(1, Math.max(0, row.stepsDone / row.stepsTotal))
}

/** The one plan line (rule U2): "2 of 5 · <step>", "Paused at 2 of 5", "5 of 5 done", "Stopped at 3 of 5". */
export function rowPlanLine(row: Row): string | null {
  if (row.stepsDone === null || row.stepsTotal === null || row.stepsTotal <= 0) return null
  let standing: Standing
  switch (row.tone) {
    case "done":
      standing = "done"
      break
    case "failed":
    case "dropped":
    case "leftUnfinished":
      standing = "stopped"
      break
    case "paused":
      standing = "paused"
      break
    default:
      standing = row.stepsDone >= row.stepsTotal ? "done" : "moving"
  }
  return planLine(row.stepsDone, row.stepsTotal, row.currentStep, standing)
}

export type SectionKind = "needsYou" | "waitingOnYou" | "running" | "recent" | "quiet" | "paused"

export interface Section {
  kind: SectionKind
  rows: Row[]
}

export const sectionTitle = (kind: SectionKind): string =>
  ({ needsYou: "Needs you", waitingOnYou: "Your turn", running: "Running", recent: "Just finished", quiet: "Quiet", paused: "Paused" })[kind]

/** Quiet and paused work is folded: shown dimmed, after everything that moves. */
export const isFolded = (kind: SectionKind): boolean => kind === "quiet" || kind === "paused"

export interface Session {
  id: string
  title: string
  source: string | null
  project: string | null
  phase: SessionPhase | null
  waitingFor: string | null
  computer: string | null
  computerIcon: string | null
  lastSeenAt: number
  /** A session already shown by a card (its work) is not listed again. */
  hasCard: boolean
}

export interface Harness {
  source: string
  working: number
  waiting: number
  /** Tracked sessions that are idle (a phase the server observed); never an untracked one. */
  idle: number
  /** Sessions with no observed state (hooks off): unknown is not idle. */
  untracked: number
  total: number
}

export interface Machine {
  name: string
  icon: string | null
  harnesses: Harness[]
  sessions: Session[]
  working: number
  waiting: number
  idle: number
  untracked: number
  /** Dimmed and labelled Idle only when its sessions are tracked and none works or waits. */
  isIdle: boolean
}

export interface Presentation {
  /** The one card the closed notch carries: the server's Lock Screen focus, else its first Lock Screen card. */
  focus: Row | null
  needsYouCount: number
  /** Live work the notch can count beside the focus (needs you, your turn, running). */
  activeCount: number
  sections: Section[]
  /** Some sealed text could not be opened: this device waits for approval on the iPhone. */
  hasUnreadable: boolean
  /** "2 finished · 1 failed" since the owner last looked; null when nothing happened. */
  sinceYouLooked: string | null
  /** Finished or quiet cards sealed before this device could read them: one line, not a list of "Private work". */
  privateEarlier: number
  /** The server's Sessions view without folded idle rows: agent conversations working or waiting. */
  sessions: Session[]
}

export const EMPTY: Presentation = {
  focus: null,
  needsYouCount: 0,
  activeCount: 0,
  sections: [],
  hasUnreadable: false,
  sinceYouLooked: null,
  privateEarlier: 0,
  sessions: [],
}

/** Nothing moves or waits: only quiet or paused work, or none. */
export const isQuiet = (p: Presentation): boolean => p.sections.every((s) => isFolded(s.kind))
export const isEmpty = (p: Presentation): boolean => p.sections.length === 0

// MARK: Sealed cards (apps/ios ReloSealedCards)

export const SEALED = {
  titlePlaceholder: "Encrypted card",
  statusPlaceholder: "Updating…",
  questionTitlePlaceholder: "Encrypted question",
  unreadableTitle: "Can't be read on this iPhone",
} as const

const isPlaceholderTitle = (value: string): boolean => value === SEALED.titlePlaceholder || value === SEALED.questionTitlePlaceholder

// MARK: Building

const ms = (iso: string): number => Date.parse(iso)

export function toneOf(state: NowItem["owner"]["state"]): Tone {
  switch (state) {
    case "needs_you":
      return "needsYou"
    case "waiting_on_you":
      return "yourTurn"
    // Waiting on its own job (CI, a build, a benchmark) is moving: Running, with "Waiting on X" as its status.
    case "moving":
    case "working_quietly":
      return "working"
    case "stale":
    case "stopped_responding":
    case "no_signal":
      return "quiet"
    case "done":
      return "done"
    case "failed":
      return "failed"
    case "dropped":
      return "dropped"
    case "left_unfinished":
      return "leftUnfinished"
    case "paused":
      return "paused"
  }
}

export function rowOf(item: NowItem): Row {
  // A sealed card this device could not open: the server's placeholder, or the opener's own "Can't be read" title.
  const openFailed = item.title === SEALED.unreadableTitle
  const unreadable = openFailed || isPlaceholderTitle(item.title)
  const status = item.status && item.status !== SEALED.statusPlaceholder ? (openFailed ? item.status.replaceAll("iPhone", "PC") : item.status) : null
  // `steps` is the older whole-plan window; `progress` is the round in play. Either gives the done and total counts.
  const steps = item.steps ?? (item.progress && item.progress.total > 0 ? { done: item.progress.done, total: item.progress.total, current: item.progress.stepLabel ?? null } : null)
  const closedRound = item.rounds?.at(-1)
  const outline = makeOutline(item.plan, item.rounds)
  return {
    id: item.id,
    title: unreadable ? "Private work" : item.title,
    status: status || null,
    project: item.project,
    source: item.sourceName,
    tone: toneOf(item.owner.state),
    stepsDone: steps?.done ?? null,
    stepsTotal: steps?.total ?? null,
    currentStep: steps?.current ?? null,
    startedAt: ms(item.startedAt),
    questionId: item.question?.id ?? null,
    notificationId: item.notificationId,
    questionPending: item.question?.standing === "pending",
    unreadable,
    questionMissed: item.question?.standing === "missed",
    computerIcon: item.computerIcon ?? null,
    declaredAt: ms(item.declaredAt),
    roundOutcome: outline && isDelivered(outline) ? (closedRound?.outcome ?? null) : null,
    outline,
    currentIndex: item.progress?.current ?? null,
    currentFill: item.progress?.fill ?? null,
  }
}

const allItems = (summary: NowSummary): NowItem[] => [
  ...summary.needsYou,
  ...summary.waitingOnYou,
  ...summary.running,
  ...summary.recent,
  ...summary.quiet,
  ...summary.paused,
]

/** The server's counts since the last look, in the iPhone's order of what matters. */
export function recap(since: SinceYouLooked): string | null {
  const parts = [
    since.needsYou > 0 ? `${since.needsYou} needs you` : null,
    since.failed > 0 ? `${since.failed} failed` : null,
    since.stoppedWithoutFinishing > 0 ? `${since.stoppedWithoutFinishing} stopped` : null,
    since.finished > 0 ? `${since.finished} finished` : null,
    since.waitingOnYou > 0 ? `${since.waitingOnYou} your turn` : null,
  ].filter((part): part is string => part !== null)
  return parts.length === 0 ? null : parts.join(" · ")
}

function sessionOf(row: SessionRow, cardSessions: ReadonlySet<string>): Session {
  return {
    id: row.id,
    title: row.project || row.source || "Session",
    source: row.source,
    project: row.project,
    phase: row.phase,
    waitingFor: row.waitingFor,
    computer: row.computer ? row.computer : null,
    computerIcon: row.computerIcon ?? null,
    lastSeenAt: ms(row.lastSeenAt),
    hasCard: cardSessions.has(row.id) || row.workId !== null,
  }
}

/** The presentation of a Now summary; empty without one. */
export function presentationOf(summary: NowSummary | null | undefined): Presentation {
  if (!summary) return EMPTY
  // Work that is over and unreadable here stays out of the list; live work always shows.
  const past = (items: NowItem[]) => items.map(rowOf).filter((row) => !row.unreadable)
  const hidden = [...summary.recent, ...summary.quiet, ...summary.paused].map(rowOf).filter((row) => row.unreadable).length
  const sections = (
    [
      { kind: "needsYou", rows: summary.needsYou.map(rowOf) },
      { kind: "waitingOnYou", rows: summary.waitingOnYou.map(rowOf) },
      { kind: "running", rows: summary.running.map(rowOf) },
      { kind: "recent", rows: past(summary.recent) },
      { kind: "quiet", rows: past(summary.quiet) },
      { kind: "paused", rows: past(summary.paused) },
    ] satisfies Section[]
  ).filter((section) => section.rows.length > 0)
  const focusId = summary.lockScreen.focus ?? summary.lockScreen.cards[0]
  const focusItem = focusId ? allItems(summary).find((item) => item.id === focusId) : undefined
  const cardSessions = new Set(allItems(summary).flatMap((item) => (item.sessionId ? [item.sessionId] : [])))
  return {
    focus: focusItem ? rowOf(focusItem) : null,
    needsYouCount: Math.max(summary.lockScreen.needsYouCount, summary.needsYou.length),
    activeCount: summary.needsYou.length + summary.waitingOnYou.length + summary.running.length,
    sections,
    hasUnreadable: sections.some((section) => section.rows.some((row) => row.unreadable)),
    sinceYouLooked: recap(summary.sinceYouLooked),
    privateEarlier: hidden,
    sessions: summary.sessions.sessions
      .filter((row) => row.fold !== "idle" && row.phase !== "ended")
      .map((row) => sessionOf(row, cardSessions)),
  }
}

// MARK: Sessions by computer

const phaseRank = (phase: SessionPhase | null): number => (phase === "working" ? 0 : phase === "waiting" ? 1 : 2)

function harnessesIn(rows: Session[]): Harness[] {
  const grouped = new Map<string, Session[]>()
  for (const row of rows) grouped.set(row.source ?? "Agent", [...(grouped.get(row.source ?? "Agent") ?? []), row])
  const built = [...grouped].map(([source, group]): Harness => {
    const working = group.filter((s) => s.phase === "working").length
    const waiting = group.filter((s) => s.phase === "waiting").length
    const untracked = group.filter((s) => s.phase === null).length
    // Unknown is not idle: only a phase the server observed counts as idle.
    const idle = group.length - working - waiting - untracked
    return { source, working, waiting, idle, untracked, total: working + waiting + idle + untracked }
  })
  return built.sort((a, b) => b.working + b.waiting - (a.working + a.waiting) || b.total - a.total || a.source.localeCompare(b.source))
}

/** Computers with live sessions, the busiest first; harnesses within by how many sessions they run. */
export function machinesOf(p: Presentation): Machine[] {
  const live = p.sessions.filter((s) => s.phase !== "ended")
  const grouped = new Map<string, Session[]>()
  for (const s of live) grouped.set(s.computer ?? "Unknown computer", [...(grouped.get(s.computer ?? "Unknown computer") ?? []), s])
  return [...grouped]
    .map(([name, rows]): Machine => {
      const harnesses = harnessesIn(rows)
      const sum = (key: "working" | "waiting" | "idle" | "untracked") => harnesses.reduce((n, h) => n + h[key], 0)
      const working = sum("working")
      const waiting = sum("waiting")
      const untracked = sum("untracked")
      return {
        name,
        icon: rows.find((r) => r.computerIcon)?.computerIcon ?? null,
        harnesses,
        sessions: [...rows].sort((a, b) => phaseRank(a.phase) - phaseRank(b.phase)),
        working,
        waiting,
        idle: sum("idle"),
        untracked,
        isIdle: working === 0 && waiting === 0 && untracked === 0,
      }
    })
    .sort((a, b) => b.working + b.waiting - (a.working + a.waiting) || a.name.localeCompare(b.name))
}

// MARK: Tally

export type TallyKind = "needsYou" | "yourTurn" | "running" | "finished" | "failed" | "stopped" | "quiet" | "paused" | "sessions"

export interface TallyEntry {
  kind: TallyKind
  count: number
  /** Colour and symbol; sessions have none. */
  tone: Tone | null
  /** The word after the count: "2 needs you", "1 failed", "3 working". */
  label: string
}

const TALLY_TONE: Record<TallyKind, Tone | null> = {
  needsYou: "needsYou",
  yourTurn: "yourTurn",
  running: "working",
  finished: "done",
  failed: "failed",
  stopped: "leftUnfinished",
  quiet: "quiet",
  paused: "paused",
  sessions: null,
}

const tallyLabel = (kind: TallyKind, count: number): string =>
  ({
    needsYou: "needs you",
    yourTurn: "your turn",
    running: "running",
    finished: "finished",
    failed: "failed",
    stopped: "stopped",
    quiet: "quiet",
    paused: "paused",
    sessions: count === 1 ? "session working" : "sessions working",
  })[kind]

/** Sessions working right now that no card shows: what the closed notch counts like music playing. */
export const workingSessionsWithoutCards = (p: Presentation): number => p.sessions.filter((s) => s.phase === "working" && !s.hasCard).length

/**
 * Everything the open notch lists, counted in the order that matters (needs you first, sessions last), zero counts
 * left out, each thing counted once. Read off the sections and sessions as they are: nothing is decided here.
 */
export function tallyOf(p: Presentation): TallyEntry[] {
  const rows = (kind: SectionKind): Row[] => p.sections.find((s) => s.kind === kind)?.rows ?? []
  const recent = rows("recent")
  const counts: Array<[TallyKind, number]> = [
    ["needsYou", rows("needsYou").length],
    ["yourTurn", rows("waitingOnYou").length],
    ["running", rows("running").length],
    ["failed", recent.filter((r) => r.tone === "failed").length],
    ["stopped", recent.filter((r) => r.tone === "dropped" || r.tone === "leftUnfinished").length],
    ["finished", recent.filter((r) => !isStopped(r.tone)).length],
    ["quiet", rows("quiet").length],
    ["paused", rows("paused").length],
    // Sessions behind a card are that card's count already: only the ones no card shows.
    ["sessions", workingSessionsWithoutCards(p)],
  ]
  return counts.filter(([, count]) => count > 0).map(([kind, count]) => ({ kind, count, tone: TALLY_TONE[kind], label: tallyLabel(kind, count) }))
}
