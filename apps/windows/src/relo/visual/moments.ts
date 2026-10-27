// The moments the closed notch plays once: what happened, to which card, when. Ports `ReloOrbitMoment`
// (ReloOrbitWings.swift:84-124), the moment lead/duration tables (ReloClosedActivity.swift:271-293) and the store half
// of ReloMoments (ReloMoments.swift: once-per-moment dedupe, `stepped`, `unseen`, the baseline). The controller is
// plain TypeScript with an injectable clock so its timing is tested with fake timers; `useMoments` binds it to React.

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react"
import { eventsBetween, type EventKind, type NotchEvent } from "../events"
import type { BarSegment } from "../plan"
import { rowBar, type Presentation, type Row } from "../presentation"

export type MomentKind = "started" | "step" | "needs" | "turn" | "done" | "failed"

export interface OrbitMoment {
  kind: MomentKind
  rowID: string
  bar: BarSegment[] | null
  /** Epoch milliseconds when it began. */
  at: number
}

/** How long a moment plays before the wings return to the lead's state (Swift :96-103), in seconds. */
export function momentDuration(kind: MomentKind): number {
  switch (kind) {
    case "started":
    case "step":
      return 2.6
    case "needs":
      return 2.2
    case "turn":
    case "done":
    case "failed":
      return 5.2
  }
}

const KIND_OF: Readonly<Record<EventKind, MomentKind>> = {
  question: "needs",
  yourTurn: "turn",
  finished: "done",
  failed: "failed",
  progressed: "step",
  started: "started",
}

/** `ReloOrbitMoment.init?(_ event:)` (Swift :105-117). */
export function momentOf(event: NotchEvent, at: number): OrbitMoment {
  return { kind: KIND_OF[event.kind], rowID: event.row.id, bar: rowBar(event.row), at }
}

/** `ReloOrbitMoment.init(step:)` (Swift :119-123). */
export function stepMoment(row: Row, at: number): OrbitMoment {
  return { kind: "step", rowID: row.id, bar: rowBar(row), at }
}

/** How long the wings play an update's moment before its card opens (ReloClosedActivity.swift:271-281), seconds. */
export function momentLead(kind: EventKind): number {
  switch (kind) {
    case "question":
      return 1.75
    case "yourTurn":
      return 2.25
    case "failed":
      return 2.05
    case "finished":
      return 2.35
    case "progressed":
      return 1.35
    case "started":
      return 1.75
  }
}

/** How long an update's card stays expanded (ReloClosedActivity.swift:283-292), seconds. */
export function peekDuration(kind: EventKind): number {
  switch (kind) {
    case "question":
      return 8
    case "failed":
      return 6
    case "yourTurn":
      return 5
    case "finished":
      return 3.5
    case "started":
    case "progressed":
      return 3
  }
}

/** A moment has a clock until its duration is over; reduce-motion plays none. */
export function isPlaying(moment: OrbitMoment | null, nowMs: number, reduceMotion = false): moment is OrbitMoment {
  return moment !== null && !reduceMotion && nowMs - moment.at < momentDuration(moment.kind) * 1000
}

export interface Snapshot {
  moment: OrbitMoment | null
  /** A moment arrived that the owner has not seen: the mark breathes until Relo's tab opens. */
  unseen: boolean
  /** Changes with every new moment or end. */
  version: number
}

export interface ControllerOptions {
  now?: () => number
  /** Alerts paused or a full-screen app in front: no moment plays (Swift `quiet`). */
  quiet?: () => boolean
}

type Listener = () => void

const keyOf = (e: NotchEvent): string => `${e.kind}|${e.row.id}|${e.row.questionId ?? ""}`

export class MomentController {
  private readonly now: () => number
  private readonly quiet: () => boolean
  private current: OrbitMoment | null = null
  private unseenFlag = false
  private version = 0
  private previous: Presentation | null = null
  private readonly cued = new Set<string>()
  private readonly listeners = new Set<Listener>()
  private readonly eventListeners = new Set<(events: NotchEvent[]) => void>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private snap: Snapshot

