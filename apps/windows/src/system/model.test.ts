import { describe, expect, it } from "vitest"
import { batteryGlyph, formatBytes, formatRate, HISTORY_LENGTH, memoryShare, percent, pushHistory, sparkPoints, storageShare, EMPTY_SAMPLE } from "./model"

describe("history", () => {
  it("the first reading fills the graph", () => {
    const h = pushHistory([], 0.4)
    expect(h).toHaveLength(HISTORY_LENGTH)
    expect(new Set(h)).toEqual(new Set([0.4]))
  })

  it("keeps two minutes", () => {
    let h: number[] = []
    for (let i = 0; i < 100; i++) h = pushHistory(h, i / 100)
    expect(h).toHaveLength(HISTORY_LENGTH)
    expect(h[h.length - 1]).toBe(0.99)
  })
})

describe("formatting", () => {
  it("formats bytes like ByteCountFormatter", () => {
    expect(formatBytes(0)).toBe("Zero KB")
    expect(formatBytes(512)).toBe("512 bytes")
    expect(formatBytes(2048)).toBe("2 KB")
    expect(formatBytes(512 * 1024 ** 2)).toBe("512 MB")
    expect(formatBytes(15.43 * 1024 ** 3)).toBe("15.4 GB")
    expect(formatBytes(8 * 1024 ** 3)).toBe("8 GB")
    expect(formatBytes(-5)).toBe("Zero KB")
    expect(formatRate(2 * 1024 ** 2)).toBe("2 MB/s")
  })

  it("rounds percentages", () => {
    expect(percent(0.346)).toBe("35%")
    expect(percent(1)).toBe("100%")
  })

  it("shares of memory and storage", () => {
    const s = { ...EMPTY_SAMPLE, memoryUsed: 4, memoryTotal: 16, storageFree: 25, storageTotal: 100 }
    expect(memoryShare(s)).toBe(0.25)
    expect(storageShare(s)).toBe(0.75)
    expect(memoryShare(EMPTY_SAMPLE)).toBe(0)
    expect(storageShare(EMPTY_SAMPLE)).toBe(0)
  })
})

describe("battery glyph", () => {
  it("steps at the Mac's thresholds", () => {
    expect(batteryGlyph(0.1, false)).toBe("empty")
    expect(batteryGlyph(0.2, false)).toBe("quarter")
    expect(batteryGlyph(0.5, false)).toBe("half")
    expect(batteryGlyph(0.7, false)).toBe("threeQuarters")
    expect(batteryGlyph(0.95, false)).toBe("full")
    expect(batteryGlyph(0.1, true)).toBe("charging")
  })
})

describe("sparkline", () => {
  it("needs two points", () => {
    expect(sparkPoints([0.5], 100, 20)).toEqual([])
  })

  it("puts the newest at the right edge and 0..1 within the box", () => {
    const pts = sparkPoints(pushHistory([], 0.5), 118, 20)
    expect(pts).toHaveLength(HISTORY_LENGTH)
    expect(pts[0]!.x).toBeCloseTo(0)
    expect(pts[pts.length - 1]!.x).toBeCloseTo(118)
    expect(pts[0]!.y).toBeCloseTo(20 - 1 - 18 * 0.5)
  })

  it("scales to its own peak when relative", () => {
    const pts = sparkPoints([0, 50, 100], 100, 11, true)
    expect(pts[2]!.y).toBeCloseTo(1)
    expect(pts[1]!.y).toBeCloseTo(10 - 9 * 0.5)
    // a young history sits at the right
    expect(pts[0]!.x).toBeGreaterThan(90)
  })
})
