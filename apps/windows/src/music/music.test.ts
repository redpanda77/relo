import { describe, expect, it, vi } from "vitest"
import { averageColor, ensureMinimumBrightness } from "./color"
import { hidesForFullscreen } from "./fullscreen"
import { IdleTracker, showsMusicActivity, type Clock } from "./idle"
import { lineAt, lyricsLine, parseLrc } from "./lyrics"
import { addControl, applyDrop, applyTrashDrop, activeSlots, decodeDrop, placeControl, resetSlots, swapSlots } from "./slots"
import { createMusicStore, shouldSneak, SNEAK_MS, trackKey, type MusicIO } from "./store"
import { closedMusicShape } from "./ClosedMusic"
import { barScale, wantsBands } from "./bands"
import { createMediaSettingsStore } from "./settings"
import { EMPTY_STATE, MEDIA_DEFAULTS, normalizeMedia, positionAt, type MediaSettings, type MediaState } from "./types"

/** A manual clock: timers run only when advanced. */
function fakeClock() {
  let now = 0
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const clock: Clock = {
    set(fn, ms) {
      const id = ++seq
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clear(h) {
      timers.delete(h as number)
    },
  }
  return {
    clock,
    advance(ms: number) {
      now += ms
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id)
          t.fn()
        }
      }
    },
  }
}

const track = (o: Partial<MediaState> = {}): MediaState => ({ ...EMPTY_STATE, active: true, title: "T", artist: "A", album: "Al", appId: "spotify.exe", ...o })

describe("inactivity timeout", () => {
  it("goes idle after waitInterval seconds of pause, and playing again cancels it", () => {
    const c = fakeClock()
    const seen: boolean[] = []
    const t = new IdleTracker(() => 3, (v) => seen.push(v), c.clock)
    t.playing(true)
    expect(t.idle).toBe(false)
    t.playing(false)
    c.advance(2999)
    expect(t.idle).toBe(false)
    c.advance(1)
    expect(t.idle).toBe(true)
    t.playing(true)
    t.playing(false)
    c.advance(1000)
    t.playing(true) // cancelled before the 3 s
    c.advance(5000)
    expect(t.idle).toBe(false)
    expect(seen).toEqual([false, true, false])
  })

  it("a zero timeout is immediate on the next tick, and the closed notch follows playing/idle", () => {
    const c = fakeClock()
    const t = new IdleTracker(() => 0, () => {}, c.clock)
    t.playing(true)
    t.playing(false)
    c.advance(0)
    expect(t.idle).toBe(true)
    const base = { isPlaying: false, idle: false, liveActivity: true, hiddenForFullscreen: false, active: true }
    expect(showsMusicActivity(base)).toBe(true) // paused but inside the timeout
    expect(showsMusicActivity({ ...base, idle: true })).toBe(false)
    expect(showsMusicActivity({ ...base, idle: true, isPlaying: true })).toBe(true)
    expect(showsMusicActivity({ ...base, liveActivity: false })).toBe(false)
    expect(showsMusicActivity({ ...base, hiddenForFullscreen: true })).toBe(false)
  })
})

describe("slot configuration", () => {
  it("defaults, padding and clamping", () => {
    expect(resetSlots()).toEqual(["none", "previous", "playPause", "next", "none"])
    expect(activeSlots(["next"], 4)).toEqual(["next", "none", "none", "none"])
    expect(activeSlots(resetSlots(), 99)).toHaveLength(5)
    expect(activeSlots(resetSlots(), 0)).toHaveLength(3)
  })

  it("placing a control clears its other slot; swapping and trashing work", () => {
    const s = placeControl(resetSlots(), "next", 0)
    expect(s).toEqual(["next", "previous", "playPause", "none", "none"])
    expect(swapSlots(s, 0, 4)).toEqual(["none", "previous", "playPause", "none", "next"])
    expect(applyTrashDrop(s, "slot:1")).toEqual(["next", "none", "playPause", "none", "none"])
    expect(applyTrashDrop(s, "control:shuffle")).toEqual(s)
  })

  it("drop payloads are the Mac's strings and bad ones are ignored", () => {
    expect(decodeDrop("slot:2")).toEqual({ kind: "slot", index: 2 })
    expect(decodeDrop("slot:9")).toBeNull()
    expect(decodeDrop("control:shuffle")).toEqual({ kind: "control", control: "shuffle" })
    expect(decodeDrop("control:nope")).toBeNull()
    expect(applyDrop(resetSlots(), "garbage", 0)).toEqual(resetSlots())
    expect(applyDrop(resetSlots(), "control:shuffle", 0)[0]).toBe("shuffle")
  })

  it("tapping the palette fills the first empty slot, else replaces slot 0", () => {
    expect(addControl(resetSlots(), "shuffle")[0]).toBe("shuffle")
    const full = ["shuffle", "previous", "playPause", "next", "repeatMode"] as const
    expect(addControl([...full], "favorite")).toEqual(["favorite", "previous", "playPause", "next", "repeatMode"])
  })

  it("settings normalization keeps five unique valid slots", () => {
    expect(normalizeMedia({ slots: ["next", "next", "bogus"] }).slots).toEqual(["next", "none", "none", "none", "none"])
    expect(normalizeMedia(null)).toEqual(MEDIA_DEFAULTS)
    expect(normalizeMedia({ waitInterval: 99, hideNotchOption: "x", source: "spotify" })).toMatchObject({ waitInterval: 10, hideNotchOption: "nowPlayingOnly", source: "spotify" })
  })
})

