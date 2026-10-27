// The page's side of src-tauri/src/media: commands and events. Outside Tauri (a browser tab, tests) every call is inert
// and `?musicMock=1` shows a fixture, so the views can be developed and screenshotted without a player.

import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { inTauri } from "../bridge"
import type { MediaState } from "./types"

export type Control = "toggle" | "play" | "pause" | "next" | "prev" | "shuffle" | "repeat" | "like"

export const mediaGet = (): Promise<MediaState | null> => (inTauri ? invoke<MediaState>("media_get").catch(() => null) : Promise.resolve(null))
export const mediaControl = (control: Control): void => void (inTauri && invoke("media_control", { control }).catch(() => {}))
export const mediaSeek = (seconds: number): void => void (inTauri && invoke("media_seek", { seconds }).catch(() => {}))
export const mediaVolume = (level: number): void => void (inTauri && invoke("media_volume", { level }).catch(() => {}))
export const mediaOpenApp = (): void => void (inTauri && invoke("media_open_app").catch(() => {}))
export const mediaVisualizer = (on: boolean): void => void (inTauri && invoke("media_visualizer", { on }).catch(() => {}))
export const mediaForegroundIsSource = (): Promise<boolean> => (inTauri ? invoke<boolean>("media_foreground_is_source").catch(() => false) : Promise.resolve(false))

export interface LyricsReply {
  plain: string
  synced: string
}
export const mediaLyrics = (title: string, artist: string): Promise<LyricsReply | null> =>
  inTauri ? invoke<LyricsReply | null>("media_lyrics", { title, artist }).catch(() => null) : Promise.resolve(null)

export const mediaSettingsRead = (): Promise<unknown> => (inTauri ? invoke("media_settings_read").catch(() => ({})) : Promise.resolve({}))
export const mediaSettingsWrite = (settings: unknown): Promise<void> => (inTauri ? invoke<void>("media_settings_write", { settings }).catch(() => {}) : Promise.resolve())

function on<T>(name: string, cb: (payload: T) => void): () => void {
  if (!inTauri) return () => {}
  const p = listen<T>(name, (e) => cb(e.payload))
  return () => void p.then((off) => off())
}

export const onMediaState = (cb: (s: MediaState) => void) => on<MediaState>("media_state", cb)
export const onMediaBands = (cb: (bands: number[]) => void) => on<number[]>("media_bands", cb)
export const onMediaSettings = (cb: (raw: unknown) => void) => on<unknown>("media_settings_changed", cb)

/** A fixture for `?musicMock=1` (design review without a player). */
export const MOCK_ENABLED = typeof location !== "undefined" && new URLSearchParams(location.search).has("musicMock")
