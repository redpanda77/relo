import type { NowItem, NowSummary, SessionRow } from "@/features/inbox/now-model"
import type { OrbMomentKind } from "@/lib/orb-theme"

/**
 * What changed between two of the server's Now summaries, as moments to show (a comet, a ring),
 * never as state: sections, counts and states stay the server's. Display only, and pure: the same
 * two summaries always give the same moments, and the first summary (no previous one) gives none.
 *
 * One moment is one real server update, so a comet always means "something just happened":
 * - needsYou: an item newly needs the owner;
 * - failed / done: work newly failed or finished;
 * - started: a new card started running;
 * - recovered: quiet work is moving again;
 * - step: a card's done steps increased;
 * - sessionStarted: a new session row, working;
 * - update: a card declared something new (its declaredAt advanced) and nothing else changed.
 * Never a moment: work going quiet or stale, a session ending, or only evidence/last-seen instants
 * moving (observed activity is the steady motion, not news).
 */
export type NowEventKind = OrbMomentKind
export type NowEvent = {
  kind: NowEventKind
  /** The card (act_…) or, for sessionStarted, the session row. */
  id: string
  /** The server's instant for the update (the card's declaredAt, a session's lastSeenAt). */
  at: string
  /** Where the comet comes from, as a screen-plane angle (radians): see `originFor`. */
  origin: number
  /** On the last comet of a capped burst: how many more moments it carries. */
  carry?: number
}
/** One refresh's moments; `key` changes with every new summary so a consumer fires each batch once. */
export type NowEventBatch = { key: number; events: readonly NowEvent[] }

/** At most five comets per refresh, so a burst reads as a burst rather than a storm. */
export const MAX_NOW_EVENTS = 5

/** Which moment wins a slot (and an item's one comet): needs you first, a status update last. */
export const EVENT_PRIORITY: Record<NowEventKind, number> = {
  needsYou: 0,
  failed: 1,
  done: 2,
  started: 3,
  recovered: 4,
  step: 5,
  sessionStarted: 6,
  update: 7,
}

const LISTS = ["recent", "paused", "quiet", "running", "waitingOnYou", "needsYou"] as const

/** Every item the summary lists, by id (the latest copy wins: recent after the live lists). */
export function nowItemsById(summary: NowSummary | null): ReadonlyMap<string, NowItem> {
  const map = new Map<string, NowItem>()
  if (!summary) return map
  for (const list of LISTS) for (const item of summary[list]) map.set(item.id, item)
  return map
}

const QUIET_STATES = new Set(["working_quietly", "stale", "stopped_responding", "no_signal"])
const RUNNING_STATES = new Set(["moving", "working_quietly"])

