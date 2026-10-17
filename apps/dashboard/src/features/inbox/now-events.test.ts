import { describe, expect, it } from "vitest"
import { nowSummarySchema, type NowSummary } from "@relo/notification-contracts"

import fixtureText from "../../../../../packages/contracts/fixtures/owner-state-v1.json?raw"
import {
  MAX_NOW_EVENTS,
  capMoments,
  catchUpEvents,
  nowArcs,
  nowEvents,
  nowItemsById,
  nowPlaces,
  originFor,
  type NowEvent,
} from "@/features/inbox/now-events"

const summary: NowSummary = nowSummarySchema.parse(JSON.parse(fixtureText).nowSummary)
const later = (iso: string, seconds = 30) => new Date(new Date(iso).valueOf() + seconds * 1000).toISOString()
const kinds = (events: readonly NowEvent[]) => events.map((event) => event.kind)

/** The running item, moved by the server into another list with a new owner state. */
function moved(to: "needsYou" | "recent", state: "needs_you" | "done" | "failed"): NowSummary {
  const next = structuredClone(summary)
  const item = next.running.shift()!
  item.owner = { ...item.owner, state, needsYou: state === "needs_you" ? "question" : null }
  next[to] = [item, ...next[to]]
  return next
}

/** The fixture with its running item changed in place. */
function runningChanged(change: (item: NowSummary["running"][number]) => void): NowSummary {
  const next = structuredClone(summary)
  change(next.running[0]!)
  return next
}

/** A copy of the running item under a new id. */
function newRunning(suffix: string, change: (item: NowSummary["running"][number]) => void = () => {}) {
  const item = structuredClone(summary.running[0]!)
  item.id = `act_00000000-0000-4000-8000-0000000009${suffix.padStart(2, "0")}`
  change(item)
  return item
}

