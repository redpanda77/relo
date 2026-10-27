// The open Relo tab's decisions, pure (ReloNotchView.swift ReloWorkList / ReloQuietLine / ReloSummaryBar and
// ReloCards.swift ReloWorkCard): which cards show, how the summary line shrinks, what a card says and which buttons it has.

import { answerButtons, type AnswerPhase, type QuestionSpec } from "../../answers"
import { isFolded, type Presentation, type Row, type SectionKind, type TallyEntry, type Section } from "../../presentation"
import { toneLabel } from "../theme"
import { unreadable } from "../words"

/** The cue a click on a card plays (ReloNotchView.toggle): the open card folding is `collapse`, any other opening is `expand`. */
export function toggleCue(expandedId: string | null, clickedId: string): "expand" | "collapse" {
  return expandedId === clickedId ? "collapse" : "expand"
}

/** How many cards each section shows before "+n more" (needs you always shows every card). */
export function cap(kind: SectionKind): number {
  switch (kind) {
    case "needsYou":
      return Number.MAX_SAFE_INTEGER
    case "waitingOnYou":
    case "recent":
      return 3
    case "running":
      return 4
    case "quiet":
    case "paused":
      return 3
  }
}

/** Needs you, your turn and running, each up to its cap, in order; and how many were left out. */
export function liveCards(p: Presentation): { cards: Array<{ row: Row; hero: boolean }>; more: number } {
  const sections = p.sections.filter((s) => s.kind === "needsYou" || s.kind === "waitingOnYou" || s.kind === "running")
  return {
    cards: sections.flatMap((s) => s.rows.slice(0, cap(s.kind)).map((row) => ({ row, hero: s.kind === "needsYou" }))),
    more: sections.reduce((n, s) => n + Math.max(0, s.rows.length - cap(s.kind)), 0),
  }
}

/** The rows a folded (quiet / paused) group lists when shown. */
export const foldedRows = (sections: Section[]): Row[] => sections.flatMap((s) => s.rows.slice(0, cap(s.kind)))
export const foldedSections = (p: Presentation): Section[] => p.sections.filter((s) => isFolded(s.kind))

/** "just now", "18 min ago", "2 h ago", "3 d ago": the age the eye needs, not a timer (ReloQuietLine.ago). */
export function ago(ms: number, now: number): string {
  const minutes = Math.floor((now - ms) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)} h ago`
  return `${Math.floor(minutes / 1440)} d ago`
}

/** "3 quiet · 1 paused". */
export const foldCounts = (sections: Section[]): string => sections.map((s) => `${s.rows.length} ${s.kind === "paused" ? "paused" : "quiet"}`).join(" · ")
/** The moon, or the pause sign when everything folded is paused. */
export const foldIsOnlyPaused = (sections: Section[]): boolean => sections.every((s) => s.kind === "paused")

// MARK: Summary line

export type SummaryWords = "all" | "urgent" | "none"
export interface SummaryVariant {
  words: SummaryWords
  limit: number
}

/** ViewThatFits' candidates, widest first: words on all, words on needs-you only, no words, then 4 and 2 counts. */
export const SUMMARY_VARIANTS: readonly SummaryVariant[] = [
  { words: "all", limit: Infinity },
  { words: "urgent", limit: Infinity },
  { words: "none", limit: Infinity },
  { words: "none", limit: 4 },
  { words: "none", limit: 2 },
]

/** What a variant shows: the counts (with or without their word) and the "+n" for the ones folded away. */
export function summaryShown(tally: TallyEntry[], variant: SummaryVariant): { shown: Array<{ entry: TallyEntry; worded: boolean }>; rest: number } {
  const shown = tally.slice(0, variant.limit).map((entry) => ({ entry, worded: variant.words === "all" || (variant.words === "urgent" && entry.kind === "needsYou") }))
  const rest = tally.slice(variant.limit).reduce((n, e) => n + e.count, 0)
  return { shown, rest }
}

// MARK: Card

export interface CardFacts {
  badge: string
  /** The plan bar says something only while there is still a plan to go. */
  showsBar: boolean
  /** The plan only (the state is the badge's): "Step 3 of 5 · Run the tests". */
  planCaption: string | null
  bodyText: string | null
  /** The footer's right side. */
  footer: "answer" | "dismiss" | "facts"
}

export function cardFacts(row: Row, spec: QuestionSpec | undefined, bar: boolean, local = false): CardFacts {
  const total = row.stepsTotal ?? 0
  const done = row.stepsDone ?? 0
  const showsBar = bar && total > 0 && !row.questionPending && done < total && row.tone === "working"
  let planCaption: string | null = null
  if (!row.questionPending && !row.questionMissed && row.stepsDone !== null && row.stepsTotal !== null && total > 0) {
    planCaption = done >= total ? `${total} of ${total} done` : row.currentStep ? `Step ${done + 1} of ${total} · ${row.currentStep}` : `Step ${done + 1} of ${total}`
  }
  const bodyText = row.unreadable ? unreadable(local) : row.questionPending && spec?.prompt ? spec.prompt : row.status
  return {
    badge: row.questionMissed ? "Missed" : toneLabel(row.tone),
    showsBar,
    planCaption,
    bodyText,
    footer: row.questionPending && row.questionId ? "answer" : row.questionMissed && row.questionId ? "dismiss" : "facts",
  }
}

/** What the answer bar shows (ReloAnswerBar): offline, sending, sent, the buttons (with a failure above them), or a wait. */
export type AnswerView =
  | { kind: "offline" }
  | { kind: "sending" }
  | { kind: "sent" }
  | { kind: "wait" }
  | { kind: "text" }
  | { kind: "buttons"; failure: string | null }

export function answerView(spec: QuestionSpec | undefined, phase: AnswerPhase | undefined, offline: boolean, local = false): AnswerView {
  if (offline) return { kind: "offline" }
  if (phase?.state === "sending") return { kind: "sending" }
  if (phase?.state === "accepted") return { kind: "sent" }
  if (!spec) return { kind: "wait" }
  if (answerButtons(spec, local).length === 0) return { kind: "text" }
  return { kind: "buttons", failure: phase?.state === "failed" ? phase.message : null }
}

/** A name the owner can read: server-sealed ids (c-..., p-...) are not names (ReloDisplayName.readable). */
export function readableName(name: string | null | undefined): string | null {
  if (!name) return null
  return /^[a-z]-[a-z0-9]{10,}$/.test(name) ? null : name
}
