// What changed between two Now summaries, the way the iPhone's Live Activities see an update: a work started,
// needs the owner, became the owner's turn, finished or failed. Ports apps/notch/ReloNotchKit NotchEvents.swift.
// Step progress and status text change the card in place without an event. Everything compared here is the
// server's derivation.

import { isFolded, isStopped, type Presentation, type Row } from "./presentation"

export type EventKind = "question" | "failed" | "yourTurn" | "finished" | "started" | "progressed"

/** Which event leads when several arrive together. */
export const EVENT_RANK: Readonly<Record<EventKind, number>> = {
  question: 0,
  failed: 1,
  yourTurn: 2,
  finished: 3,
  started: 4,
  progressed: 5,
}

export interface NotchEvent {
  kind: EventKind
  row: Row
}

/**
 * The events from `previous` to `next`, most important first. The first summary after launch (`previous` null)
 * only reports questions already waiting: that is why the owner looks now.
 */
export function eventsBetween(previous: Presentation | null, next: Presentation): NotchEvent[] {
  const rows = next.sections.filter((s) => !isFolded(s.kind)).flatMap((s) => s.rows)
  if (previous === null) {
    return rows.filter((row) => row.questionPending).map((row) => ({ kind: "question", row }))
  }
  const before = new Map<string, Row>()
  for (const row of previous.sections.flatMap((s) => s.rows)) if (!before.has(row.id)) before.set(row.id, row)
  const events: NotchEvent[] = []
  for (const row of rows) {
    const old = before.get(row.id)
    if (row.questionPending && (old?.questionId !== row.questionId || old?.questionPending !== true)) {
      events.push({ kind: "question", row })
      continue
    }
    if (old?.tone === row.tone) continue
    if (isStopped(row.tone)) events.push({ kind: "failed", row })
    else if (row.tone === "yourTurn") events.push({ kind: "yourTurn", row })
    else if (row.tone === "done") events.push({ kind: "finished", row })
    // New work, or work that moves again after a pause or a quiet spell.
    else if (row.tone === "working" && (old === undefined || old.tone === "paused" || old.tone === "quiet")) events.push({ kind: "started", row })
  }
  // A stable sort keeps the arrival order within a kind.
  return events.sort((a, b) => EVENT_RANK[a.kind] - EVENT_RANK[b.kind])
}
