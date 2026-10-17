import { describe, expect, it } from "vitest"
import { nowSummarySchema, type NowSummary } from "@relo/notification-contracts"

import fixtureText from "../../../../packages/contracts/fixtures/owner-state-v1.json?raw"
import {
  DECORATIVE_MOTION,
  MAX_IMPACT,
  NEEDS_YOU_GLOW,
  cometFor,
  deckState,
  orbMotion,
  orbTheme,
  toward,
} from "@/lib/orb-theme"
import { SIGNAL_CSS } from "@/lib/signal"

const fixture: NowSummary = nowSummarySchema.parse(JSON.parse(fixtureText).nowSummary)

/** A summary with the given owner states running or quiet, sessions, and needs-you count. */
function day({
  running = [] as string[],
  quiet = [] as string[],
  sessions = [] as { phase: string | null; workId: string | null }[],
  needsYou = 0,
}) {
  const item = (state: string) => ({ owner: { state } })
  return {
    needsYou: Array.from({ length: needsYou }, () => item("needs_you")),
    running: running.map(item),
    quiet: quiet.map(item),
    sessions: { sessions },
  }
}

const css = (signal: keyof typeof SIGNAL_CSS) => SIGNAL_CSS[signal].toLowerCase()

describe("the core's motion follows the server's summary", () => {
  it("is calm when nothing is moving: barely drifting plasma, still rings and dust, a shallow breath", () => {
    const motion = orbMotion(day({}), false)
    expect(motion).toMatchObject({ level: 0, mode: "calm", plasmaRate: 0.06, displacement: 0.01, ringSpeed: 0, dust: 0 })
    expect(motion.breath).toEqual({ depth: 0.35, period: 4000 })
    // Finished, failed and waiting work moves nothing.
    expect(orbMotion(null, false).mode).toBe("calm")
  })

  it("moves with the level: moving work, quiet work at 0.4, card-less working sessions at 0.5, over 3", () => {
    const one = orbMotion(day({ running: ["moving"] }), false)
    expect(one.mode).toBe("moving")
    expect(one.level).toBeCloseTo(1 / 3)
    expect(one.plasmaRate).toBeCloseTo(0.55 + 0.9 / 3)
    expect(one.displacement).toBeCloseTo(0.02 + 0.015 / 3)
    expect(one.ringSpeed).toBeCloseTo(1 / 3)
    expect(one.dust).toBe(0.012)
    expect(one.breath).toEqual({ depth: 1, period: 4000 })
    const mixed = orbMotion(
      day({ running: ["moving", "working_quietly"], sessions: [{ phase: "working", workId: null }, { phase: "working", workId: "act_x" }, { phase: "idle", workId: null }] }),
      false
    )
    expect(mixed.level).toBeCloseTo((1 + 0.4 + 0.5) / 3)
    expect(orbMotion(day({ running: ["moving", "moving", "moving", "moving"] }), false).level).toBe(1)
    // A session working without a card moves the core on its own.
    expect(orbMotion(day({ sessions: [{ phase: "working", workId: null }] }), false).mode).toBe("moving")
  })

  it("quiet work alone churns slowly with still rings and dust and a slower, shallower breath", () => {
    for (const summary of [day({ quiet: ["stale"] }), day({ running: ["working_quietly"] }), day({ quiet: ["stopped_responding", "no_signal"] })]) {
      const motion = orbMotion(summary, false)
      expect(motion).toMatchObject({ mode: "quiet", basis: "quiet", plasmaRate: 0.15, displacement: 0.012, ringSpeed: 0, dust: 0 })
      expect(motion.breath).toEqual({ depth: 0.5, period: 8000 })
    }
  })

  it("needs you with nothing moving stays calm in motion, breathes fully, and turns orange", () => {
    const motion = orbMotion(day({ needsYou: 1 }), false)
    expect(motion).toMatchObject({ level: 0, mode: "calm", plasmaRate: 0.06, ringSpeed: 0, dust: 0 })
    expect(motion.breath).toEqual({ depth: 1, period: 4000 })
    // A connection request needs the owner too.
    expect(orbMotion(day({}), false, 1).breath.depth).toBe(1)
    const theme = orbTheme({}, deckState(1, motion))
    expect(theme.colors[0]).toBe("#ff8a3d")
    expect(theme.glow).toBe(NEEDS_YOU_GLOW)
  })

  it("offline overrides everything: calm motion and colours 40% toward grey", () => {
    const motion = orbMotion(day({ running: ["moving", "moving"], needsYou: 1 }), true)
    expect(motion).toMatchObject({ mode: "offline", basis: "moving", level: 0, plasmaRate: 0.06, ringSpeed: 0, dust: 0 })
    expect(motion.breath.depth).toBe(0.35)
    const theme = orbTheme({}, deckState(0, motion), { offline: true })
    expect(theme.colors[0]).toBe(toward("#5ce1ff", 0.4))
  })

  it("reads the canonical fixture: one moving card is moving", () => {
    expect(orbMotion(fixture, false).mode).toBe("moving")
  })

  it("the decorative stage (sign-in, loading) keeps the landing's lively core", () => {
    expect(DECORATIVE_MOTION).toMatchObject({ ringSpeed: 1, displacement: 0.035, dust: 0.012 })
    expect(DECORATIVE_MOTION.plasmaRate).toBeCloseTo(1.18)
  })
})

