import { describe, expect, it } from "vitest"
import { centreOf, deckInput, fleetOf, gaugesOf, leadOf, orbMoodOf, satPhase, satellitesOf, seedOf, SLOTS, type DeckInput } from "./deck"
import { loadSnapshot } from "../relo/fixtures"
import { presentationOf } from "../relo/presentation"

const input = (over: Partial<DeckInput> = {}): DeckInput => ({ connection: "live", lastUpdated: 1, needsYou: 0, waiting: 0, running: 0, sessionCount: 0, ...over })

describe("the lead (ReloNowHero.lead)", () => {
  it("orders the system layer before the work layer, most urgent first", () => {
    expect(leadOf(input({ connection: "offline", needsYou: 2 }))).toBe("offline")
    expect(leadOf(input({ lastUpdated: null }))).toBe("connecting")
    expect(leadOf(input({ needsYou: 1, waiting: 2, running: 3 }))).toBe("needsYou")
    expect(leadOf(input({ waiting: 2, running: 3 }))).toBe("yourTurn")
    expect(leadOf(input({ running: 1 }))).toBe("running")
    expect(leadOf(input({ sessionCount: 2 }))).toBe("quiet")
    expect(leadOf(input())).toBe("clear")
  })
  it("the orb treats the owner's turn as an ask, and sessions as running", () => {
    expect(orbMoodOf(input({ waiting: 1 }))).toBe("needsYou")
    expect(orbMoodOf(input({ sessionCount: 1 }))).toBe("running")
    expect(orbMoodOf(input())).toBe("clear")
  })
  it("the centre counts the lead and never alternates", () => {
    expect(centreOf("needsYou", input({ needsYou: 3 }))).toEqual({ value: "3", label: "NEEDS YOU" })
    expect(centreOf("quiet", input({ sessionCount: 2 }))).toEqual({ value: "2", label: "SESSIONS" })
    expect(centreOf("clear", input())).toEqual({ value: null, label: "ALL CLEAR" })
  })
})

describe("gauges and slots", () => {
  it("fills needs and turn out of 5, sessions out of 6, running by mean progress (0.5 unknown)", () => {
    const g = gaugesOf(input({ needsYou: 1, waiting: 0, running: 2, sessionCount: 3 }), [0.2, 0.6])
    expect(g.needsYou).toEqual({ fill: 0.2, lit: true })
    expect(g.yourTurn.lit).toBe(false)
    expect(g.running.fill).toBeCloseTo(0.4)
    expect(g.sessions).toEqual({ fill: 0.5, lit: true })
    expect(gaugesOf(input({ running: 1 }), []).running.fill).toBe(0.5)
  })
  it("docks the four readouts clockwise from the upper left", () => {
    expect(SLOTS.map((s) => s.angle)).toEqual([225, 315, 45, 135])
    expect(SLOTS.filter((s) => s.leading).map((s) => s.slot)).toEqual(["needsYou", "sessions"])
  })
})

describe("sessions on the orbit", () => {
  it("maps phases the way the iPhone does", () => {
    expect(satPhase({ phase: "waiting", waitingFor: "input", hasCard: false })).toBe("needsYou")
    expect(satPhase({ phase: "waiting", waitingFor: "turn", hasCard: false })).toBe("yourTurn")
    expect(satPhase({ phase: "working", waitingFor: null, hasCard: true })).toBe("running")
    expect(satPhase({ phase: "working", waitingFor: null, hasCard: false })).toBe("quiet")
    expect(satPhase({ phase: "idle", waitingFor: null, hasCard: false })).toBeNull()
  })
  it("parks the first your-turn session and orbits the rest, quiet ones slowly", () => {
    const s = [
      { id: "a", phase: "yourTurn" as const, computer: "PC", source: "codex" },
      { id: "b", phase: "quiet" as const, computer: "PC", source: "codex" },
      { id: "c", phase: "running" as const, computer: "Mac", source: "claude" },
    ]
    const { orbiting, parked } = satellitesOf(s)
    expect(parked).toBe(true)
    expect(orbiting.map((o) => [o.id, o.period])).toEqual([["b", 160], ["c", 52]])
    expect(fleetOf(s, ["Old"]).map((m) => [m.name, m.lead, m.idle])).toEqual([["PC", "yourTurn", false], ["Mac", "running", false], ["Old", "quiet", true]])
  })
  it("seeds a stable angle", () => {
    expect(seedOf("abc")).toBe(seedOf("abc"))
    expect(seedOf("abc")).not.toBe(seedOf("abd"))
  })
})

describe("from a snapshot", () => {
  it("reads the counts off the presentation", () => {
    const p = presentationOf(loadSnapshot("owner-state-v1")!.summary)
    const d = deckInput(p, "live", 1)
    expect(d.needsYou).toBe(p.needsYouCount)
    expect(leadOf(d)).not.toBe("connecting")
  })
})
