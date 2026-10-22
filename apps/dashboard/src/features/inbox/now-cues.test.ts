import { describe, expect, it, vi } from "vitest"

import { cueFor, createMomentCues, RETURN_WINDOW_MS } from "@/features/inbox/now-cues"
import type { NowEvent, NowEventKind } from "@/features/inbox/now-events"

const event = (kind: NowEventKind, id = "act_1", at = "2026-10-19T12:00:00Z"): NowEvent => ({ kind, id, at, origin: 0 })

describe("cueFor", () => {
  it("maps needs you, failed and done; everything else is silent", () => {
    expect(cueFor([event("needsYou")])).toBe("needs-you")
    expect(cueFor([event("failed")])).toBe("failed")
    expect(cueFor([event("done")])).toBe("done")
    for (const kind of ["started", "recovered", "step", "sessionStarted", "update"] as const) expect(cueFor([event(kind)])).toBeNull()
  })

  it("one cue per batch, the highest priority winning", () => {
    expect(cueFor([event("done", "a"), event("failed", "b"), event("started", "c")])).toBe("failed")
    expect(cueFor([event("done", "a"), event("needsYou", "b"), event("failed", "c")])).toBe("needs-you")
  })
})

describe("createMomentCues", () => {
  const make = () => {
    const play = vi.fn()
    let clock = 0
    const cues = createMomentCues(play, () => clock)
    return { play, cues, tick: (ms: number) => (clock += ms) }
  }

  it("cues a new moment once, by id, however often it is offered again", () => {
    const { play, cues } = make()
    cues.batch([event("needsYou")])
    cues.batch([event("needsYou")])
    cues.batch([event("needsYou", "act_1", "2026-10-19T12:00:00Z")])
    expect(play).toHaveBeenCalledTimes(1)
    expect(play).toHaveBeenCalledWith("needs-you")
  })

  it("treats the same card failing after it needed you as a new moment", () => {
    const { play, cues } = make()
    cues.batch([event("needsYou")])
    cues.batch([event("failed")])
    expect(play.mock.calls).toEqual([["needs-you"], ["failed"]])
  })

  it("stays silent for the page-open catch-up and never cues it later", () => {
    const { play, cues } = make()
    cues.baseline([event("needsYou"), event("done", "act_2")])
    cues.batch([event("needsYou"), event("done", "act_2")])
    expect(play).not.toHaveBeenCalled()
  })

  it("stays silent for the first refresh after the tab returns, then cues again", () => {
    const { play, cues, tick } = make()
    cues.returned()
    tick(1_000)
    cues.batch([event("done", "act_1")])
    expect(play).not.toHaveBeenCalled()
    cues.batch([event("done", "act_2")])
    expect(play).toHaveBeenCalledWith("done")
  })

  it("does not let an old return silence a later, real moment", () => {
    const { play, cues, tick } = make()
    cues.returned()
    tick(RETURN_WINDOW_MS + 1)
    cues.batch([event("failed")])
    expect(play).toHaveBeenCalledWith("failed")
  })

  it("plays nothing for a batch of silent moments", () => {
    const { play, cues } = make()
    cues.batch([event("started"), event("step", "act_2")])
    expect(play).not.toHaveBeenCalled()
  })
})
