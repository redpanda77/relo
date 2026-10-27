import { describe, expect, it } from "vitest"
import { applyPatch, createSettingsStore, DEFAULTS, modeOfHeight, normalize, toSoundSettings, type ReloSettings } from "./store"

describe("normalize", () => {
  it("gives the defaults for nothing, junk or arrays", () => {
    expect(normalize(undefined)).toEqual(DEFAULTS)
    expect(normalize("x")).toEqual(DEFAULTS)
    expect(normalize([1])).toEqual(DEFAULTS)
    expect(normalize({})).toEqual(DEFAULTS)
  })

  it("keeps valid fields, repairs the invalid ones per field", () => {
    const s = normalize({ sounds: false, voiceMode: "voiceOnly", voiceDetail: "nope", hoverDelay: 7, notchHeight: 3, accent: "cyan", display: "", soundEvents: { failed: false, started: "x" } })
    expect(s.sounds).toBe(false)
    expect(s.voiceMode).toBe("voiceOnly")
    expect(s.voiceDetail).toBe("full")
    expect(s.hoverDelay).toBe(1)
    expect(s.notchHeight).toBe(15)
    expect(s.notchHeightMode).toBe("custom")
    expect(s.accent).toBe("cyan")
    expect(s.display).toBeNull()
    expect(s.soundEvents.failed).toBe(false)
    expect(s.soundEvents.started).toBe(true)
  })

  it("keeps the voice engine the Mac knows and repairs the old Windows-only value", () => {
    expect(normalize({ voiceEngine: "system" }).voiceEngine).toBe("system")
    expect(normalize({ voiceEngine: "relo" }).voiceEngine).toBe("relo")
    expect(normalize({ voiceEngine: "windows" }).voiceEngine).toBe("relo")
    expect(DEFAULTS.voiceEngine).toBe("relo")
    expect(normalize({ voiceButton: false }).voiceButton).toBe(false)
  })

  it("maps notch height modes to pixels", () => {
    expect(normalize({}).notchHeightMode).toBe("real")
    expect(normalize({ notchHeightMode: "menuBar", notchHeight: 40 })).toMatchObject({ notchHeightMode: "menuBar", notchHeight: 24 })
    expect(normalize({ notchHeightMode: "real", notchHeight: 40 })).toMatchObject({ notchHeight: 32 })
    expect(normalize({ notchHeightMode: "custom", notchHeight: 40 })).toMatchObject({ notchHeightMode: "custom", notchHeight: 40 })
    expect(normalize({ notchHeightMode: "custom", notchHeight: 99 }).notchHeight).toBe(45)
    // An old file without a mode: 24 and 32 are the presets, anything else is custom.
    expect(normalize({ notchHeight: 24 }).notchHeightMode).toBe("menuBar")
    expect(normalize({ notchHeight: 38 })).toMatchObject({ notchHeightMode: "custom", notchHeight: 38 })
    expect(modeOfHeight(32)).toBe("real")
  })

  it("snaps gesture sensitivity to High, Medium or Low", () => {
    expect(normalize({}).gestureSensitivity).toBe(200)
    expect(normalize({ gestureSensitivity: 120 }).gestureSensitivity).toBe(100)
    expect(normalize({ gestureSensitivity: 999 }).gestureSensitivity).toBe(300)
    expect(normalize({ gestureSensitivity: "x" }).gestureSensitivity).toBe(200)
    expect(normalize({ enableGestures: false, closeGesture: false })).toMatchObject({ enableGestures: false, closeGesture: false })
  })

  it("keeps saved shortcuts for known actions only", () => {
    const s = normalize({ shortcuts: { toggleSneakPeek: "Alt+P", toggleNotchOpen: "", bogus: "Ctrl+X", openNotch: 4 } })
    expect(s.shortcuts).toEqual({ toggleSneakPeek: "Alt+P", toggleNotchOpen: "" })
    expect(normalize({ shortcuts: [1] }).shortcuts).toEqual({})
    expect(normalize({}).shortcuts).toEqual({})
  })

  it("has the Appearance and Advanced switches the Mac has", () => {
    expect(DEFAULTS).toMatchObject({ alwaysShowTabs: true, settingsIconInNotch: true, hideFromScreenRecording: false })
    expect(normalize({ alwaysShowTabs: false }).alwaysShowTabs).toBe(false)
  })

  it("sanitises saved onboarding progress", () => {
    const s = normalize({ onboarding: { stage: "bogus", rows: [{ id: "claude-code", name: "Claude Code", status: "weird" }, { id: 5 }], selected: ["a", 3] } })
    expect(s.onboarding?.stage).toBe("hello")
    expect(s.onboarding?.rows).toEqual([{ id: "claude-code", name: "Claude Code", status: "pending", message: undefined }])
    expect(s.onboarding?.selected).toEqual(["a"])
    expect(normalize({ onboarding: 4 }).onboarding).toBeNull()
  })
})

