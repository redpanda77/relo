// Relo for Windows' settings: one typed object, persisted by Rust as %APPDATA%\Relo\settings.json and broadcast to every
// window as `settings_changed`. Reads never fail (anything missing or malformed falls back to the default per field);
// writes merge a patch into the latest state, so two windows changing different fields do not undo each other.
// The notch adopts it with `useSettings()` (or `createSettingsStore`/`settingsStore` outside React).

import { useSyncExternalStore } from "react"
import { EVENT_KINDS, type NotchEventKind } from "../sound/cues"
import type { SoundSettings } from "../sound/player"
import { normalizeLocal } from "../local/setup"
import * as ipc from "./ipc"
import { resume, STAGES, type AgentRow, type Place, type Progress, type RowStatus, type SignIn } from "./onboarding/stages"

export const VOICE_MODES = ["soundOnly", "soundThenVoice", "soundAsKind", "voiceOnly"] as const
export type VoiceMode = (typeof VOICE_MODES)[number]
export const VOICE_DETAILS = ["brief", "full", "verbose"] as const
export type VoiceDetail = (typeof VOICE_DETAILS)[number]
export const ENCRYPTION = ["auto", "always"] as const
export type EncryptionPolicy = (typeof ENCRYPTION)[number]
export const ACCENTS = ["running", "cyan", "mint", "signalCoral"] as const
export type Accent = (typeof ACCENTS)[number]
/** "relo" = the Relo voice (Phonon), "system" = the Windows voice (the Mac's `ReloVoice.Engine`). */
export const VOICE_ENGINES = ["relo", "system"] as const
export type VoiceEngine = (typeof VOICE_ENGINES)[number]
/** The Mac's `WindowHeightMode` for a display without a notch (every Windows display): menu bar, real notch, custom. */
export const NOTCH_HEIGHT_MODES = ["menuBar", "real", "custom"] as const
export type NotchHeightMode = (typeof NOTCH_HEIGHT_MODES)[number]
/** Closed-notch height in CSS px for the two fixed modes (the Mac's non-notch 24 and 32). */
export const NOTCH_HEIGHT_PRESETS = { menuBar: 24, real: 32 } as const
export const NOTCH_HEIGHT_MIN = 15
export const NOTCH_HEIGHT_MAX = 45
/** Gesture sensitivity: 100 High, 200 Medium, 300 Low (the Mac's slider). */
export const GESTURE_SENSITIVITIES = [100, 200, 300] as const
/** The actions a shortcut can be bound to (src/shortcuts.ts). */
export const SHORTCUT_ACTIONS = ["toggleSneakPeek", "toggleNotchOpen"] as const
export type ShortcutActionId = (typeof SHORTCUT_ACTIONS)[number]

export interface ReloSettings {
  // Relo (account, updates). `serverOrigin` and `accountEmail` are written by the notch when the account changes.
  serverOrigin: string | null
  accountEmail: string | null
  autoInstallUpdates: boolean
  encryption: EncryptionPolicy
  // Alerts
  closedActivity: boolean
  peek: boolean
  sounds: boolean
  interfaceSounds: boolean
  soundEvents: Record<NotchEventKind, boolean>
  quietInFullScreen: boolean
  // Voice
  voiceMode: VoiceMode
  voiceDetail: VoiceDetail
  /** "Show a play button on cards". */
  voiceButton: boolean
  voiceEngine: VoiceEngine
  // General
  showTrayIcon: boolean
  /** Preferred display id (the Windows device name); null = primary. */
  display: string | null
  /** Which height the closed notch has: the menu-bar preset (24), the real-notch preset (32) or `notchHeight`. */
  notchHeightMode: NotchHeightMode
  /** CSS px of the closed notch, 15..45; follows the preset while the mode is not "custom". */
  notchHeight: number
  openOnHover: boolean
  /** Seconds the pointer rests before the notch opens, 0..1. */
  hoverDelay: number
  rememberLastTab: boolean
  lastTab: string | null
  // Gestures (src-tauri/src/gestures.rs)
  enableGestures: boolean
  closeGesture: boolean
  gestureSensitivity: (typeof GESTURE_SENSITIVITIES)[number]
  // Appearance
  accent: Accent
  reduceMotion: boolean
  alwaysShowTabs: boolean
  settingsIconInNotch: boolean
  // Advanced
  hideFromScreenRecording: boolean
  /** The Mac's `enableShadow` (default on): the notch's shadow while open or hovered. Consumed by Notch.tsx (C01). */
  enableShadow: boolean
  /** The Mac's `extendHoverArea` (default off): the pointer opens the notch from a larger area around it. Consumed by Notch.tsx (G12). */
  extendHoverArea: boolean
  /** The Mac's `automaticallySwitchDisplay` (default on): the notch follows the display the owner is working on. Consumed by displays.rs (D01). */
  autoSwitchDisplay: boolean
  /** The Mac's `showOnAllDisplays` (default off): a notch on every display; the main one on the primary display, mirrors elsewhere (src-tauri/src/mirrors.rs). */
  showOnAllDisplays: boolean
  // Shortcuts: `{action: accelerator}`; a missing action keeps its default, "" is unbound (Rust reads this at launch)
  shortcuts: Partial<Record<ShortcutActionId, string>>
  // Settings window / onboarding
  lastPage: string | null
  /** Set when the first-run onboarding was finished; its absence opens the onboarding at launch. */
  onboardingDone: boolean
  onboarding: Progress | null
}

