// The page's side of src-tauri/src/voice: commands in, `voice_progress` and `voice_state` events out. A no-op outside Tauri
// (tests, a plain browser).

import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window

/** The Relo voice's files (event `voice_progress`). */
export interface ModelStatus {
  state: "missing" | "downloading" | "ready" | "failed"
  /** 0...1 while downloading. */
  fraction: number
  downloadedBytes: number
  totalBytes: number
  error: string | null
  /** Waiting for a connection that is not metered to download on its own. */
  waitingForNetwork: boolean
  id: string
  revision: string
  directory: string
}

/** The line being prepared or played (event `voice_state`). */
export interface VoiceState {
  phase: "idle" | "preparing" | "playing"
  id: string | null
  engine: "relo" | "system"
  error: string | null
}

export interface RenderStats {
  loadMs: number
  firstAudioMs: number
  totalMs: number
  audioSecs: number
}

export interface VoiceStatus {
  model: ModelStatus
  state: VoiceState
  engine: "relo" | "system"
  /** The model is in memory now (it is freed after 300 s without a line). */
  loaded: boolean
  lastRender: RenderStats | null
}

/** What the orchestration needs of the voice; `tauriBackend` is the real one, tests pass a fake. */
export interface VoiceBackend {
  speak(lineId: string, text: string): Promise<void>
  cancel(): Promise<void>
  microphoneInUse(): Promise<boolean>
  onState(cb: (state: VoiceState) => void): () => void
}

function onEvent<T>(name: string, cb: (payload: T) => void): () => void {
  if (!inTauri) return () => {}
  const p = listen<T>(name, (e) => cb(e.payload))
  return () => void p.then((off) => off())
}

export const status = (): Promise<VoiceStatus | null> => (inTauri ? invoke<VoiceStatus>("voice_status").catch(() => null) : Promise.resolve(null))
/** At launch, when the voice mode speaks: fetch the voice if missing (on an unmetered connection), else warm it once. */
export const start = (): Promise<void> => (inTauri ? invoke<void>("voice_start").catch(() => {}) : Promise.resolve())
/** `auto`: only on a connection that is not metered (waits for one). Without it: now, the owner asked. */
export const download = (auto = false): Promise<void> => (inTauri ? invoke<void>("voice_download", { auto }).catch(() => {}) : Promise.resolve())
export const cancelDownload = (): Promise<void> => (inTauri ? invoke<void>("voice_download_cancel").catch(() => {}) : Promise.resolve())
export const deleteModel = (): Promise<void> => (inTauri ? invoke<void>("voice_delete").catch(() => {}) : Promise.resolve())
export const preview = (): Promise<void> => (inTauri ? invoke<void>("voice_preview").catch(() => {}) : Promise.resolve())
export const setEngine = (engine: "relo" | "system"): Promise<void> => (inTauri ? invoke<void>("voice_set_engine", { engine }).catch(() => {}) : Promise.resolve())
export const onProgress = (cb: (status: ModelStatus) => void): (() => void) => onEvent<ModelStatus>("voice_progress", cb)

export const tauriBackend: VoiceBackend = {
  async speak(lineId, text) {
    if (inTauri) await invoke("voice_speak", { lineId, text })
  },
  async cancel() {
    if (inTauri) await invoke("voice_cancel").catch(() => {})
  },
  async microphoneInUse() {
    return inTauri ? invoke<boolean>("voice_microphone_in_use").catch(() => false) : false
  },
  onState: (cb) => onEvent<VoiceState>("voice_state", cb),
}
