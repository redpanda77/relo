import { describe, expect, it } from "vitest"
import { DEMO_SAMPLE, EMPTY_SAMPLE, HISTORY_LENGTH } from "./model"
import { advance, type SystemData } from "./useSystem"

describe("advance", () => {
  const empty: SystemData = { sample: EMPTY_SAMPLE, cpuHistory: [], memoryHistory: [], networkHistory: [] }

  it("keeps the sample and grows three histories", () => {
    const next = advance(empty, DEMO_SAMPLE)
    expect(next.sample).toBe(DEMO_SAMPLE)
    expect(next.cpuHistory).toHaveLength(HISTORY_LENGTH)
    expect(next.cpuHistory.at(-1)).toBe(DEMO_SAMPLE.cpu)
    expect(next.memoryHistory.at(-1)).toBeCloseTo(11.4 / 32)
    expect(next.networkHistory.at(-1)).toBe(DEMO_SAMPLE.downBytesPerSecond + DEMO_SAMPLE.upBytesPerSecond)
  })

  it("survives a sample without memory", () => {
    expect(advance(empty, EMPTY_SAMPLE).memoryHistory.at(-1)).toBe(0)
  })
})
