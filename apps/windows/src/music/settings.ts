// The Media settings store: one typed object persisted by Rust (%APPDATA%\Relo\media.json) and broadcast to every
// window as `media_settings_changed`. Same shape as src/settings/store.ts: reads never fail, writes merge a patch.

import { useSyncExternalStore } from "react"
import * as ipc from "./ipc"
import { MEDIA_DEFAULTS, normalizeMedia, type MediaSettings } from "./types"

export interface SettingsIO {
  read(): Promise<unknown>
  write(v: MediaSettings): Promise<void>
  subscribe(cb: (raw: unknown) => void): () => void
}

export interface MediaSettingsStore {
  get(): MediaSettings
  isLoaded(): boolean
  start(): Promise<void>
  update(patch: Partial<MediaSettings>): void
  onChange(cb: () => void): () => void
}

export function createMediaSettingsStore(io: SettingsIO): MediaSettingsStore {
  let state = MEDIA_DEFAULTS
  let loaded = false
  let starting: Promise<void> | null = null
  const listeners = new Set<() => void>()
  let queue: Promise<void> = Promise.resolve()

  const set = (next: MediaSettings) => {
    if (JSON.stringify(next) === JSON.stringify(state)) return
    state = next
    listeners.forEach((l) => l())
  }

  return {
    get: () => state,
    isLoaded: () => loaded,
    start() {
      starting ??= (async () => {
        io.subscribe((raw) => set(normalizeMedia(raw)))
        set(normalizeMedia(await io.read()))
        loaded = true
        listeners.forEach((l) => l())
      })()
      return starting
    },
    update(patch) {
      set(normalizeMedia({ ...state, ...patch }))
      const snapshot = state
      queue = queue.then(() => io.write(snapshot)).catch(() => {})
    },
    onChange(cb) {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
  }
}

export const mediaSettings = createMediaSettingsStore({
  read: ipc.mediaSettingsRead,
  write: ipc.mediaSettingsWrite,
  subscribe: ipc.onMediaSettings,
})

export function useMediaSettings(): { settings: MediaSettings; update: (p: Partial<MediaSettings>) => void; loaded: boolean } {
  void mediaSettings.start()
  const settings = useSyncExternalStore(mediaSettings.onChange, mediaSettings.get, mediaSettings.get)
  const loaded = useSyncExternalStore(mediaSettings.onChange, mediaSettings.isLoaded, mediaSettings.isLoaded)
  return { settings, update: mediaSettings.update, loaded }
}
