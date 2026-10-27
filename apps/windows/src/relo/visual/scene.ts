// What the closed notch's wings show now, from the presentation. Ports `ReloOrbitScene` (ReloOrbitWings.swift:15-82)
// and the wing sizing of `ReloWing` (ReloClosedActivity.swift:87-113). Nothing here decides state.

import { rowBar, workingSessionsWithoutCards, type Presentation, type Row } from "../presentation"
import type { BarSegment } from "../plan"
import { CLOSED_METRICS } from "./theme"

export type Lead = "running" | "needs" | "turn" | "done" | "failed" | "quiet" | "rest"

export interface Satellite {
  id: string
  quiet: boolean
  /** How fast it circles (0...1): recently moved work circles faster. */
  pace: number
}

export interface OrbitScene {
  lead: Lead
  leadID: string | null
  satellites: Satellite[]
  bar: BarSegment[] | null
  /** Live sessions besides the lead (the right wing's +N). */
  more: number
  locked: boolean
  unseen: boolean
  /** The harness of the first working session no card shows yet, for the time before a plan. */
  source: string | null
}

const LIVE_KINDS = new Set(["needsYou", "waitingOnYou", "running"])

/** `ReloOrbitScene.init` (Swift lines 39-71). */
export function sceneOf(p: Presentation, unseen: boolean, nowMs: number = Date.now()): OrbitScene {
  const focus = p.focus
  const seen = new Set<string>()
  const rows: Row[] = p.sections
    .filter((s) => LIVE_KINDS.has(s.kind))
    .flatMap((s) => s.rows)
    .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
  if (focus) {
    const index = rows.findIndex((r) => r.id === focus.id)
    if (index > 0) rows.unshift(...rows.splice(index, 1))
  }
  const pace = (row: Row): number => {
    const age = (nowMs - row.declaredAt) / 1000
    return age < 120 ? 1 : age < 600 ? 0.7 : 0.45
  }
  const all: Satellite[] = rows.map((r) => ({ id: r.id, quiet: r.tone === "quiet", pace: pace(r) }))
  const extra = workingSessionsWithoutCards(p)
  for (let i = 0; i < extra; i++) all.push({ id: `session-${i}`, quiet: false, pace: 0.6 })
  const satellites = all.slice(0, CLOSED_METRICS.maxSatellites)
  const lead: Lead = (() => {
    switch (focus?.tone) {
      case "needsYou":
        return "needs"
      case "yourTurn":
        return "turn"
      case "working":
        return "running"
      case "quiet":
      case "paused":
        return "quiet"
      case "done":
        return "done"
      case "failed":
      case "dropped":
      case "leftUnfinished":
        return "failed"
      default:
        return all.length === 0 ? "rest" : "running"
    }
  })()
  return {
    lead,
    leadID: focus?.id ?? null,
    satellites,
    bar: focus ? rowBar(focus) : null,
    more: Math.max(0, all.length - 1),
    locked: focus?.unreadable ?? false,
    unseen,
    source: p.sessions.find((s) => s.phase === "working" && !s.hasCard)?.source ?? focus?.source ?? null,
  }
}

// MARK: Sizing (ReloWing)

/** Whether anything is live: a focus or a working session without a card. */
export const isLive = (p: Presentation): boolean => p.focus !== null || workingSessionsWithoutCards(p) > 0

/** The mark's side: `max(0, closed height - 12)` (ReloClosedActivity.swift:132). */
export const markSide = (closedHeight: number): number => Math.max(0, closedHeight - 12)

/** Each wing's content width: Orbit's width while anything is live, else just the mark (Swift :98-100). */
export function wingContentWidth(p: Presentation, side: number): number {
  return isLive(p) ? Math.max(side, CLOSED_METRICS.orbit) : side
}

/**
 * The closed notch's whole width, as the Mac's snapshot bench computes it (ReloSnapshot.swift:132):
 * 2 (wing + outer + gap) + housing - top corner + 2 bottom corner.
 */
export function closedWidth(p: Presentation, closedHeight: number, housing: number = CLOSED_METRICS.housing): number {
  const { outer, gap, cornerTop, cornerBottom } = CLOSED_METRICS
  return 2 * (wingContentWidth(p, markSide(closedHeight)) + outer + gap) + housing - cornerTop + 2 * cornerBottom
}