describe("applyPatch", () => {
  it("merges sound events per kind", () => {
    const next = applyPatch(DEFAULTS, { soundEvents: { ...DEFAULTS.soundEvents, finished: false } })
    expect(next.soundEvents.finished).toBe(false)
    expect(next.soundEvents.question).toBe(true)
    expect(applyPatch(next, { sounds: false }).soundEvents.finished).toBe(false)
  })

  it("merges shortcuts per action", () => {
    const a = applyPatch(DEFAULTS, { shortcuts: { toggleSneakPeek: "Alt+P" } })
    const b = applyPatch(a, { shortcuts: { toggleNotchOpen: "" } })
    expect(b.shortcuts).toEqual({ toggleSneakPeek: "Alt+P", toggleNotchOpen: "" })
  })

  it("moves the height with its mode", () => {
    expect(applyPatch(DEFAULTS, { notchHeightMode: "menuBar", notchHeight: 24 }).notchHeight).toBe(24)
    expect(applyPatch(DEFAULTS, { notchHeightMode: "custom", notchHeight: 40 })).toMatchObject({ notchHeightMode: "custom", notchHeight: 40 })
  })

  it("clamps what it is given", () => {
    expect(applyPatch(DEFAULTS, { hoverDelay: -3 }).hoverDelay).toBe(0)
  })
})

describe("toSoundSettings", () => {
  it("feeds the cue player", () => {
    const s: ReloSettings = { ...DEFAULTS, interfaceSounds: false, voiceMode: "voiceOnly" }
    const out = toSoundSettings(s)
    expect(out).toMatchObject({ sounds: true, interfaceSounds: false, voiceOnly: true })
    expect(out.events.question).toBe(true)
  })
})

describe("the store", () => {
  function fake(initial: unknown) {
    const writes: ReloSettings[] = []
    let push: (raw: unknown) => void = () => {}
    const io = {
      read: async () => initial,
      write: async (v: ReloSettings) => void writes.push(v),
      subscribe: (cb: (raw: unknown) => void) => {
        push = cb
        return () => {}
      },
    }
    return { io, writes, push: (raw: unknown) => push(raw) }
  }

  it("loads, updates optimistically, writes the latest state in order", async () => {
    const f = fake({ sounds: false })
    const store = createSettingsStore(f.io)
    expect(store.isLoaded()).toBe(false)
    await store.start()
    expect(store.isLoaded()).toBe(true)
    expect(store.get().sounds).toBe(false)
    let calls = 0
    store.onChange(() => calls++)
    store.update({ peek: false })
    store.update({ hoverDelay: 0.5 })
    expect(store.get()).toMatchObject({ peek: false, hoverDelay: 0.5, sounds: false })
    expect(calls).toBe(2)
    await new Promise((r) => setTimeout(r, 0))
    expect(f.writes).toHaveLength(2)
    expect(f.writes[1]).toMatchObject({ peek: false, hoverDelay: 0.5 })
  })

  it("does not write a no-op and picks up other windows' changes", async () => {
    const f = fake({})
    const store = createSettingsStore(f.io)
    await store.start()
    store.update({ sounds: true })
    expect(f.writes).toHaveLength(0)
    f.push({ accent: "mint", unknownKey: 1 })
    expect(store.get().accent).toBe("mint")
  })

  it("a restart turns an in-flight setup row back into pending", async () => {
    const f = fake({ onboarding: { stage: "setup", rows: [{ id: "codex", name: "Codex", status: "running" }] } })
    const store = createSettingsStore(f.io)
    await store.start()
    expect(store.get().onboarding?.rows[0]?.status).toBe("pending")
    store.update({ onboarding: { ...store.get().onboarding!, rows: [{ id: "codex", name: "Codex", status: "running" }] } })
    expect(store.get().onboarding?.rows[0]?.status).toBe("running")
  })
})