export const DEFAULTS: ReloSettings = {
  serverOrigin: null,
  accountEmail: null,
  autoInstallUpdates: true,
  encryption: "auto",
  closedActivity: true,
  peek: true,
  sounds: true,
  interfaceSounds: true,
  soundEvents: Object.fromEntries(EVENT_KINDS.map((k) => [k, true])) as Record<NotchEventKind, boolean>,
  quietInFullScreen: true,
  voiceMode: "soundOnly",
  voiceDetail: "full",
  voiceButton: true,
  voiceEngine: "relo",
  showTrayIcon: true,
  display: null,
  notchHeightMode: "real",
  notchHeight: 32,
  openOnHover: true,
  hoverDelay: 0.3,
  rememberLastTab: false,
  lastTab: null,
  enableGestures: true,
  closeGesture: true,
  gestureSensitivity: 200,
  accent: "running",
  reduceMotion: false,
  alwaysShowTabs: true,
  settingsIconInNotch: true,
  hideFromScreenRecording: false,
  enableShadow: true,
  extendHoverArea: false,
  autoSwitchDisplay: true,
  showOnAllDisplays: false,
  shortcuts: {},
  lastPage: null,
  onboardingDone: false,
  onboarding: null,
}

// ---- Normalising what the file holds ----

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d)
const str = (v: unknown, max = 512): string | null => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null)
const oneOf = <T extends string>(v: unknown, all: readonly T[], d: T): T => (all.includes(v as T) ? (v as T) : d)
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d)

/** The mode a saved height means when the file has no mode (or a wrong one). */
export function modeOfHeight(height: number): NotchHeightMode {
  return height === NOTCH_HEIGHT_PRESETS.menuBar ? "menuBar" : height === NOTCH_HEIGHT_PRESETS.real ? "real" : "custom"
}

export function normalizeShortcuts(raw: unknown): Partial<Record<ShortcutActionId, string>> {
  const out: Partial<Record<ShortcutActionId, string>> = {}
  if (!isObj(raw)) return out
  for (const a of SHORTCUT_ACTIONS) if (typeof raw[a] === "string" && (raw[a] as string).length <= 40) out[a] = raw[a] as string
  return out
}

const ROW_STATUS: readonly RowStatus[] = ["pending", "running", "done", "failed", "skipped"]