describe("the core's colours", () => {
  it("paints each state as one analogous ramp, today's biggest other meaning on the peaks", () => {
    expect(orbTheme({}, "running").colors).toEqual([css("running"), "#8b7cff", "#d65cf0"])
    expect(orbTheme({ done: 5, message: 3, running: 1 }, "running").colors).toEqual([css("running"), "#8b7cff", css("done")])
    expect(orbTheme({}, "needsYou").colors[0]).toBe(css("needsYou"))
    expect(orbTheme({}, "clear").colors[0]).toBe(css("done"))
  })

  it("follows the motion: calm is mint, moving and quiet are cyan, quiet desaturated 30%", () => {
    expect(deckState(0, orbMotion(day({}), false))).toBe("clear")
    expect(deckState(0, orbMotion(day({ running: ["moving"] }), false))).toBe("running")
    expect(deckState(0, orbMotion(day({ quiet: ["stale"] }), false))).toBe("running")
    expect(orbTheme({}, "running", { quiet: true }).colors[0]).toBe(toward("#5ce1ff", 0.3))
    expect(toward("#5ce1ff", 0)).toBe("#5ce1ff")
    const grey = toward("#5ce1ff", 1)
    expect(grey.slice(1, 3)).toBe(grey.slice(3, 5))
  })
})

describe("comets", () => {
  it("each moment has its look and weight", () => {
    expect(cometFor("needsYou")).toMatchObject({ color: "#ff8a3d", kind: "needsYou", impact: 1.6 })
    expect(cometFor("failed")).toMatchObject({ kind: "failed", impact: 0.9 })
    expect(cometFor("done")).toMatchObject({ kind: "done", impact: 1 })
    expect(cometFor("started")).toMatchObject({ arc: "grow", size: 1 })
    expect(cometFor("step")).toMatchObject({ arc: "advance", size: 0.7, impact: 0.6 })
    expect(cometFor("update")).toMatchObject({ color: "#bff3ff", trailScale: 0.5, impact: 0.4 })
    expect(cometFor("recovered").impact).toBe(0.8)
    expect(cometFor("sessionStarted")).toMatchObject({ size: 0.7, impact: 0.5 })
  })

  it("a comet carrying more lands harder, capped", () => {
    expect(cometFor("done", 2).impact).toBeCloseTo(1.3)
    expect(cometFor("done", 10).impact).toBe(MAX_IMPACT)
  })
})