describe("lyrics", () => {
  const lrc = "[00:12.50] second\n[00:01.00] first\n[01:02] third\nno stamp\n[00:30.00]   \n"
  it("parses, sorts and drops empty lines", () => {
    expect(parseLrc(lrc)).toEqual([
      { time: 1, text: "first" },
      { time: 12.5, text: "second" },
      { time: 62, text: "third" },
    ])
  })
  it("finds the current line by position", () => {
    const l = parseLrc(lrc)
    expect(lineAt(l, 0)).toBe("first")
    expect(lineAt(l, 12.5)).toBe("second")
    expect(lineAt(l, 40)).toBe("second")
    expect(lineAt(l, 999)).toBe("third")
    expect(lineAt([], 5)).toBe("")
  })
  it("the lyrics row shows loading, synced, plain or none", () => {
    const synced = parseLrc(lrc)
    expect(lyricsLine({ fetching: true, plain: "", synced: [] }, 0)).toBe("Loading lyrics…")
    expect(lyricsLine({ fetching: false, plain: "x", synced }, 13)).toBe("second")
    expect(lyricsLine({ fetching: false, plain: "a\nb", synced: [] }, 0)).toBe("a b")
    expect(lyricsLine({ fetching: false, plain: " ", synced: [] }, 0)).toBe("No lyrics found")
  })
})

describe("album art tint", () => {
  it("near-black becomes mid gray; dark colours are lifted to brightness 0.5; light ones stay", () => {
    expect(averageColor([0, 0, 0, 255, 2, 2, 2, 255])).toEqual([128, 128, 128])
    const lifted = averageColor([40, 0, 0, 255])
    expect(Math.max(...lifted)).toBe(128)
    expect(averageColor([200, 100, 50, 255, 200, 100, 50, 255])).toEqual([200, 100, 50])
    expect(averageColor([])).toEqual([255, 255, 255])
  })
  it("ensureMinimumBrightness rescales to the factor", () => {
    const [r, g, b] = ensureMinimumBrightness([100, 100, 100], 0.6)
    expect(r).toBe(g)
    expect(g).toBe(b)
    expect(r).toBe(153)
    expect(ensureMinimumBrightness([0, 0, 0], 0.5)).toEqual([128, 128, 128])
  })
})

describe("positions, fullscreen, visualizer helpers, shape", () => {
  it("extrapolates while playing within the duration", () => {
    const s = { isPlaying: true, positionMs: 10_000, timestampMs: 1_000, rate: 1, durationMs: 12_000 }
    expect(positionAt(s, 2_000)).toBe(11)
    expect(positionAt(s, 99_000)).toBe(12)
    expect(positionAt({ ...s, isPlaying: false }, 5_000)).toBe(10)
  })
  it("full screen behavior options", () => {
    expect(hidesForFullscreen("always", true, false)).toBe(true)
    expect(hidesForFullscreen("never", true, true)).toBe(false)
    expect(hidesForFullscreen("nowPlayingOnly", true, false)).toBe(false)
    expect(hidesForFullscreen("nowPlayingOnly", true, true)).toBe(true)
    expect(hidesForFullscreen("always", false, true)).toBe(false)
  })
  it("bars rest at 35% and capture runs only when playing and visible", () => {
    expect(barScale(0)).toBeCloseTo(0.35)
    expect(barScale(1)).toBe(1)
    expect(barScale(NaN)).toBeCloseTo(0.35)
    expect(wantsBands({ playing: true, visible: true })).toBe(true)
    expect(wantsBands({ playing: true, visible: false })).toBe(false)
    expect(wantsBands({ playing: false, visible: true })).toBe(false)
  })
  it("closed notch widens by the Mac's 2 * (h - 12) + 20", () => {
    expect(closedMusicShape({ closedWidth: 185, closedHeight: 32, sneak: false, style: "standard" })).toEqual({ width: 245, extraHeight: 0 })
    expect(closedMusicShape({ closedWidth: 185, closedHeight: 32, sneak: true, style: "standard" }).extraHeight).toBeGreaterThan(0)
    expect(closedMusicShape({ closedWidth: 185, closedHeight: 32, sneak: true, style: "inline" }).width).toBeGreaterThan(380)
  })
})

