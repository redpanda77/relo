import { describe, expect, it } from "vitest"
import { COLORS as UI_COLORS, toneColor as uiToneColor } from "../ui/theme"
import { Ease } from "./ease"
import { closedWidth, markSide, sceneOf, wingContentWidth } from "./scene"
import { AURORA, CLOSED_METRICS, COLORS, GLASS, MOTION, ORB_ENERGY, ORB_PALETTE, toneColor, TONE_SYMBOL } from "./theme"
import { unit } from "./painter"
import { PLASMA_FRAGMENT } from "./PlasmaOrb"
import { WING_LIGHT_FRAGMENT, wingLightFactor } from "./wing-light"
import { EMPTY, type Presentation } from "../presentation"

/** Swift Color(red: r / 255, ...) literals to "#rrggbb". */
const hex = (r: number, g: number, b: number) => "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")

describe("colour tokens (ReloNotchTheme.swift)", () => {
  it("matches every literal, line by line", () => {
    expect(COLORS.mint).toBe(hex(0x34, 0xd3, 0x99)) // :14
    expect(COLORS.orange).toBe(hex(1 * 255, 0x8a, 0x3d)) // :15
    expect(COLORS.yellow).toBe(hex(0xfa, 0xcc, 0x15)) // :16
    expect(COLORS.red).toBe(hex(0xf4, 0x3f, 0x5e)) // :17
    expect(COLORS.violet).toBe(hex(0x8b, 0x7c, 255)) // :18
    expect(COLORS.sky).toBe(hex(0x7d, 0xd3, 0xfc)) // :19
    expect(COLORS.azure).toBe(hex(0x38, 0xbd, 0xf8)) // :20
    expect(COLORS.blue).toBe(hex(0x4d, 0x8d, 255)) // :21
    expect(COLORS.coral).toBe(hex(255, 0x6b, 0x57)) // :22
    expect(COLORS.amber).toBe(hex(0xfb, 0xbf, 0x24)) // :23
    expect(COLORS.emerald).toBe(hex(0x10, 0xb9, 0x81)) // :24
    expect(COLORS.running).toBe(hex(0x8b, 0x7c, 255)) // :27
    expect(COLORS.runningSoft).toBe(hex(0xc4, 0xbb, 255)) // :29
    expect(COLORS.cyan).toBe(hex(0x5c, 0xe1, 255)) // :31
    expect(COLORS.ice).toBe(hex(0xe4, 0xf9, 255)) // :32
    expect(COLORS.signalCoral).toBe(hex(255, 0x7a, 0x66)) // :35
    expect(COLORS.done).toBe(hex(0x34, 0xd3, 0x99)) // :36
    expect(COLORS.info).toBe(hex(0x94, 0xa3, 0xb8)) // :37
    expect(COLORS.warning).toBe(hex(0xfb, 0xbf, 0x24)) // :38
    expect(COLORS.problem).toBe(hex(0xf8, 0x71, 0x71)) // :39
    expect(COLORS.quiet).toBe(hex(Math.round(0.42 * 255), Math.round(0.42 * 255), Math.round(0.42 * 255))) // ReloOrbitWings.swift:193
    expect(COLORS.secondaryText).toBe("rgb(255 255 255 / 0.6)")
    expect(COLORS.tertiaryText).toBe("rgb(255 255 255 / 0.4)")
  })

  it("maps each tone to the iPhone's colour and symbol (:44-70)", () => {
    expect(toneColor("needsYou")).toBe(COLORS.signalCoral)
    expect(toneColor("yourTurn")).toBe(COLORS.signalCoral)
    expect(toneColor("working")).toBe(COLORS.running)
    expect(toneColor("dropped")).toBe(COLORS.warning)
    expect(toneColor("leftUnfinished")).toBe(COLORS.warning)
    expect(toneColor("quiet")).toBe(COLORS.info)
    expect(toneColor("paused")).toBe(COLORS.info)
    expect(toneColor("done")).toBe(COLORS.done)
    expect(toneColor("failed")).toBe(COLORS.problem)
    expect(TONE_SYMBOL.needsYou).toBe("exclamationmark.bubble.fill")
    expect(TONE_SYMBOL.failed).toBe("xmark.octagon.fill")
  })

  it("keeps the old import path alive", () => {
    expect(UI_COLORS).toBe(COLORS)
    expect(uiToneColor).toBe(toneColor)
  })

  it("orb palettes and energy per mood (ReloOrb.swift)", () => {
    expect(ORB_PALETTE.clear).toEqual(["#5ce1ff", "#4d8dff", "#8b7cff"])
    expect(ORB_PALETTE.running).toEqual(["#5ce1ff", "#7dd3fc", "#38bdf8"])
    expect(ORB_PALETTE.needsYou).toEqual(["#ff8a3d", "#ff6b57", "#fbbf24"])
    expect(ORB_ENERGY).toEqual({ clear: 0.35, running: 0.7, needsYou: 1 })
  })

  it("aurora, glass and motion tokens", () => {
    expect(AURORA.blobAlpha).toBe(0.5)
    expect(AURORA.blobs.map((b) => b.size)).toEqual([0.95, 0.72, 0.6])
    expect(AURORA.driftSeconds).toBe(11)
    expect(GLASS.radius).toBe(20)
    expect([GLASS.fillTop, GLASS.fillBottom, GLASS.hairline, GLASS.topLight]).toEqual([0.085, 0.03, 0.13, 0.2])
    expect(MOTION.snappy).toEqual({ type: "spring", duration: 0.28, bounce: 0.14 })
  })

  it("closed metrics: corner radii 6/14, outer 6, gap 8, orbit 58 (matters.swift:63, ReloClosedActivity.swift:93-100)", () => {
    expect(CLOSED_METRICS).toMatchObject({ cornerTop: 6, cornerBottom: 14, outer: 6, gap: 8, orbit: 58, maxSegments: 8, maxSatellites: 6 })
  })
})

