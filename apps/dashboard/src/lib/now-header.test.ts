import type { SessionRow } from "@relo/notification-contracts"
import { describe, expect, it } from "vitest"

import { fleetOf, gaugeFractions, headerCentre, headerState, satellitesOf, tailOf } from "@/lib/now-header"

const base = { connecting: false, offline: false, needsYou: 0, waiting: 0, running: 0, sessionsLive: 0 }
const row = (over: Partial<SessionRow>, i = 0) =>
  ({
    id: `ags_00000000-0000-4000-8000-00000000000${i}`, source: "claude-code", project: null, computer: "MacBook", phase: "working", observed: true,
    waitingFor: null, lastSeenAt: "2026-10-14T10:00:00.000Z", fold: null, workId: null, nextChangeAt: null, ...over,
  }) as SessionRow

describe("the header state", () => {
  it("is connecting without a summary, offline after a failed refetch, then the owner's priority", () => {
    expect(headerState({ ...base, connecting: true, offline: true, needsYou: 2 })).toBe("connecting")
    expect(headerState({ ...base, offline: true, needsYou: 2 })).toBe("offline")
    expect(headerState({ ...base, needsYou: 1, waiting: 1, running: 1, sessionsLive: 3 })).toBe("needs")
    expect(headerState({ ...base, waiting: 1, running: 1, sessionsLive: 3 })).toBe("turn")
    expect(headerState({ ...base, running: 1, sessionsLive: 3 })).toBe("running")
    expect(headerState({ ...base, sessionsWorking: 1, sessionsLive: 1 })).toBe("running")
    expect(headerState({ ...base, sessionsLive: 2 })).toBe("quiet")
    expect(headerState(base)).toBe("clear")
  })

  it("holds one centre: a count for the live states, the wordmark for clear, offline and connecting", () => {
    const n = { needsYou: 2, waiting: 3, running: 4, sessionsWorking: 1, sessionsLive: 5 }
    expect(headerCentre("needs", n)).toEqual({ kind: "count", value: 2, label: "Needs you" })
    expect(headerCentre("turn", n)).toEqual({ kind: "count", value: 3, label: "Your turn" })
    expect(headerCentre("running", n)).toEqual({ kind: "count", value: 4, label: "Running" })
    expect(headerCentre("running", { ...n, running: 0 })).toEqual({ kind: "count", value: 1, label: "Sessions" })
    expect(headerCentre("quiet", n)).toEqual({ kind: "count", value: 5, label: "Sessions" })
    expect(headerCentre("clear", n)).toEqual({ kind: "word", label: "All clear" })
    expect(headerCentre("offline", n)).toEqual({ kind: "word", label: "Offline" })
    expect(headerCentre("connecting", n)).toEqual({ kind: "word", label: "Connecting" })
  })
})

describe("the gauge, satellites and fleet", () => {
  it("fills v/5 (sessions v/6) and running 0.66 or the cards' mean", () => {
    expect(gaugeFractions({ needs: 2, turn: 9, running: 1, sessions: 3 })).toEqual({ needs: 0.4, turn: 1, running: 0.66, sessions: 0.5 })
    expect(gaugeFractions({ needs: 0, turn: 0, running: 2, sessions: 0 }, [0.2, 0.6, null]).running).toBeCloseTo(0.4)
  })

  it("puts a satellite on every live session, parks your turn, and gives quiet the slow orbit", () => {
    const rows = [row({ phase: "waiting", waitingFor: "input" }, 1), row({ phase: "waiting", waitingFor: "turn" }, 2), row({ phase: null }, 3), row({ phase: "idle", fold: "idle" }, 4), row({}, 5)]
    const { orbiting, parked, live } = satellitesOf(rows)
    expect(live).toBe(4)
    expect(parked).toBe(true)
    expect(orbiting.map((s) => [s.phase, s.duration])).toEqual([["needs", 38], ["quiet", 160], ["running", 60]])
    expect(tailOf(false)).toHaveLength(10)
  })

  it("lists each machine with its most urgent phase and harness counts; idle machines have none", () => {
    const rows = [
      row({ phase: "working" }, 1),
      row({ phase: "waiting", waitingFor: "input", source: "codex" }, 2),
      row({ computer: "Build", phase: "idle", fold: "idle" }, 3),
    ]
    expect(fleetOf(rows)).toEqual([
      { key: "MacBook", name: "MacBook", phase: "needs", harnesses: [{ tool: "claude", count: 1 }, { tool: "codex", count: 1 }] },
      { key: "Build", name: "Build", phase: null, harnesses: [] },
    ])
  })
})
