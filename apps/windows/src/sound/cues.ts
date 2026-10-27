/**
 * Relo's sound set on Windows (ADR 0013, docs/SOUND.md): the same 19 cues as Relo for Mac, ported from
 * ReloMoments.swift (`ReloCue`, `ReloMoments.cue(for:)`) and NotchEvents.swift (`NotchEvent.Kind.rank`).
 * The files in `public/sounds/<cue>.wav` are the Mac's samples (scripts/sounds/to_wav.py).
 */
export const CUES = [
  "needs-you", "your-turn", "done", "failed", "sent", "linked", "start", "update",
  "turn", "open", "close", "expand", "collapse", "launch", "quit", "tab", "section", "on", "off",
] as const

export type Cue = (typeof CUES)[number]

const INTERFACE: ReadonlySet<Cue> = new Set<Cue>([
  "turn", "open", "close", "expand", "collapse", "launch", "quit", "tab", "section", "on", "off",
])

/** Interface sounds (notch open/close, a card unfolding, tabs, switches, launch, quit) have their own switch. */
export function isInterfaceCue(cue: Cue): boolean {
  return INTERFACE.has(cue)
}

/** The cue of a switch or tick that is now `on` (rising) or off (falling): A16 and A17. */
export function toggleCue(on: boolean): Cue {
  return on ? "on" : "off"
}

/** The same kinds as apps/notch NotchEvents.swift. */
export type NotchEventKind = "question" | "failed" | "yourTurn" | "finished" | "started" | "progressed"

export const EVENT_KINDS: readonly NotchEventKind[] = ["question", "failed", "yourTurn", "finished", "started", "progressed"]

/** Which event leads when several arrive together (lower wins), as `NotchEvent.Kind.rank`. */
export const EVENT_RANK: Record<NotchEventKind, number> = {
  question: 0,
  failed: 1,
  yourTurn: 2,
  finished: 3,
  started: 4,
  progressed: 5,
}

/** A notch moment. `tone` is the card's tone: a failed event is only heard for a card that is still `failed`. */
export interface NotchEvent {
  kind: NotchEventKind
  tone?: string
}

/**
 * The ADR's table: dropped or left-unfinished work is silent (a `failed` event whose card is not tone `failed`),
 * a card starting gets the quiet start cue, and a finished step (`progressed`) has no moment cue (the `update`
 * tick is played by the step logic, not by a moment).
 */
export function cueFor(event: NotchEvent): Cue | null {
  switch (event.kind) {
    case "question": return "needs-you"
    case "failed": return event.tone === "failed" ? "failed" : null
    case "yourTurn": return "your-turn"
    case "finished": return "done"
    case "started": return "start"
    case "progressed": return null
  }
}

/** Settings' preview of a kind's cue (ReloSounds.preview). */
export function previewCue(kind: NotchEventKind): Cue {
  switch (kind) {
    case "question": return "needs-you"
    case "failed": return "failed"
    case "yourTurn": return "your-turn"
    case "finished": return "done"
    case "started": return "start"
    case "progressed": return "update"
  }
}

/** The leading event of a burst: the highest rank that has a cue (first one on a tie). */
export function leadOf(events: readonly NotchEvent[]): NotchEvent | null {
  let lead: NotchEvent | null = null
  for (const event of events) {
    if (cueFor(event) === null) continue
    if (lead === null || EVENT_RANK[event.kind] < EVENT_RANK[lead.kind]) lead = event
  }
  return lead
}