describe("closed sizing (ReloWing, ReloSnapshot.swift:132)", () => {
  const live: Presentation = {
    ...EMPTY,
    focus: { id: "a" } as Presentation["focus"],
  }
  it("a 32 high notch has a 20 mark; live wings are 58, resting ones the mark", () => {
    expect(markSide(32)).toBe(20)
    expect(wingContentWidth(live, 20)).toBe(58)
    expect(wingContentWidth(EMPTY, 20)).toBe(20)
  })
  it("the whole width: 2 (wing + 6 + 8) + 185 - 6 + 28", () => {
    expect(closedWidth(live, 32)).toBe(2 * (58 + 14) + 185 - 6 + 28)
    expect(closedWidth(EMPTY, 32)).toBe(2 * (20 + 14) + 185 - 6 + 28)
  })
  it("a rest scene has no satellites", () => {
    const s = sceneOf(EMPTY, false, 0)
    expect(s.lead).toBe("rest")
    expect(s.satellites).toEqual([])
  })
})

describe("easing (ReloOrbitWings.swift Ease)", () => {
  it("matches the closed forms", () => {
    expect(Ease.out(0.5)).toBeCloseTo(0.875, 10)
    expect(Ease.inOut(0.25)).toBeCloseTo(4 * 0.25 ** 3, 10)
    expect(Ease.inOut(0.75)).toBeCloseTo(1 - 0.5 ** 3 / 2, 10)
    expect(Ease.outBack(1)).toBeCloseTo(1, 10)
    expect(Ease.spring(0)).toBe(0)
    expect(Ease.decay(1, 2)).toBe(0)
    expect(Ease.decay(3, 2, 3)).toBeCloseTo(Math.exp(-3), 10)
    expect(Ease.seg(5, 0, 10)).toBe(0.5)
  })
  it("hashes a satellite id with FNV-1a into 0...1, stably", () => {
    expect(unit("session-0")).toBe(unit("session-0"))
    expect(unit("a")).toBeGreaterThanOrEqual(0)
    expect(unit("a")).toBeLessThan(1)
    expect(unit("a")).not.toBe(unit("b"))
  })
})

describe("shaders", () => {
  it("the wing light keeps the Metal constants", () => {
    for (const k of ["127.1", "311.7", "34.23", "2.07", "13.7, 5.3", "0.05", "0.42", "0.11", "0.06", "0.45 + 1.1"]) expect(WING_LIGHT_FRAGMENT).toContain(k)
  })
  it("its factor stays in the Metal range (0.45 ... 1.55) and flows with time", () => {
    const values = Array.from({ length: 50 }, (_, i) => wingLightFactor(10 + i * 3, 4 + (i % 7) * 4, 351, i * 0.37))
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0.45)
      expect(v).toBeLessThanOrEqual(1.55)
    }
    expect(wingLightFactor(12, 8, 351, 0)).not.toBeCloseTo(wingLightFactor(12, 8, 351, 3), 3)
  })
  it("the plasma orb keeps the Metal constants", () => {
    for (const k of ["123.34, 456.21", "45.32", "2.03", "17.1, 9.2", "0.06", "5.5 - 2.0", "0.66", "1.35", "6.2831853", "0.45, -0.55, 0.7", "0.38, 1.0", "0.82 + 0.18"]) expect(PLASMA_FRAGMENT).toContain(k)
  })
})
