import { describe, expect, it } from "vitest"

import {
  PARKED,
  afterLanding,
  easeMotion,
  easeToward,
  flyingSlots,
  landedSlots,
  pickCometSlot,
  shownMotion,
  type CometSlot,
} from "@/lib/orb-scene"
import { orbMotion } from "@/lib/orb-theme"

const calm = orbMotion(null, false)
const busy = orbMotion(
  { needsYou: [], running: [{ owner: { state: "moving" } }, { owner: { state: "moving" } }, { owner: { state: "moving" } }], quiet: [], sessions: { sessions: [] } },
  false
)

describe("the steady motion eases, never snaps", () => {
  it("moves about 63% of the way in one time constant (1.5 s)", () => {
    expect(easeToward(0, 1, 1.5)).toBeCloseTo(1 - Math.exp(-1))
    expect(easeToward(0.4, 0.4, 0.016)).toBe(0.4)
    expect(easeToward(0, 1, 0)).toBe(0)
  })

  it("rings stop over about 1.5 s when work stops, and reduced motion jumps", () => {
    let shown = shownMotion(busy)
    shown = easeMotion(shown, calm, 1.5)
    expect(shown.ringSpeed).toBeCloseTo(Math.exp(-1))
    for (let t = 0; t < 10; t += 0.05) shown = easeMotion(shown, calm, 0.05)
    expect(shown.ringSpeed).toBeLessThan(0.01)
    expect(shown.dust).toBeLessThan(0.001)
    expect(easeMotion(shownMotion(busy), calm, Infinity)).toEqual(shownMotion(calm))
  })
})

describe("comets on the deck fly only for real updates", () => {
  /** Now's deck: every slot parked, no decorative stream. */
  const deck = (): CometSlot[] => Array.from({ length: 9 }, () => ({ start: PARKED, duration: 3 }))

  it("no pulses: no comet ever launches", () => {
    const slots = deck()
    for (let now = 0; now < 600; now += 0.1) {
      expect(flyingSlots(slots, now)).toEqual([])
      expect(landedSlots(slots, now)).toEqual([])
    }
  })

  it("a landed comet parks on the deck (no stream); a decorative stream re-launches its slots", () => {
    expect(afterLanding(0, 0)).toBe("park")
    expect(afterLanding(3, 6)).toBe("respawn")
    expect(afterLanding(6, 6)).toBe("park")
  })

  it("a pulse takes a resting slot; when all are busy, the one closest to landing lands at once", () => {
    const slots = deck()
    slots[0] = { start: 0, duration: 3 }
    expect(pickCometSlot(slots, 1)).toEqual({ slot: 1, displaced: false })
    const busySlots: CometSlot[] = [
      { start: 0, duration: 3 },
      { start: 0.5, duration: 3 },
      { start: 2, duration: 3 },
    ]
    expect(pickCometSlot(busySlots, 2.5)).toEqual({ slot: 0, displaced: true })
    // A comet waiting for its launch delay is not resting.
    expect(pickCometSlot([{ start: 5, duration: 3 }, { start: PARKED, duration: 3 }], 1)).toEqual({ slot: 1, displaced: false })
  })

  it("a launched comet flies, then lands once", () => {
    const slots = deck()
    slots[2] = { start: 1, duration: 2.5 }
    expect(flyingSlots(slots, 0.5)).toEqual([])
    expect(flyingSlots(slots, 2)).toEqual([2])
    expect(landedSlots(slots, 3.6)).toEqual([2])
  })
})