export function normalizeProgress(raw: unknown): Progress | null {
  if (!isObj(raw)) return null
  const stage = oneOf(raw.stage, STAGES, "hello")
  const agents = (Array.isArray(raw.agents) ? raw.agents : [])
    .filter(isObj)
    .flatMap((a) => (str(a.id, 32) && str(a.name, 64) ? [{ id: a.id as string, name: a.name as string }] : []))
  const rows: AgentRow[] = (Array.isArray(raw.rows) ? raw.rows : []).filter(isObj).flatMap((r) =>
    str(r.id, 32) && str(r.name, 64)
      ? [{ id: r.id as string, name: r.name as string, status: oneOf(r.status, ROW_STATUS, "pending"), message: str(r.message, 400) ?? undefined }]
      : [],
  )
  return {
    stage,
    place: oneOf<Place>(raw.place, ["local", "server"], "local"),
    origin: typeof raw.origin === "string" ? raw.origin.slice(0, 300) : "",
    signIn: oneOf<SignIn>(raw.signIn, ["idle", "waiting", "signedIn"], "idle"),
    agents,
    selected: (Array.isArray(raw.selected) ? raw.selected : []).filter((s): s is string => typeof s === "string").slice(0, 32),
    rows,
    local: normalizeLocal(raw.local),
  }
}

/** The mode and height together: a preset mode pins its height, a custom one keeps the (clamped) height. */
function normalizeHeight(r: Record<string, unknown>): Pick<ReloSettings, "notchHeightMode" | "notchHeight"> {
  const height = Math.round(num(r.notchHeight, NOTCH_HEIGHT_MIN, NOTCH_HEIGHT_MAX, DEFAULTS.notchHeight))
  const mode = oneOf(r.notchHeightMode, NOTCH_HEIGHT_MODES, modeOfHeight(height))
  return mode === "custom" ? { notchHeightMode: mode, notchHeight: height } : { notchHeightMode: mode, notchHeight: NOTCH_HEIGHT_PRESETS[mode] }
}

/** Any JSON in, a complete valid ReloSettings out. */
export function normalize(raw: unknown): ReloSettings {
  const r = isObj(raw) ? raw : {}
  const ev = isObj(r.soundEvents) ? r.soundEvents : {}
  const D = DEFAULTS
  return {
    serverOrigin: str(r.serverOrigin, 300),
    accountEmail: str(r.accountEmail, 320),
    autoInstallUpdates: bool(r.autoInstallUpdates, D.autoInstallUpdates),
    encryption: oneOf(r.encryption, ENCRYPTION, D.encryption),
    closedActivity: bool(r.closedActivity, D.closedActivity),
    peek: bool(r.peek, D.peek),
    sounds: bool(r.sounds, D.sounds),
    interfaceSounds: bool(r.interfaceSounds, D.interfaceSounds),
    soundEvents: Object.fromEntries(EVENT_KINDS.map((k) => [k, bool(ev[k], true)])) as Record<NotchEventKind, boolean>,
    quietInFullScreen: bool(r.quietInFullScreen, D.quietInFullScreen),
    voiceMode: oneOf(r.voiceMode, VOICE_MODES, D.voiceMode),
    voiceDetail: oneOf(r.voiceDetail, VOICE_DETAILS, D.voiceDetail),
    voiceButton: bool(r.voiceButton, D.voiceButton),
    voiceEngine: oneOf(r.voiceEngine, VOICE_ENGINES, D.voiceEngine),
    showTrayIcon: bool(r.showTrayIcon, D.showTrayIcon),
    display: str(r.display, 200),
    ...normalizeHeight(r),
    openOnHover: bool(r.openOnHover, D.openOnHover),
    hoverDelay: Math.round(num(r.hoverDelay, 0, 1, D.hoverDelay) * 10) / 10,
    rememberLastTab: bool(r.rememberLastTab, D.rememberLastTab),
    lastTab: str(r.lastTab, 64),
    enableGestures: bool(r.enableGestures, D.enableGestures),
    closeGesture: bool(r.closeGesture, D.closeGesture),
    gestureSensitivity: (Math.min(300, Math.max(100, Math.round(num(r.gestureSensitivity, 100, 300, D.gestureSensitivity) / 100) * 100)) as ReloSettings["gestureSensitivity"]),
    accent: oneOf(r.accent, ACCENTS, D.accent),
    reduceMotion: bool(r.reduceMotion, D.reduceMotion),
    alwaysShowTabs: bool(r.alwaysShowTabs, D.alwaysShowTabs),
    settingsIconInNotch: bool(r.settingsIconInNotch, D.settingsIconInNotch),
    hideFromScreenRecording: bool(r.hideFromScreenRecording, D.hideFromScreenRecording),
    enableShadow: bool(r.enableShadow, D.enableShadow),
    extendHoverArea: bool(r.extendHoverArea, D.extendHoverArea),
    autoSwitchDisplay: bool(r.autoSwitchDisplay, D.autoSwitchDisplay),
    showOnAllDisplays: bool(r.showOnAllDisplays, D.showOnAllDisplays),
    shortcuts: normalizeShortcuts(r.shortcuts),
    lastPage: str(r.lastPage, 32),
    onboardingDone: bool(r.onboardingDone, D.onboardingDone),
    onboarding: normalizeProgress(r.onboarding),
  }
}

