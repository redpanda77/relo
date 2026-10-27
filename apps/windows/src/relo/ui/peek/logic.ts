// What the expanded notch says for an update, pure (ReloClosedActivity.swift ReloOpenKind / ReloPeekPill / ReloExpandedCard).

import type { QuestionSpec } from "../../answers"
import type { NotchEvent } from "../../events"
import { rowBar, rowPlanLine, type Row } from "../../presentation"
import type { BarSegment } from "../../plan"
import { COLORS } from "../theme"
import { readableName } from "../open/logic"

/** What an update expands as: its light, its entrance and its idle life (ReloOpenKind). */
export type OpenKind = "needs" | "turn" | "running" | "failed" | "started" | "done"

export function openKindOf(event: NotchEvent, row: Row): OpenKind {
  switch (event.kind) {
    case "question":
      return "needs"
    case "yourTurn":
      return "turn"
    case "failed":
      return "failed"
    case "started":
      return "started"
    case "finished":
      return "done"
    case "progressed":
      return row.questionPending ? "needs" : "running"
  }
}

export function openKindColor(kind: OpenKind): string {
  switch (kind) {
    case "needs":
    case "turn":
      return COLORS.signalCoral
    case "running":
    case "started":
      return COLORS.running
    case "failed":
      return COLORS.problem
    case "done":
      return COLORS.done
  }
}

/** Questions and failures open the card; a start or a finish is one small line (the pill). */
export const isPill = (event: NotchEvent): boolean => event.kind === "finished" || event.kind === "started"

/** The expanded card's width (CSS px) and the pill's. */
export const PEEK_WIDTH = 440

/** A start says where it begins; a finish says what it delivered (ReloPeekPill.line). */
export function pillLine(event: NotchEvent, row: Row): string | null {
  if (event.kind === "started") {
    if (row.currentStep) return `Step ${(row.stepsDone ?? 0) + 1} of ${row.stepsTotal ?? 1} · ${row.currentStep}`
    return row.status
  }
  return row.roundOutcome ?? row.status
}

/** The badge word of the pill: "Started", else the state's label. */
export const pillBadge = (kind: OpenKind, label: string): string => (kind === "started" ? "Started" : label)

/** The pill shows its bar for a finish (swept mint) or when the row has a plan. */
export function pillBar(kind: OpenKind, row: Row): BarSegment[] | null {
  const bar = rowBar(row)
  if (kind === "done") return bar && bar.length > 0 ? bar.map(() => ({ state: "done", fill: 1 })) : [{ state: "done", fill: 1 }]
  return bar
}

/** The plan bar sits on the card only while there is a plan to go (showsBar). */
export function cardShowsBar(kind: OpenKind, row: Row): boolean {
  return !row.questionPending && rowBar(row) !== null && (kind === "running" || kind === "turn") && (row.stepsDone ?? 0) < (row.stepsTotal ?? 0)
}

/** The card's one line under the title (ReloExpandedCard.detail). */
export function cardDetail(row: Row, spec: QuestionSpec | undefined, toneLabel: string): string {
  if (row.unreadable) return "Waiting for approval on your iPhone"
  if (spec?.prompt) return spec.prompt
  if (row.questionPending) return row.status ?? "A question is waiting"
  if (row.tone === "working") {
    const line = rowPlanLine(row)
    if (line) return line
  }
  return row.status ?? row.roundOutcome ?? toneLabel
}

export const detailLines = (kind: OpenKind, row: Row): number => (row.questionPending || kind === "failed" || kind === "turn" ? 2 : 1)

export const titleOf = (row: Row): string => readableName(row.title) ?? "Untitled"

/** The expanded card follows the live summary by id (ReloClosedActivity.live). */
export function liveRow(row: Row, rows: Row[]): Row {
  return rows.find((r) => r.id === row.id) ?? row
}