  constructor(options: ControllerOptions = {}) {
    this.now = options.now ?? Date.now
    this.quiet = options.quiet ?? (() => false)
    this.snap = { moment: null, unseen: false, version: 0 }
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** For the card that expands for an update (peek): the events of each new batch, most important first. */
  onEvents(listener: (events: NotchEvent[]) => void): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  getSnapshot = (): Snapshot => this.snap

  /** The moment while it plays (null when over, or with reduce-motion). */
  active(reduceMotion = false): OrbitMoment | null {
    return isPlaying(this.current, this.now(), reduceMotion) ? this.current : null
  }

  get unseen(): boolean {
    return this.unseenFlag
  }

  markSeen(): void {
    if (!this.unseenFlag) return
    this.unseenFlag = false
    this.publish()
  }

  /** A new notice arrived (ReloMoments.noticeMoment): it has no sound; the orb breathes until Relo's tab is seen. */
  noticed(): void {
    if (this.unseenFlag) return
    this.unseenFlag = true
    this.publish()
  }

  /** The staged onboarding left the notch: the server's own presentation returns silently, as at launch (no moment for the swap). */
  rebase(next: Presentation): void {
    this.previous = next
  }

  /**
   * The next presentation: finds the events (once each, like ReloMoments' `cued` set) and the finished steps, and plays
   * them. The first presentation is the baseline: what already waits shows, but is not "unseen".
   */
  ingest(next: Presentation): NotchEvent[] {
    const before = this.previous
    this.previous = next
    const baseline = before === null
    const events = eventsBetween(before, next).filter((e) => this.cued.add(keyOf(e)))
    if (before) this.stepped(before, next)
    if (events.length > 0) {
      for (const listener of this.eventListeners) listener(events)
      if (!baseline) this.unseenFlag = true
      this.receive(events)
    }
    return events
  }

  /** `receive(_ events:)` (Swift :208-217): the wings play the lead update's moment. */
  receive(events: NotchEvent[]): void {
    const lead = events[0]
    if (!lead) return
    if (this.quiet()) {
      this.publish()
      return
    }
    this.play(momentOf(lead, this.now()))
  }

  /** A card finished a plan step (ReloMoments.stepMoment): plays only when no other moment is playing. */
  private stepped(before: Presentation, next: Presentation): void {
    const old = new Map<string, Row>()
    for (const row of before.sections.flatMap((s) => s.rows)) if (!old.has(row.id)) old.set(row.id, row)
    const row = next.sections
      .filter((s) => s.kind !== "quiet" && s.kind !== "paused")
      .flatMap((s) => s.rows)
      .find((r) => {
        const o = old.get(r.id)
        return r.tone === "working" && o?.tone === "working" && r.stepsDone !== null && r.stepsDone > (o.stepsDone ?? r.stepsDone)
      })
    if (!row || this.quiet()) return
    if (this.active() !== null) return
    this.play(stepMoment(row, this.now()))
  }

  private play(moment: OrbitMoment): void {
    this.current = moment
    clearTimeout(this.timer)
    // Publish again when it ends, so a render loop can go idle.
    this.timer = setTimeout(() => this.publish(), momentDuration(moment.kind) * 1000 + 20)
    this.publish()
  }

  private publish(): void {
    this.version += 1
    this.snap = { moment: this.active(), unseen: this.unseenFlag, version: this.version }
    for (const listener of this.listeners) listener()
  }

  dispose(): void {
    clearTimeout(this.timer)
    this.listeners.clear()
    this.eventListeners.clear()
  }
}

/**
 * The closed notch's moments from the presentation: finds events and steps on every change and returns the controller
 * (read `controller.active()` per frame) with a snapshot that re-renders when a moment starts or ends.
 */
export function useMoments(
  presentation: Presentation,
  /** False until the first real summary: the empty state is no baseline (ReloMoments.receive). */
  ready = true,
  options: ControllerOptions = {},
  /** The onboarding's staged work is what the presentation shows (it plays its moments, then leaves silently). */
  staged = false,
): { controller: MomentController; snapshot: Snapshot } {
  const controller = useMemo(() => new MomentController(options), []) // eslint-disable-line react-hooks/exhaustive-deps
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const wasStaged = useRef(false)
  useEffect(() => {
    if (!ready) return
    if (wasStaged.current && !staged) controller.rebase(presentation)
    else controller.ingest(presentation)
    wasStaged.current = staged
  }, [controller, presentation, ready, staged])
  useEffect(() => () => controller.dispose(), [controller])
  return { controller, snapshot }
}