export type SettingsPatch = Partial<ReloSettings>

/** Merge a patch into settings; a patch's `soundEvents` and `shortcuts` merge per key, then the result is normalised. */
export function applyPatch(current: ReloSettings, patch: SettingsPatch): ReloSettings {
  const { soundEvents, shortcuts, ...rest } = patch
  return normalize({
    ...current,
    ...rest,
    soundEvents: soundEvents ? { ...current.soundEvents, ...soundEvents } : current.soundEvents,
    shortcuts: shortcuts ? { ...current.shortcuts, ...shortcuts } : current.shortcuts,
  })
}

/** What the cue player reads (src/sound): the Alerts and Voice settings as its SoundSettings. */
export function toSoundSettings(s: ReloSettings): SoundSettings {
  return { sounds: s.sounds, interfaceSounds: s.interfaceSounds, events: { ...s.soundEvents }, voiceOnly: s.voiceMode === "voiceOnly" }
}

/** Voice modes that speak (the Mac's `ReloVoiceMode.speaks`). */
export function speaks(mode: VoiceMode): boolean {
  return mode !== "soundOnly"
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

// ---- The store ----

export interface SettingsIO {
  read(): Promise<unknown>
  write(value: ReloSettings): Promise<void>
  /** Subscribe to other windows' writes; returns the unsubscribe. */
  subscribe(cb: (raw: unknown) => void): () => void
}

export interface SettingsStore {
  get(): ReloSettings
  isLoaded(): boolean
  /** Reads the file once (idempotent) and starts listening for `settings_changed`. */
  start(): Promise<void>
  update(patch: SettingsPatch): void
  onChange(cb: () => void): () => void
}

export function createSettingsStore(io: SettingsIO): SettingsStore {
  let state = DEFAULTS
  let loaded = false
  let starting: Promise<void> | null = null
  const listeners = new Set<() => void>()
  let queue: Promise<void> = Promise.resolve()

  const set = (next: ReloSettings) => {
    if (deepEqual(next, state)) return
    state = next
    listeners.forEach((l) => l())
  }

  return {
    get: () => state,
    isLoaded: () => loaded,
    start() {
      starting ??= (async () => {
        io.subscribe((raw) => set(normalize(raw)))
        const first = normalize(await io.read())
        // A restart cannot resume a CLI run that was in flight.
        set({ ...first, onboarding: first.onboarding && resume(first.onboarding) })
        loaded = true
        listeners.forEach((l) => l())
      })()
      return starting
    },
    update(patch) {
      const next = applyPatch(state, patch)
      if (deepEqual(next, state)) return
      set(next)
      // Writes go one at a time, each carrying the latest state.
      queue = queue.then(() => io.write(state)).catch(() => {})
    },
    onChange(cb) {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
  }
}

/** The app's one store, backed by Rust. */
export const settingsStore = createSettingsStore({
  read: ipc.settingsRead,
  write: (v) => ipc.settingsWrite(v),
  subscribe: ipc.onSettingsChanged,
})

/** `const { settings, update, loaded } = useSettings()`: live settings in any window. */
export function useSettings(): { settings: ReloSettings; update: (patch: SettingsPatch) => void; loaded: boolean } {
  const settings = useSyncExternalStore(
    (cb) => {
      void settingsStore.start()
      return settingsStore.onChange(cb)
    },
    settingsStore.get,
  )
  const loaded = useSyncExternalStore(settingsStore.onChange, settingsStore.isLoaded)
  return { settings, update: settingsStore.update, loaded }
}
