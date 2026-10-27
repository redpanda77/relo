import { beforeEach, describe, expect, it, vi } from "vitest"
import { handOffOf } from "../bridge"
import { answerQuitRequests, cueLaunchOnce, resetLaunchCue } from "./lifecycle"

describe("launch cue", () => {
  beforeEach(resetLaunchCue)

  it("plays once per run when the owner opened the app", async () => {
    const launchCue = vi.fn(() => true)
    const deps = { startedAtLogin: async () => false, launchCue }
    expect(await cueLaunchOnce(deps)).toBe(true)
    expect(await cueLaunchOnce(deps)).toBe(false)
    expect(launchCue).toHaveBeenCalledTimes(1)
    expect(launchCue).toHaveBeenCalledWith({ atLogin: false })
  })

  it("is told when Windows started the app at sign-in (the controller keeps that silent)", async () => {
    const launchCue = vi.fn(({ atLogin }: { atLogin: boolean }) => !atLogin)
    expect(await cueLaunchOnce({ startedAtLogin: async () => true, launchCue })).toBe(false)
    expect(launchCue).toHaveBeenCalledWith({ atLogin: true })
  })

  it("waits for the cues to be decoded before playing", async () => {
    const order: string[] = []
    await cueLaunchOnce({
      startedAtLogin: async () => false,
      ready: async () => void order.push("ready"),
      launchCue: () => (order.push("cue"), true),
    })
    expect(order).toEqual(["ready", "cue"])
  })

  it("a failing launch-argument read counts as not at login", async () => {
    const launchCue = vi.fn(() => true)
    await cueLaunchOnce({ startedAtLogin: () => Promise.reject(new Error("no")), launchCue })
    expect(launchCue).toHaveBeenCalledWith({ atLogin: false })
  })
})

describe("quit round trip", () => {
  function setup(sound: () => number) {
    let request: () => void = () => {}
    const ready = vi.fn(async (_ms: number) => {})
    const off = vi.fn()
    answerQuitRequests({ onQuitRequest: (cb) => ((request = cb), off), quitSound: sound, quitReady: ready })
    return { ask: () => request(), ready }
  }

  it("answers a quit request with the length of the quit sound", () => {
    const s = setup(() => 640)
    s.ask()
    expect(s.ready).toHaveBeenCalledWith(640)
  })

  it("answers 0 when no sound plays and caps the wait at two seconds", () => {
    const quiet = setup(() => 0)
    quiet.ask()
    expect(quiet.ready).toHaveBeenCalledWith(0)
    const long = setup(() => 5000)
    long.ask()
    expect(long.ready).toHaveBeenCalledWith(2000)
  })

  it("answers 0 when the sound throws, so the exit is never held", () => {
    const s = setup(() => {
      throw new Error("audio")
    })
    s.ask()
    expect(s.ready).toHaveBeenCalledWith(0)
  })
})

describe("launch_args", () => {
  it("the installer hand-off is read out of the flat payload, and absent without an origin", () => {
    expect(handOffOf({ atLogin: true })).toBeNull()
    expect(handOffOf({ atLogin: false, origin: "https://a.io", signInCode: "c" })).toEqual({ origin: "https://a.io", signInCode: "c", codeVerifier: null })
    expect(handOffOf(null)).toBeNull()
  })
})
