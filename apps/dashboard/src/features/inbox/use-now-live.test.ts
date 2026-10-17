import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { connectNowLive as connect, NOW_EVENTS_PATH } from "@/features/inbox/use-now-live"

// Every connection is torn down after its test, so a failed assertion cannot leak a visibility listener.
const teardowns: (() => void)[] = []
const connectNowLive = (refetch: () => void) => {
  const stop = connect(refetch)
  teardowns.push(stop)
  return stop
}

/** jsdom has no EventSource: a fake that records instances and lets a test emit frames. */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly listeners = new Map<string, Set<() => void>>()
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  readonly url: string
  constructor(url: string) { this.url = url; FakeEventSource.instances.push(this) }
  addEventListener(type: string, listener: () => void) {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }
  close() { this.closed = true }
  emit(type: string) { if (!this.closed) for (const listener of this.listeners.get(type) ?? []) listener() }
  fail() { this.onerror?.() }
}
const open = () => FakeEventSource.instances.filter((source) => !source.closed)
const latest = () => FakeEventSource.instances.at(-1)!

let visibility: DocumentVisibilityState = "visible"
const setVisibility = (value: DocumentVisibilityState) => {
  visibility = value
  document.dispatchEvent(new Event("visibilitychange"))
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeEventSource.instances = []
  visibility = "visible"
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility)
  vi.stubGlobal("EventSource", FakeEventSource)
})
afterEach(() => {
  for (const stop of teardowns.splice(0)) stop()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("the Dashboard's live hints", () => {
  it("opens one stream to the hint route and refetches 750 ms after a hint", () => {
    const refetch = vi.fn()
    const stop = connectNowLive(refetch)
    expect(open()).toHaveLength(1)
    expect(latest().url).toBe(NOW_EVENTS_PATH)
    latest().emit("changed")
    vi.advanceTimersByTime(749)
    expect(refetch).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(refetch).toHaveBeenCalledTimes(1)
    stop()
    expect(open()).toHaveLength(0)
  })

  it("a burst of hints is one refetch, and refetches start at least 2 s apart", () => {
    const refetch = vi.fn()
    const stop = connectNowLive(refetch)
    for (let index = 0; index < 5; index++) latest().emit("changed")
    vi.advanceTimersByTime(750)
    expect(refetch).toHaveBeenCalledTimes(1)
    latest().emit("changed")
    latest().emit("changed")
    // The queued hint runs exactly 2 s after the first refetch.
    vi.advanceTimersByTime(1_999)
    expect(refetch).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(refetch).toHaveBeenCalledTimes(2)
    // Nothing more queued: no further refetch.
    vi.advanceTimersByTime(10_000)
    expect(refetch).toHaveBeenCalledTimes(2)
    stop()
  })

  it("ignores other frames: only a changed hint schedules a read", () => {
    const refetch = vi.fn()
    const stop = connectNowLive(refetch)
    latest().emit("message")
    vi.advanceTimersByTime(5_000)
    expect(refetch).not.toHaveBeenCalled()
    stop()
  })

  it("closes while the tab is hidden and reopens when it shows", () => {
    const refetch = vi.fn()
    const stop = connectNowLive(refetch)
    latest().emit("changed")
    setVisibility("hidden")
    expect(open()).toHaveLength(0)
    vi.advanceTimersByTime(5_000)
    expect(refetch).not.toHaveBeenCalled()
    setVisibility("visible")
    expect(open()).toHaveLength(1)
    expect(FakeEventSource.instances).toHaveLength(2)
    stop()
  })

  it("does not open while hidden", () => {
    visibility = "hidden"
    const stop = connectNowLive(vi.fn())
    expect(FakeEventSource.instances).toHaveLength(0)
    stop()
  })

  it("backs off after errors up to the 60 s poll and resets once a stream opens", () => {
    const stop = connectNowLive(vi.fn())
    const delays: number[] = []
    for (let attempt = 0; attempt < 7; attempt++) {
      const failing = latest()
      failing.fail()
      expect(failing.closed).toBe(true)
      const before = FakeEventSource.instances.length
      let waited = 0
      while (FakeEventSource.instances.length === before) { vi.advanceTimersByTime(1_000); waited += 1_000 }
      delays.push(waited)
    }
    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000])
    latest().onopen?.()
    latest().fail()
    vi.advanceTimersByTime(2_000)
    expect(open()).toHaveLength(1)
    stop()
  })

  it("an error while hidden waits for the tab to show; teardown stops reconnects", () => {
    const stop = connectNowLive(vi.fn())
    visibility = "hidden"
    latest().fail()
    vi.advanceTimersByTime(120_000)
    expect(FakeEventSource.instances).toHaveLength(1)
    setVisibility("visible")
    expect(open()).toHaveLength(1)
    latest().fail()
    stop()
    vi.advanceTimersByTime(120_000)
    expect(open()).toHaveLength(0)
    expect(FakeEventSource.instances).toHaveLength(2)
  })

  it("without EventSource it does nothing and the poll stays the source", () => {
    vi.stubGlobal("EventSource", undefined)
    const stop = connectNowLive(vi.fn())
    expect(FakeEventSource.instances).toHaveLength(0)
    expect(() => stop()).not.toThrow()
  })
})
