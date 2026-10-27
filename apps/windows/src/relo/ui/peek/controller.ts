// When the closed notch grows into a card for an update, and which one (ReloClosedActivity.swift:209-312, the
// `expanded`, `queue`, `notice` and `noticeQueue` state and the tasks that move them). Plain TypeScript with injected
// timers and gates, so the timings are tested with fake timers; `usePeek` binds it to React.
//
//   updates   the wings play the lead update's moment (`momentLead`), the card then stays `peekDuration`; hovering the
//             card keeps it (polled every 300 ms); 450 ms later the next queued update, or a notice, shows.
//   queue     a more important update (question, failed, your turn, finished, started, progressed) replaces the shown
//             one; the rest wait, at most 4, one per card.
//   notices   one at a time, 4.5 s, the last 3 kept, never over an update or a question.

import type { OwnerNotice } from "@relo/owner-client"
import { EVENT_RANK, type NotchEvent } from "../../events"
import { momentLead, peekDuration } from "../../visual/moments"
import type { Presentation } from "../../presentation"

export const NOTICE_MS = 4500
export const HOVER_POLL_MS = 300
export const NEXT_GAP_MS = 450
export const MAX_QUEUE = 4
export const MAX_NOTICES = 3

export interface PeekEnv {
  /** Alerts paused from the menu, or a full-screen app in front with "quiet in full screen" on. */
  quiet: () => boolean
  /** Settings > Alerts > "Expand the notch for updates" (`reloPeek`). */
  enabled: () => boolean
  reduceMotion: () => boolean
  /** The pointer is on the notch (ContentView `cursorIsOverNotch`). */
  cursorOver: () => boolean
  now?: () => number
  setTimeout?: (fn: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

export interface PeekSnapshot {
  /** The update the notch is expanded for, if any (its card follows the live summary by id). */
  expanded: { event: NotchEvent; openedAt: number } | null
  notice: { notice: OwnerNotice; openedAt: number } | null
  /** Changes with every change above. */
  version: number
}

const rankOf = (e: NotchEvent): number => EVENT_RANK[e.kind]

export class PeekController {
  private readonly env: Required<Pick<PeekEnv, "now" | "setTimeout" | "clearTimeout">> & PeekEnv
  private expanded: PeekSnapshot["expanded"] = null
  private notice: PeekSnapshot["notice"] = null
  private queue: NotchEvent[] = []
  private noticeQueue: OwnerNotice[] = []
  /** The row whose moment the wings last played (the Mac's `moment`). */
  private momentRow: string | null = null
  private expandTimer: unknown = null
  private noticeTimer: unknown = null
  private gapTimer: unknown = null
  private version = 0
  private snap: PeekSnapshot = { expanded: null, notice: null, version: 0 }
  private readonly listeners = new Set<() => void>()

  constructor(env: PeekEnv) {
    this.env = {
      ...env,
      now: env.now ?? Date.now,
      setTimeout: env.setTimeout ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimeout: env.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }
  getSnapshot = (): PeekSnapshot => this.snap

  /** The events of one batch, most important first (`MomentController.onEvents`). */
  receive(events: NotchEvent[]): void {
    const lead = events[0]
    if (!lead || this.env.quiet()) return
    // The wings play the lead update's moment; the card (when peeks are on) opens once it has been seen.
    this.momentRow = lead.row.id
    if (!this.env.enabled()) return
    // A more important update replaces what is shown; the rest wait their turn.
    const pending = [...this.queue, ...events].sort((a, b) => rankOf(a) - rankOf(b))
    const current = this.expanded?.event
    const next = pending[0]
    if (current && next && rankOf(next) < rankOf(current)) {
      this.queue = pending.slice(1).filter((e) => e.row.id !== next.row.id)
      this.show(next)
    } else if (!current && next) {
      this.queue = pending.slice(1)
      this.show(next)
    } else {
      this.queue = pending.filter((e) => e.row.id !== current?.row.id)
    }
    this.queue = this.queue.slice(0, MAX_QUEUE)
  }

  /** New notices (no iPhone gets the push): a short line under the notch, one at a time. */
  receiveNotices(arrivals: OwnerNotice[]): void {
    if (arrivals.length === 0 || this.env.quiet() || !this.env.enabled()) return
    this.noticeQueue = [...this.noticeQueue, ...arrivals].slice(-MAX_NOTICES)
    this.showNextNotice()
  }

  /** A card that left Now (answered, dismissed) closes its expansion. */
  closeIfGone(presentation: Presentation): void {
    const shown = this.expanded?.event.row.id
    if (shown === undefined) return
    if (!presentation.sections.some((s) => s.rows.some((r) => r.id === shown))) this.collapse()
  }

  dispose(): void {
    for (const h of [this.expandTimer, this.noticeTimer, this.gapTimer]) if (h !== null) this.env.clearTimeout(h)
    this.expandTimer = this.noticeTimer = this.gapTimer = null
    this.expanded = null
    this.notice = null
    this.queue = []
    this.noticeQueue = []
    this.listeners.clear()
  }

  private publish(): void {
    this.version += 1
    this.snap = { expanded: this.expanded, notice: this.notice, version: this.version }
    for (const l of this.listeners) l()
  }

  private clear(handle: unknown): null {
    if (handle !== null) this.env.clearTimeout(handle)
    return null
  }

  /** `show(_:)`: waits for the wings' moment, opens the card, keeps it for its time (and while hovered), then collapses. */
  private show(event: NotchEvent): void {
    this.expandTimer = this.clear(this.expandTimer)
    // A question or an update outranks a notice: it waits in the Recent list.
    this.noticeTimer = this.clear(this.noticeTimer)
    if (this.notice) {
      this.notice = null
      this.publish()
    }
    this.noticeQueue = []
    const lead = this.env.reduceMotion() || this.momentRow !== event.row.id ? 0 : momentLead(event.kind) * 1000
    const open = () => {
      this.expanded = { event, openedAt: this.env.now() }
      this.publish()
      this.expandTimer = this.env.setTimeout(() => this.hold(() => this.collapse()), peekDuration(event.kind) * 1000)
    }
    if (lead > 0) this.expandTimer = this.env.setTimeout(open, lead)
    else open()
  }

  /** Hovering the card keeps it (the notch opens from there). */
  private hold(done: () => void): void {
    if (this.env.cursorOver()) {
      this.expandTimer = this.env.setTimeout(() => this.hold(done), HOVER_POLL_MS)
      return
    }
    done()
  }

  private collapse(): void {
    this.expandTimer = this.clear(this.expandTimer)
    if (this.expanded) {
      this.expanded = null
      this.publish()
    }
    this.gapTimer = this.clear(this.gapTimer)
    const next = this.queue.shift()
    this.gapTimer = this.env.setTimeout(() => {
      this.gapTimer = null
      if (next) {
        if (!this.expanded && !this.env.quiet()) this.show(next)
      } else this.showNextNotice()
    }, NEXT_GAP_MS)
  }

  private showNextNotice(): void {
    if (this.notice || this.expanded || this.queue.length > 0) return
    const next = this.noticeQueue.shift()
    if (!next) return
    this.noticeTimer = this.clear(this.noticeTimer)
    this.notice = { notice: next, openedAt: this.env.now() }
    this.publish()
    const leave = () => {
      this.notice = null
      this.publish()
      this.noticeTimer = this.env.setTimeout(() => {
        this.noticeTimer = null
        this.showNextNotice()
      }, NEXT_GAP_MS)
    }
    this.noticeTimer = this.env.setTimeout(() => this.holdNotice(leave), NOTICE_MS)
  }

  private holdNotice(done: () => void): void {
    if (this.env.cursorOver()) {
      this.noticeTimer = this.env.setTimeout(() => this.holdNotice(done), HOVER_POLL_MS)
      return
    }
    done()
  }
}
