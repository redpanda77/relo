// The music view state (MusicManager.swift): the media state from Rust plus what the Mac derives from it: the idle
// timeout, the album-art tint, the lyrics, the sneak peek on track change. One instance for the whole page; the open
// player and the closed activity read the same snapshot. IO is injected, so the rules are tested without Tauri.

import { useSyncExternalStore } from "react"
import { averageColorOf, type RGB } from "./color"
import { IdleTracker, realClock, type Clock } from "./idle"
import * as ipc from "./ipc"
import { parseLrc, type LyricsView } from "./lyrics"
import { mediaSettings } from "./settings"
import { EMPTY_STATE, MEDIA_DEFAULTS, type MediaSettings, type MediaState } from "./types"

/** How long the sneak peek stays when playback changes (Constants.swift:118-124: 1.5 s; the shortcut's lasts 3 s, relo/notchState.ts). */
export const SNEAK_MS = 1500

export interface MusicSnapshot {
  state: MediaState
  settings: MediaSettings
  /** The inactivity timeout has passed since playback stopped. */
  idle: boolean
  /** Average colour of the cover (white until one is known). */
  avg: RGB
  lyrics: LyricsView
  /** The sneak peek is showing. */
  sneak: boolean
}

export interface MusicIO {
  get(): Promise<MediaState | null>
  onState(cb: (s: MediaState) => void): () => void
  settings(): MediaSettings
  onSettings(cb: () => void): () => void
  lyrics(title: string, artist: string): Promise<{ plain: string; synced: string } | null>
  color(dataUrl: string): Promise<RGB | null>
  clock?: Clock
}

/** The identity of what is playing: a change here is a track change. */
export const trackKey = (s: Pick<MediaState, "title" | "artist" | "album" | "appId">) => `${s.appId}\u{1}${s.title}\u{1}${s.artist}\u{1}${s.album}`

/** Sneak peek: playback started, or the track changed while playing, with a title and artist (MusicManager.updateSneakPeek). */
export function shouldSneak(prev: MediaState, next: MediaState, enabled: boolean): boolean {
  if (!enabled || !next.isPlaying || !next.title || !next.artist) return false
  return !prev.isPlaying || trackKey(prev) !== trackKey(next)
}

const WHITE: RGB = [255, 255, 255]
const NO_LYRICS: LyricsView = { fetching: false, plain: "", synced: [] }

export interface MusicStore {
  get(): MusicSnapshot
  subscribe(cb: () => void): () => void
  start(): void
  dispose(): void
}

export function createMusicStore(io: MusicIO): MusicStore {
  const clock = io.clock ?? realClock
  const listeners = new Set<() => void>()
  let snap: MusicSnapshot = { state: EMPTY_STATE, settings: io.settings(), idle: true, avg: WHITE, lyrics: NO_LYRICS, sneak: false }
  let started = false
  let offs: Array<() => void> = []
  let sneakHandle: unknown = null
  let lyricsFor = ""
  let artFor: string | null = null

  const set = (patch: Partial<MusicSnapshot>) => {
    snap = { ...snap, ...patch }
    listeners.forEach((l) => l())
  }

  const idle = new IdleTracker(
    () => snap.settings.waitInterval,
    (v) => set({ idle: v }),
    clock,
  )

  const sneak = () => {
    if (sneakHandle !== null) clock.clear(sneakHandle)
    set({ sneak: true })
    sneakHandle = clock.set(() => {
      sneakHandle = null
      set({ sneak: false })
    }, SNEAK_MS)
  }

  const loadLyrics = (s: MediaState) => {
    const key = trackKey(s)
    if (!snap.settings.lyrics || !s.title) {
      lyricsFor = ""
      if (snap.lyrics !== NO_LYRICS) set({ lyrics: NO_LYRICS })
      return
    }
    if (key === lyricsFor) return
    lyricsFor = key
    set({ lyrics: { fetching: true, plain: "", synced: [] } })
    void io.lyrics(s.title, s.artist).then((r) => {
      if (lyricsFor !== key) return // the track moved on
      set({ lyrics: { fetching: false, plain: r?.plain ?? "", synced: r?.synced ? parseLrc(r.synced) : [] } })
    })
  }

  const loadColor = (art: string | null) => {
    if (art === artFor) return
    artFor = art
    if (!art) return set({ avg: WHITE })
    void io.color(art).then((c) => {
      if (artFor === art) set({ avg: c ?? WHITE })
    })
  }

  const onState = (next: MediaState) => {
    const prev = snap.state
    const wasSneak = shouldSneak(prev, next, snap.settings.sneakPeek)
    set({ state: next })
    if (prev.isPlaying !== next.isPlaying) idle.playing(next.isPlaying)
    loadColor(next.artwork)
    loadLyrics(next)
    if (wasSneak) sneak()
  }

  return {
    get: () => snap,
    subscribe(cb) {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
    start() {
      if (started) return
      started = true
      offs.push(io.onState(onState))
      offs.push(
        io.onSettings(() => {
          const before = snap.settings
          set({ settings: io.settings() })
          if (before.lyrics !== snap.settings.lyrics) {
            lyricsFor = ""
            loadLyrics(snap.state)
          }
        }),
      )
      void io.get().then((s) => s && onState(s))
    },
    dispose() {
      offs.forEach((o) => o())
      offs = []
      idle.dispose()
      if (sneakHandle !== null) clock.clear(sneakHandle)
      started = false
    },
  }
}

// ---- The page's instance ----

const MOCK: MediaState = {
  ...EMPTY_STATE,
  active: true,
  title: "Midnight City",
  artist: "M83",
  album: "Hurry Up, We're Dreaming",
  isPlaying: true,
  positionMs: 83_000,
  durationMs: 244_000,
  timestampMs: Date.now(),
  canSeek: true,
  canPrev: true,
  canNext: true,
  shuffleSupported: true,
  repeatSupported: true,
  appId: "Spotify.exe",
  appName: "Spotify",
}

let instance: MusicStore | null = null
export function musicStore(): MusicStore {
  if (!instance) {
    void mediaSettings.start()
    instance = createMusicStore({
      get: () => (ipc.MOCK_ENABLED ? Promise.resolve({ ...MOCK, timestampMs: Date.now() }) : ipc.mediaGet()),
      onState: ipc.onMediaState,
      settings: () => mediaSettings.get(),
      onSettings: (cb) => mediaSettings.onChange(cb),
      lyrics: ipc.mediaLyrics,
      color: averageColorOf,
    })
    instance.start()
  }
  return instance
}

export function useMusic(): MusicSnapshot {
  const s = musicStore()
  return useSyncExternalStore(s.subscribe, s.get, s.get)
}

export { MEDIA_DEFAULTS }