describe("the music store", () => {
  function setup(settings: Partial<MediaSettings> = {}) {
    const c = fakeClock()
    let cur = { ...MEDIA_DEFAULTS, ...settings }
    let push: (s: MediaState) => void = () => {}
    let settingsCb: () => void = () => {}
    const lyrics = vi.fn(async () => ({ plain: "la", synced: "[00:01.00] one" }))
    const io: MusicIO = {
      get: async () => null,
      onState: (cb) => ((push = cb), () => {}),
      settings: () => cur,
      onSettings: (cb) => ((settingsCb = cb), () => {}),
      lyrics,
      color: async () => [10, 20, 30],
      clock: c.clock,
    }
    const store = createMusicStore(io)
    store.start()
    return { store, c, push: (s: MediaState) => push(s), lyrics, setSettings: (p: Partial<MediaSettings>) => ((cur = { ...cur, ...p }), settingsCb()) }
  }

  it("sneak peek fires on play and on track change, only when enabled, and ends after SNEAK_MS", () => {
    expect(shouldSneak(track(), track({ isPlaying: true }), true)).toBe(true)
    expect(shouldSneak(track({ isPlaying: true }), track({ isPlaying: true }), true)).toBe(false)
    expect(shouldSneak(track({ isPlaying: true }), track({ isPlaying: true, title: "B" }), true)).toBe(true)
    expect(shouldSneak(track(), track({ isPlaying: true }), false)).toBe(false)
    expect(shouldSneak(track(), track({ isPlaying: true, artist: "" }), true)).toBe(false)
    const { store, c, push } = setup({ sneakPeek: true })
    push(track({ isPlaying: true }))
    expect(store.get().sneak).toBe(true)
    expect(SNEAK_MS).toBe(1500) // Constants.swift:118-124
    c.advance(SNEAK_MS)
    expect(store.get().sneak).toBe(false)
  })

  it("idle follows playback with the configured wait", () => {
    const { store, c, push } = setup({ waitInterval: 2 })
    push(track({ isPlaying: true }))
    expect(store.get().idle).toBe(false)
    push(track({ isPlaying: false }))
    c.advance(1999)
    expect(store.get().idle).toBe(false)
    c.advance(1)
    expect(store.get().idle).toBe(true)
  })

  it("fetches lyrics once per track, only when enabled, and drops stale replies", async () => {
    const { store, push, lyrics, setSettings } = setup({ lyrics: true })
    push(track({ isPlaying: true }))
    push(track({ isPlaying: true, positionMs: 5 }))
    expect(lyrics).toHaveBeenCalledTimes(1)
    expect(store.get().lyrics.fetching).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(store.get().lyrics.synced).toEqual([{ time: 1, text: "one" }])
    setSettings({ lyrics: false })
    expect(store.get().lyrics.synced).toEqual([])
    setSettings({ lyrics: true })
    expect(lyrics).toHaveBeenCalledTimes(2)
    expect(trackKey(track())).not.toBe(trackKey(track({ title: "x" })))
  })

  it("takes the cover tint from the artwork", async () => {
    const { store, push } = setup()
    push(track({ artwork: "data:image/png;base64,AA" }))
    await Promise.resolve()
    await Promise.resolve()
    expect(store.get().avg).toEqual([10, 20, 30])
    push(track({ artwork: null }))
    expect(store.get().avg).toEqual([255, 255, 255])
  })
})

describe("the settings store", () => {
  it("loads, merges patches, persists the normalized whole and applies other windows' writes", async () => {
    const writes: MediaSettings[] = []
    let pushed: (raw: unknown) => void = () => {}
    const store = createMediaSettingsStore({
      read: async () => ({ source: "spotify", slots: ["shuffle"] }),
      write: async (v) => void writes.push(v),
      subscribe: (cb) => ((pushed = cb), () => {}),
    })
    await store.start()
    expect(store.get().source).toBe("spotify")
    expect(store.get().slots).toEqual(["shuffle", "none", "none", "none", "none"])
    store.update({ waitInterval: 7 })
    await Promise.resolve()
    await Promise.resolve()
    expect(writes.at(-1)?.waitInterval).toBe(7)
    expect(writes.at(-1)?.source).toBe("spotify")
    pushed({ source: "youtubeMusic" })
    expect(store.get().source).toBe("youtubeMusic")
  })
})
