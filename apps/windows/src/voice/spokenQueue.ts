// The lines waiting to be said after their cue (ADR 0015): one at a time, never interrupting, most important first. A burst says at
// most two lines; what is left becomes one count line ("And 2 more updates."), except open questions and failures, which each get
// their own line. News that waited too long is dropped; a question stays while it is open. Ported from
// apps/notch/ReloNotchKit/Sources/ReloNotchKit/SpokenQueue.swift.

import { EVENT_RANK, type Cue, type NotchEventKind } from "../sound/cues"

export interface QueuedLine {
  /** The card (a work's id); empty for the count line. */
  id: string
  kind: NotchEventKind
  text: string
  /** Epoch milliseconds. */
  at: number
  /** The cue to play right before the line, when it could not play on arrival because another line was being said: a sound
   * never lands on top of the voice. */
  cue?: Cue
}

/** A your-turn or finished line older than this is past news. */
export const STALE_AFTER_MS = 60_000
/** Lines said in one burst before the rest becomes a count. */
export const PER_BURST = 2

export class SpokenQueue {
  private lines: QueuedLine[] = []
  private saidInBurst = 0

  get waiting(): readonly QueuedLine[] {
    return this.lines
  }

  get isEmpty(): boolean {
    return this.lines.length === 0
  }

  /** Queues `lines`; a line already waiting for the same card and kind is replaced by the newer one. */
  add(lines: readonly QueuedLine[]): void {
    for (const line of lines) {
      this.lines = this.lines.filter((l) => !(l.id === line.id && l.kind === line.kind))
      this.lines.push(line)
    }
    // Most important first; the order they arrived in on a tie (a stable sort).
    this.lines = this.lines
      .map((line, index) => ({ line, index }))
      .sort((a, b) => EVENT_RANK[a.line.kind] - EVENT_RANK[b.line.kind] || a.index - b.index)
      .map((entry) => entry.line)
  }

  /**
   * The next line to say, or null when nothing is left (the burst ends). `open` says whether a question line's question is still
   * waiting for an answer.
   */
  next(now: number, open: (line: QueuedLine) => boolean): QueuedLine | null {
    this.lines = this.lines.filter((line) => (line.kind === "question" ? open(line) : now - line.at <= STALE_AFTER_MS))
    if (this.lines.length === 0) {
      this.saidInBurst = 0
      return null
    }
    if (this.saidInBurst >= PER_BURST) {
      const urgent = this.lines.findIndex((l) => l.kind === "question" || l.kind === "failed")
      if (urgent !== -1) return this.lines.splice(urgent, 1)[0]!
      const count = this.lines.length
      this.lines = []
      return { id: "", kind: "progressed", text: `And ${count} more update${count === 1 ? "" : "s"}.`, at: now }
    }
    this.saidInBurst += 1
    return this.lines.shift()!
  }

  /** Drops everything (the microphone came on, alerts were paused): it would be stale by the time it could be said. */
  clear(): void {
    this.lines = []
    this.saidInBurst = 0
  }
}
