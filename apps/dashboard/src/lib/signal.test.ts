import { describe, expect, it } from "vitest"

import { drawDust, drawOrbitPlane, planePoint, wavePush } from "@/lib/hud-render"
import { PLASMA_FRAGMENT, plasmaStops } from "@/lib/plasma-orb"
import { mixShares, signalAt } from "@/lib/signal"

describe("now mix", () => {
  it("colors a slot by cumulative share, in display order", () => {
    const mix = { done: 1, running: 1, message: 2 }
    expect(mixShares(mix).map((entry) => entry.share)).toEqual([0.25, 0.25, 0.5])
    expect(signalAt(mix, 0.1)).toBe("done")
    expect(signalAt(mix, 0.3)).toBe("running")
    expect(signalAt(mix, 0.9)).toBe("message")
    expect(signalAt({}, 0.5)).toBeNull()
  })
})

describe("waves", () => {
  it("shoves a point on the front outward and ignores old waves", () => {
    const wave = { x: 0, y: 0, at: 0, strength: 1 }
    const push = wavePush(wave, 120, 0, 500)
    expect(push.dx).toBeGreaterThan(5)
    expect(push.lift).toBeGreaterThan(0.4)
    expect(wavePush(wave, 120, 0, 3000)).toEqual({ dx: 0, dy: 0, lift: 0 })
  })

  it("paints dust without throwing on an empty context", () => {
    const calls: string[] = []
    const context = new Proxy({}, { get: (_, name) => () => void calls.push(String(name)), set: () => true }) as unknown as CanvasRenderingContext2D
    drawDust(context, { width: 400, height: 300, time: 5, now: 0, state: "clear", mix: { done: 1 } })
    expect(calls.filter((call) => call === "arc")).toHaveLength(150)
  })
})

describe("plasma core", () => {
  it("takes the top four meanings with cumulative stops", () => {
    const stops = plasmaStops({ done: 5, running: 3, message: 1, failed: 1 }, "clear")
    expect(stops.weights[0]).toBeCloseTo(0.5)
    expect(stops.weights[3]).toBeCloseTo(1)
    expect(stops.colors[0][1]).toBeCloseTo(0xd3 / 255, 1)
  })

  it("gives a single meaning its light and deep shades, and an empty day its state palette", () => {
    const single = plasmaStops({ running: 4 }, "clear")
    expect(single.weights).toEqual([0.55, 1, 1, 1])
    expect(single.colors[0]).not.toEqual(single.colors[1])
    expect(plasmaStops({}, "needsYou").weights).toEqual([0.34, 0.67, 0.9, 1])
  })

  it("ships a shader with the Metal uniforms", () => {
    for (const name of ["uSize", "uTime", "uEnergy", "uC3", "uWeights", "uTouch", "uTouchAge"]) {
      expect(PLASMA_FRAGMENT).toContain(name)
    }
  })
})

describe("orbital plane", () => {
  const recorder = () => {
    const calls: string[] = []
    const context = new Proxy({}, {
      get: (_, name) => (name === "createLinearGradient" || name === "createRadialGradient" ? () => ({ addColorStop() {} }) : () => void calls.push(String(name))),
      set: () => true,
    }) as unknown as CanvasRenderingContext2D
    return { calls, context }
  }
  const frame = { width: 900, height: 330, time: 3, now: 0, state: "running" as const, mix: { done: 1 }, arcs: [{ progress: 0.4 }], center: { x: 450, y: 165 } }

  it("splits the grains between the far and near halves", () => {
    const far = recorder()
    const near = recorder()
    drawOrbitPlane(far.context, { ...frame, half: "far" })
    drawOrbitPlane(near.context, { ...frame, half: "near" })
    const arcs = (calls: string[]) => calls.filter((call) => call === "arc").length
    expect(arcs(far.calls) + arcs(near.calls)).toBeGreaterThan(150)
    expect(arcs(far.calls)).toBeGreaterThan(50)
    expect(arcs(near.calls)).toBeGreaterThan(50)
  })

  it("puts angles with positive sine on the near side", () => {
    expect(planePoint(Math.PI / 2, 0, 700, 100, { x: 0, y: 0 }).depth).toBeCloseTo(1)
    expect(planePoint(-Math.PI / 2, 0, 700, 100, { x: 0, y: 0 }).depth).toBeCloseTo(-1)
  })
})
