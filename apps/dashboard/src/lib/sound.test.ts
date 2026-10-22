import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type Sound = typeof import("@/lib/sound")

const started = vi.fn()
let state: "running" | "suspended"

class FakeAudioContext {
  destination = {}
  get state() {
    return state
  }
  resume = vi.fn(async () => {
    state = "running"
  })
  decodeAudioData = vi.fn(async () => ({}) as AudioBuffer)
  createGain = () => ({ gain: { value: 0 }, connect: vi.fn() })
  createBufferSource = () => ({ buffer: null, connect: vi.fn(), start: started })
}

function visibility(value: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value })
}

async function load(): Promise<Sound> {
  vi.resetModules()
  return import("@/lib/sound")
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-10-19T12:00:00Z"))
  started.mockClear()
  state = "suspended"
  visibility("visible")
  window.localStorage.clear()
  vi.stubGlobal("AudioContext", FakeAudioContext)
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("sound", () => {
  it("is off by default and plays nothing", async () => {
    const sound = await load()
    expect(sound.isSoundEnabled()).toBe(false)
    expect(sound.playCue("needs-you")).toBe(false)
    expect(started).not.toHaveBeenCalled()
  })

  it("turning it on is kept per browser, unlocks the context and confirms with linked", async () => {
    const sound = await load()
    await sound.setSoundEnabled(true)
    expect(window.localStorage.getItem("relo.sound")).toBe("on")
    expect(started).toHaveBeenCalledTimes(1)
    expect((await load()).isSoundEnabled()).toBe(true)
    await sound.setSoundEnabled(false)
    expect(sound.isSoundEnabled()).toBe(false)
    expect((await load()).isSoundEnabled()).toBe(false)
  })

  it("plays only in a visible tab", async () => {
    const sound = await load()
    await sound.setSoundEnabled(true)
    started.mockClear()
    vi.advanceTimersByTime(sound.MIN_GAP_MS)
    visibility("hidden")
    expect(sound.playCue("done")).toBe(false)
    visibility("visible")
    expect(sound.playCue("done")).toBe(true)
  })

  it("spaces moment cues 2 s apart, while the owner's own acts always sound", async () => {
    const sound = await load()
    await sound.setSoundEnabled(true)
    vi.advanceTimersByTime(sound.MIN_GAP_MS)
    expect(sound.playCue("needs-you")).toBe(true)
    vi.advanceTimersByTime(sound.MIN_GAP_MS - 1)
    expect(sound.playCue("failed")).toBe(false)
    expect(sound.playCue("sent")).toBe(true)
    vi.advanceTimersByTime(sound.MIN_GAP_MS)
    expect(sound.playCue("failed")).toBe(true)
  })

  it("skips a cue while the browser still blocks audio, instead of queuing it", async () => {
    const sound = await load()
    await sound.setSoundEnabled(true)
    vi.advanceTimersByTime(sound.MIN_GAP_MS)
    state = "suspended"
    expect(sound.playCue("done")).toBe(false)
  })

  it("swallows a missing file or a failed decode", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline") }))
    const sound = await load()
    await expect(sound.setSoundEnabled(true)).resolves.toBeUndefined()
    expect(sound.playCue("done")).toBe(false)
  })

  it("works without Web Audio or storage", async () => {
    vi.stubGlobal("AudioContext", undefined)
    const sound = await load()
    await expect(sound.setSoundEnabled(true)).resolves.toBeUndefined()
    expect(sound.playCue("done")).toBe(false)
  })
})
