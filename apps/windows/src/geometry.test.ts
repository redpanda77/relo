import { describe, expect, it } from "vitest"
import {
  CLOSED,
  OPEN_BASE,
  OPEN_MAX_H,
  OPEN_MIN_H,
  WINDOW_W,
  BOUNCY_SPRING,
  CLOSE_SPRING,
  OPEN_EMPTY_H,
  OPEN_SPRING,
  reloOpenHeight,
  swiftSpring,
  fitOpenHeight,
  openShape,
  outline,
  sameRect,
  tabOpenHeight,
  toHotRect,
} from "./geometry"

describe("tabOpenHeight", () => {
  it("honors what the tab reported, clamped, else the fixed height", () => {
    expect(tabOpenHeight(190, undefined)).toBe(190)
    expect(tabOpenHeight(190, 220)).toBe(220)
    expect(tabOpenHeight(190, 90)).toBe(OPEN_MIN_H)
    expect(tabOpenHeight(190, 900)).toBe(OPEN_MAX_H)
  })
})

describe("fitOpenHeight", () => {
  it("clamps to 170..430", () => {
    expect(fitOpenHeight(10)).toBe(170)
    expect(fitOpenHeight(300, 20)).toBe(320)
    expect(fitOpenHeight(900)).toBe(OPEN_MAX_H)
    expect(fitOpenHeight(Number.NaN)).toBe(OPEN_MIN_H)
  })
  it("keeps the Mac open width and radii", () => {
    expect(openShape(250)).toMatchObject({ w: 640, h: 250, top: 19, bottom: 24 })
    expect(OPEN_BASE.w).toBeLessThanOrEqual(WINDOW_W)
    expect(CLOSED).toMatchObject({ w: 185, top: 6, bottom: 14 })
  })
})

describe("outline", () => {
  it("starts and ends at the top edge and has concave top corners", () => {
    const d = outline(185, 32, 6, 14)
    expect(d.startsWith("M0 0 Q6 0 6 6")).toBe(true)
    expect(d.endsWith("Q179 0 185 0 Z")).toBe(true)
  })
  it("never lets radii exceed the shape", () => {
    expect(outline(10, 4, 19, 24)).not.toMatch(/NaN|-\d/)
  })
})

describe("toHotRect", () => {
  it("scales CSS px to physical px", () => {
    expect(toHotRect({ left: 247.5, top: 0, width: 185, height: 32 }, 1.5)).toEqual([371, 0, 278, 48])
  })
  it("falls back to 1 for a bad ratio", () => {
    expect(toHotRect({ left: 1, top: 2, width: 3, height: 4 }, 0)).toEqual([1, 2, 3, 4])
  })
  it("detects equal rects", () => {
    expect(sameRect([1, 2, 3, 4], [1, 2, 3, 4])).toBe(true)
    expect(sameRect(null, [1, 2, 3, 4])).toBe(false)
    expect(sameRect([1, 2, 3, 4], [1, 2, 3, 5])).toBe(false)
  })
})

describe("relo open height", () => {
  it("adds the 58 pt chrome to the list and clamps; no list is 200", () => {
    expect(reloOpenHeight(100, true)).toBe(170)
    expect(reloOpenHeight(200, true)).toBe(258)
    expect(reloOpenHeight(900, true)).toBe(OPEN_MAX_H)
    expect(reloOpenHeight(900, false)).toBe(OPEN_EMPTY_H)
  })
})

describe("springs", () => {
  it("maps SwiftUI response and damping to stiffness and damping", () => {
    const s = swiftSpring(0.42, 0.8)
    expect(s.stiffness).toBeCloseTo((2 * Math.PI / 0.42) ** 2, 6)
    expect(s.damping).toBeCloseTo(2 * 0.8 * (2 * Math.PI / 0.42), 6)
    expect(OPEN_SPRING).toEqual(s)
  })
  it("closes critically damped and bouncy has bounce 0.3", () => {
    expect(CLOSE_SPRING.damping).toBeCloseTo(2 * Math.sqrt(CLOSE_SPRING.stiffness), 6)
    expect(BOUNCY_SPRING.damping / (2 * Math.sqrt(BOUNCY_SPRING.stiffness))).toBeCloseTo(0.7, 6)
  })
})