describe("Now moments (display only, from two server summaries)", () => {
  it("the first summary, the same summary and a refetch with no diff fire nothing", () => {
    expect(nowEvents(null, summary)).toEqual([])
    expect(nowEvents(summary, summary)).toEqual([])
    expect(nowEvents(summary, structuredClone(summary))).toEqual([])
  })

  it("an item newly needing the owner is a needsYou moment", () => {
    const [event] = nowEvents(summary, moved("needsYou", "needs_you"))
    expect(event).toMatchObject({ kind: "needsYou", id: summary.running[0]!.id, at: summary.running[0]!.declaredAt })
    expect(typeof event!.origin).toBe("number")
  })

  it("work newly finished or failed is a done or failed moment; already-settled rows are not", () => {
    expect(kinds(nowEvents(summary, moved("recent", "done")))).toEqual(["done"])
    expect(kinds(nowEvents(summary, moved("recent", "failed")))).toEqual(["failed"])
  })

  it("a new card running is started; a step advanced is step; a declared update alone is update", () => {
    const started = structuredClone(summary)
    started.running.push(newRunning("1"))
    expect(nowEvents(summary, started)).toMatchObject([{ kind: "started", id: newRunning("1").id }])

    const step = runningChanged((item) => {
      item.steps = { ...item.steps!, done: item.steps!.done + 1 }
      item.declaredAt = later(item.declaredAt)
    })
    expect(kinds(nowEvents(summary, step))).toEqual(["step"])

    const update = runningChanged((item) => {
      item.status = "Running the gates again"
      item.declaredAt = later(item.declaredAt)
    })
    expect(kinds(nowEvents(summary, update))).toEqual(["update"])
  })

  it("quiet work moving again is recovered; a new working session is sessionStarted", () => {
    const quietBefore = runningChanged((item) => {
      item.owner = { ...item.owner, state: "working_quietly" }
    })
    expect(kinds(nowEvents(quietBefore, summary))).toEqual(["recovered"])

    const session = structuredClone(summary)
    session.sessions.sessions.push({ ...session.sessions.sessions[0]!, id: "ags_00000000-0000-4000-8000-000000000099", phase: "working", waitingFor: null, workId: null })
    expect(nowEvents(summary, session)).toMatchObject([{ kind: "sessionStarted", id: "ags_00000000-0000-4000-8000-000000000099" }])
  })

  it("no comet for going quiet, a session ending, or only evidence and last-seen instants moving", () => {
    const quiet = structuredClone(summary)
    const item = quiet.running.shift()!
    item.owner = { ...item.owner, state: "stale" }
    quiet.quiet.push(item)
    expect(nowEvents(summary, quiet)).toEqual([])

    const evidence = runningChanged((entry) => {
      entry.owner = { ...entry.owner, evidenceAt: later(entry.owner.evidenceAt, 90) }
    })
    expect(nowEvents(summary, evidence)).toEqual([])

    const seen = structuredClone(summary)
    for (const row of seen.sessions.sessions) row.lastSeenAt = later(row.lastSeenAt, 90)
    expect(nowEvents(summary, seen)).toEqual([])

    const ended = structuredClone(summary)
    ended.sessions.sessions[0] = { ...ended.sessions.sessions[0]!, phase: "ended", waitingFor: null }
    expect(nowEvents(summary, ended)).toEqual([])
    const gone = structuredClone(summary)
    gone.sessions.sessions.shift()
    expect(nowEvents(summary, gone)).toEqual([])
  })

  it("at most one comet per item: its highest-priority change", () => {
    const next = moved("recent", "done")
    next.recent[0]!.declaredAt = later(next.recent[0]!.declaredAt)
    expect(kinds(nowEvents(summary, next))).toEqual(["done"])
  })

  it("caps a burst at five by priority, launches oldest first, and the last carries the rest", () => {
    const next = moved("recent", "done")
    const template = next.needsYou[0]!
    next.needsYou = ["a", "b", "c", "d", "e", "f"].map((_, index) => ({
      ...template,
      id: `${template.id.slice(0, -2)}${index}${index}`,
      declaredAt: later(template.declaredAt, 60 - index * 10),
    }))
    const events = nowEvents(summary, next)
    expect(events).toHaveLength(MAX_NOW_EVENTS)
    expect(events.every((event) => event.kind === "needsYou")).toBe(true)
    expect(events.map((event) => event.at)).toEqual([...events.map((event) => event.at)].sort())
    // Six needs-you and one done were due: the fifth comet carries two more.
    expect(events.at(-1)!.carry).toBe(2)
    expect(events.slice(0, -1).every((event) => event.carry === undefined)).toBe(true)
  })

  it("orders the priority needs you > failed > finished > started > recovered > step > session > status", () => {
    const at = "2026-10-14T10:00:00.000Z"
    const all: NowEvent[] = (["update", "sessionStarted", "step", "recovered", "started", "done", "failed", "needsYou"] as const).map((kind, index) => ({
      kind,
      id: `id-${index}`,
      at,
      origin: 0,
    }))
    expect(kinds(capMoments(all)).sort()).toEqual(["done", "failed", "needsYou", "recovered", "started"])
    expect(capMoments(all).at(-1)!.carry).toBe(3)
  })

  it("agent work comes from its computer's sector, scripts from below, services from above", () => {
    const sessions = summary.sessions.sessions
    const session = sessions.find((row) => row.computer)!
    const a = originFor({ id: "act_a", producer: "agent_session", sessionId: session.id }, sessions)
    const b = originFor({ id: "act_b", producer: "agent_session", sessionId: session.id }, sessions)
    // The same computer: the same sector, within ±20° of its centre.
    expect(Math.abs(a - b)).toBeLessThanOrEqual((40 * Math.PI) / 180 + 1e-9)
    expect(originFor({ id: "act_a", producer: "agent_session", sessionId: session.id }, sessions)).toBe(a)
    const script = originFor({ id: "act_s", producer: "script" })
    expect(Math.abs(script + Math.PI / 2)).toBeLessThanOrEqual((20 * Math.PI) / 180 + 1e-9)
    const service = originFor({ id: "act_v", producer: "service" })
    expect(Math.abs(service - Math.PI / 2)).toBeLessThanOrEqual((20 * Math.PI) / 180 + 1e-9)
  })

  it("indexes every item and the list the server put it in", () => {
    const places = nowPlaces(summary)
    for (const item of summary.needsYou) expect(places.get(item.id)).toBe("needsYou")
    for (const item of summary.recent) expect(places.get(item.id)).toBe("recent")
    for (const item of summary.quiet) expect(places.get(item.id)).toBe("quiet")
    expect(nowItemsById(summary).get(summary.running[0]!.id)).toBe(summary.running[0])
  })
})

describe("the page-open catch-up", () => {
  it("bursts what happened since the owner looked: failed, needing you, finished", () => {
    expect(kinds(catchUpEvents(summary)).sort()).toEqual(["done", "failed", "needsYou"])
  })

  it("nothing new since the owner looked: no burst", () => {
    const quiet = structuredClone(summary)
    quiet.sinceYouLooked = { ...quiet.sinceYouLooked, finished: 0, failed: 0, needsYou: 0 }
    expect(catchUpEvents(quiet)).toEqual([])
    expect(catchUpEvents(null)).toEqual([])
  })
})

describe("arcs", () => {
  it("one per running task (moving or quiet), oldest first; stale work gets none", () => {
    const next = structuredClone(summary)
    next.running.unshift(newRunning("2", (item) => {
      item.startedAt = later(item.startedAt, 600)
      item.owner = { ...item.owner, state: "working_quietly" }
      item.steps = null
    }))
    const arcs = nowArcs(next)
    expect(arcs.map((arc) => arc.id)).toEqual([summary.running[0]!.id, newRunning("2").id])
    expect(arcs[0]).toMatchObject({ moving: true, progress: summary.running[0]!.steps!.done / summary.running[0]!.steps!.total })
    expect(arcs[1]).toMatchObject({ moving: false, progress: null })
    for (const item of summary.quiet) expect(arcs.some((arc) => arc.id === item.id)).toBe(false)
  })
})
