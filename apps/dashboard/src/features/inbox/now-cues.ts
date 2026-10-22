import { useEffect } from "react"

import { EVENT_PRIORITY, type NowEvent, type NowEventBatch, type NowEventKind } from "@/features/inbox/now-events"
import { playCue, unlockSoundOnGesture, type Cue } from "@/lib/sound"

/**
 * Now's moments as sound (ADR 0013): the same diff that drives the comets picks the cue. Needs you,
 * failed and done have one; started, step, update, recovered and a new session are motion only. (A
 * "your turn" moment has no kind in the diff yet, so `your-turn` is not cued from here.)
 */
const CUE_FOR: Partial<Record<NowEventKind, Cue>> = { needsYou: "needs-you", failed: "failed", done: "done" }

/** The one cue of a batch: its highest-priority moment that has a sound, or none. */
export function cueFor(events: readonly NowEvent[]): Cue | null {
  let best: NowEvent | null = null
  for (const event of events) {
    if (CUE_FOR[event.kind] && (!best || EVENT_PRIORITY[event.kind] < EVENT_PRIORITY[best.kind])) best = event
  }
  return best ? CUE_FOR[best.kind]! : null
}

/** A tab that just came back replays what it missed in one refresh; that refresh is the baseline, not news. */
export const RETURN_WINDOW_MS = 15_000

/**
 * Cues each moment once. `batch` plays at most one cue per refresh; moments already cued, the
 * page-open catch-up (`baseline`) and the first refresh after the tab returns (`returned`) stay
 * silent. A moment is its kind, card and declared instant, so a card that fails after it needed you
 * is a new moment, and an open question is never cued twice.
 */
export function createMomentCues(play: (cue: Cue) => unknown, now: () => number = Date.now) {
  const cued = new Set<string>()
  let returnedAt: number | null = null
  const keyOf = (event: NowEvent) => `${event.kind}:${event.id}:${event.at}`
  return {
    baseline(events: readonly NowEvent[]) {
      for (const event of events) cued.add(keyOf(event))
    },
    returned() {
      returnedAt = now()
    },
    batch(events: readonly NowEvent[]) {
      const replay = returnedAt !== null && now() - returnedAt < RETURN_WINDOW_MS
      returnedAt = null
      const fresh = events.filter((event) => !cued.has(keyOf(event)))
      for (const event of fresh) cued.add(keyOf(event))
      const cue = replay ? null : cueFor(fresh)
      if (cue) play(cue)
    },
  }
}

/** The page's life: a remount of Now (navigating back) must not cue what it already cued. */
const moments = createMomentCues(playCue)

/** Cues Now's refresh batches. The first paint (batch 0) and the catch-up are the baseline. */
export function useMomentCues(batch: NowEventBatch, catchUp: readonly NowEvent[]) {
  useEffect(() => {
    moments.baseline(catchUp)
  }, [catchUp])
  useEffect(() => {
    unlockSoundOnGesture()
    const onVisible = () => {
      if (document.visibilityState === "visible") moments.returned()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [])
  useEffect(() => {
    if (batch.key > 0) moments.batch(batch.events)
  }, [batch])
}