/** A stable 32-bit hash (FNV-1a) of a string: the same computer always lands in the same sector. */
export function stableHash(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

const DEG = Math.PI / 180
/** Agent computers arrive from the sides (six sectors), leaving below to scripts and above to services. */
const AGENT_SECTORS = [-40, 0, 40, 140, 180, 220].map((degrees) => degrees * DEG)
const SPREAD = 20 * DEG

/**
 * Where a comet comes from, as a screen-plane angle (0 = right, π/2 = above): agent work from its
 * computer's sector (a stable hash of the session row's computer), ±20° by the item itself; scripts
 * and apps from below; services from above.
 */
export function originFor(
  item: { id: string; producer?: NowItem["producer"]; sessionId?: string | null; computer?: string | null },
  sessions: readonly Pick<SessionRow, "id" | "computer">[] = []
): number {
  const jitter = ((stableHash(item.id) % 1000) / 999 - 0.5) * 2 * SPREAD
  if (item.producer === "script") return -Math.PI / 2 + jitter
  if (item.producer === "service") return Math.PI / 2 + jitter
  const computer = item.computer ?? sessions.find((row) => row.id === item.sessionId)?.computer ?? ""
  return AGENT_SECTORS[stableHash(computer) % AGENT_SECTORS.length]! + jitter
}

/** The one moment an item's change is, or null (no comet). */
function itemMoment(before: NowItem | undefined, after: NowItem, place: (typeof LISTS)[number], neededBefore: boolean): NowEventKind | null {
  const state = after.owner.state
  if (place === "needsYou" && !neededBefore) return "needsYou"
  if (place === "recent" && (state === "failed" || state === "done")) return before?.owner.state === state ? null : state
  if (!before) return place === "running" && RUNNING_STATES.has(state) ? "started" : null
  if (state === "moving" && QUIET_STATES.has(before.owner.state)) return "recovered"
  if (after.steps && (after.steps.done > (before.steps?.done ?? 0))) return "step"
  if (state === before.owner.state && after.declaredAt > before.declaredAt) return "update"
  return null
}

/**
 * At most five moments, the rest carried: the highest priority win a slot, then launch oldest
 * first; when more were due, the last comet carries the remainder (and lands harder).
 */
export function capMoments(events: readonly NowEvent[], max = MAX_NOW_EVENTS): NowEvent[] {
  const chosen = [...events]
    .sort((a, b) => EVENT_PRIORITY[a.kind] - EVENT_PRIORITY[b.kind] || a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
    .slice(0, max)
    .sort((a, b) => a.at.localeCompare(b.at) || EVENT_PRIORITY[a.kind] - EVENT_PRIORITY[b.kind])
  const extra = events.length - chosen.length
  if (extra > 0 && chosen.length) chosen[chosen.length - 1] = { ...chosen[chosen.length - 1]!, carry: extra }
  return chosen
}

/**
 * The moments between `previous` and `next`, by id: at most one per item (its highest priority),
 * capped at five with the rest carried, in launch order (oldest update first).
 */
export function nowEvents(previous: NowSummary | null, next: NowSummary | null): NowEvent[] {
  if (!previous || !next || previous === next) return []
  const before = nowItemsById(previous)
  const neededBefore = new Set(previous.needsYou.map((item) => item.id))
  const sessions = next.sessions.sessions
  const best = new Map<string, NowEvent>()
  const offer = (event: NowEvent) => {
    const current = best.get(event.id)
    if (!current || EVENT_PRIORITY[event.kind] < EVENT_PRIORITY[current.kind]) best.set(event.id, event)
  }
  for (const place of LISTS) {
    for (const item of next[place]) {
      const kind = itemMoment(before.get(item.id), item, place, neededBefore.has(item.id))
      if (kind) offer({ kind, id: item.id, at: item.declaredAt, origin: originFor(item, sessions) })
    }
  }
  const seen = new Set(previous.sessions.sessions.map((row) => row.id))
  for (const row of sessions) {
    if (seen.has(row.id) || row.phase !== "working") continue
    offer({ kind: "sessionStarted", id: row.id, at: row.lastSeenAt, origin: originFor({ id: row.id, computer: row.computer }) })
  }
  return capMoments([...best.values()])
}

/**
 * The page-open catch-up: what happened since the owner looked (failed, needing you, finished),
 * as up to five comets, only when the server's Since you looked has anything. Nothing new: none.
 */
export function catchUpEvents(summary: NowSummary | null): NowEvent[] {
  if (!summary) return []
  const since = summary.sinceYouLooked
  if (since.failed + since.finished + since.needsYou === 0) return []
  const sessions = summary.sessions.sessions
  const events: NowEvent[] = []
  for (const item of summary.needsYou) events.push({ kind: "needsYou", id: item.id, at: item.declaredAt, origin: originFor(item, sessions) })
  for (const item of summary.recent) {
    const state = item.owner.state
    if (state === "failed" || state === "done") events.push({ kind: state, id: item.id, at: item.declaredAt, origin: originFor(item, sessions) })
  }
  return capMoments(events)
}

/** One task's arc on the inner ring: its progress, whether it is moving, and when it started. */
export type NowArc = { id: string; progress: number | null; moving: boolean; startedAt: string }

/**
 * The running work's arcs, oldest first (a new task joins at the end, so the others keep their
 * place): moving work and work running quietly; stale work gets no arc.
 */
export function nowArcs(summary: NowSummary | null): NowArc[] {
  if (!summary) return []
  return summary.running
    .filter((item) => RUNNING_STATES.has(item.owner.state))
    .map((item) => ({
      id: item.id,
      progress: item.steps ? item.steps.done / item.steps.total : null,
      moving: item.owner.state === "moving",
      startedAt: item.startedAt,
    }))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id))
}

/** The list the server put an item in. */
export type NowPlace = (typeof LISTS)[number]

/** Where each item is in the summary, as the server placed it (read, never decided here). */
export function nowPlaces(summary: NowSummary | null): ReadonlyMap<string, NowPlace> {
  const map = new Map<string, NowPlace>()
  if (!summary) return map
  for (const place of LISTS) for (const item of summary[place]) map.set(item.id, place)
  return map
}
