import { describe, expect, it } from "vitest"

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
