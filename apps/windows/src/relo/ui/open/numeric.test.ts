// The summary's numeric text (`.contentTransition(.numericText)`) and the notch's open springs: what moves, and how fast.

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { CLOSE_SPRING, CONTENT_SPRING, OPEN_SPRING, swiftSpring } from "../../../geometry"
import { digitsOf, NumericText, rollDirection } from "./NumericText"
import { SPRINGS } from "./tokens"

describe("numeric text", () => {
  it("keys each digit by its place from the right, so only the digits that changed roll", () => {
    const before = digitsOf(19).map((d) => d.key)
    const after = digitsOf(29).map((d) => d.key)
    expect(before).toEqual(["2:1", "1:9"])
    expect(after).toEqual(["2:2", "1:9"])
    expect(after[1]).toBe(before[1]) // the 9 holds still
    expect(after[0]).not.toBe(before[0])
  })

  it("a number gaining a digit keeps its last digits in place", () => {
    expect(digitsOf(9).map((d) => d.key)).toEqual(["1:9"])
    expect(digitsOf(10).map((d) => d.key)).toEqual(["2:1", "1:0"])
  })

  it("rolls up when counting up and down when counting down", () => {
    expect(rollDirection(1, 2)).toBe(1)
    expect(rollDirection(3, 2)).toBe(-1)
    expect(rollDirection(2, 2)).toBe(1)
  })

  it("is read as one number", () => {
    const html = renderToStaticMarkup(createElement(NumericText, { value: 12 }))
    expect(html).toContain('aria-label="12"')
  })
})

describe("the notch's open and close timing", () => {
  it("opens on spring(0.42, 0.8), closes on spring(0.45, 1) and the content scales on smooth(0.35)", () => {
    expect(OPEN_SPRING).toEqual(swiftSpring(0.42, 0.8))
    expect(CLOSE_SPRING).toEqual(swiftSpring(0.45, 1))
    expect(CONTENT_SPRING).toEqual(swiftSpring(0.35, 1))
  })

  it("the content leaves before the shape has collapsed (a faster spring than the close)", () => {
    expect(CONTENT_SPRING.stiffness).toBeGreaterThan(CLOSE_SPRING.stiffness)
  })

  it("a tab swap cross-fades on .smooth (0.5 s) and list changes ride snappy", () => {
    expect(SPRINGS.tabSwap).toEqual(swiftSpring(0.5, 1))
    expect(SPRINGS.snappy).toEqual(swiftSpring(0.28, 0.86))
  })
})
