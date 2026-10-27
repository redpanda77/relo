// The music model on the page. `MediaState` mirrors src-tauri/src/media/model.rs (serde camelCase); the settings are the
// Mac's Defaults for the Media page (Constants.swift), persisted by Rust as %APPDATA%\Relo\media.json.

export type Source = "nowPlaying" | "appleMusic" | "spotify" | "youtubeMusic"
export const SOURCES: ReadonlyArray<{ value: Source; label: string }> = [
  { value: "nowPlaying", label: "Now Playing" },
  { value: "appleMusic", label: "Apple Music" },
  { value: "spotify", label: "Spotify" },
  { value: "youtubeMusic", label: "YouTube Music" },
]

export type RepeatMode = "off" | "all" | "one"

export interface SessionBrief {
  appId: string
  appName: string
  playing: boolean
  title: string
  artist: string
  current: boolean
}

export interface MediaState {
  active: boolean
  title: string
  artist: string
  album: string
  isPlaying: boolean
  /** Position at `timestampMs` (Unix ms); use `positionAt` for now. */
  positionMs: number
  durationMs: number
  timestampMs: number
  rate: number
  isShuffled: boolean
  repeat: RepeatMode
  canSeek: boolean
  canPrev: boolean
  canNext: boolean
  shuffleSupported: boolean
  repeatSupported: boolean
  volumeSupported: boolean
  volume: number
  favoriteSupported: boolean
  isFavorite: boolean
  appId: string
  appName: string
  artwork: string | null
  sessions: SessionBrief[]
}

export const EMPTY_STATE: MediaState = {
  active: false,
  title: "",
  artist: "",
  album: "",
  isPlaying: false,
  positionMs: 0,
  durationMs: 0,
  timestampMs: 0,
  rate: 1,
  isShuffled: false,
  repeat: "off",
  canSeek: false,
  canPrev: false,
  canNext: false,
  shuffleSupported: false,
  repeatSupported: false,
  volumeSupported: false,
  volume: 0.5,
  favoriteSupported: false,
  isFavorite: false,
  appId: "",
  appName: "",
  artwork: null,
  sessions: [],
}

/** The player position now, in seconds, from a state read at `timestampMs` (the Mac's estimatedPlaybackPosition). */
export function positionAt(s: Pick<MediaState, "isPlaying" | "positionMs" | "timestampMs" | "rate" | "durationMs">, nowMs: number): number {
  let p = s.positionMs
  if (s.isPlaying && nowMs > s.timestampMs) p += (nowMs - s.timestampMs) * (s.rate > 0 ? s.rate : 1)
  if (s.durationMs > 0) p = Math.min(p, s.durationMs)
  return Math.max(0, p) / 1000
}

// ---- Slots (MusicControlButton.swift) ----

export const CONTROLS = ["shuffle", "previous", "playPause", "next", "repeatMode", "volume", "favorite", "goBackward", "goForward", "none"] as const
export type MusicControl = (typeof CONTROLS)[number]

// ---- Settings ----

export type SneakPeekStyle = "standard" | "inline"
export type HideNotchOption = "always" | "nowPlayingOnly" | "never"
export type SliderColor = "white" | "albumArt" | "accent"

export interface MediaSettings {
  source: Source
  /** Show music live activity in the closed notch. */
  liveActivity: boolean
  sneakPeek: boolean
  sneakPeekStyle: SneakPeekStyle
  /** Seconds after pausing before the player counts as idle (0..10). */
  waitInterval: number
  hideNotchOption: HideNotchOption
  lyrics: boolean
  slots: MusicControl[]
  coloredSpectrogram: boolean
  playerColorTinting: boolean
  /** Blurred album art behind the cover (lightingEffect). */
  lightingEffect: boolean
  sliderColor: SliderColor
  cornerRadiusScaling: boolean
}

export const SLOT_COUNT = 5
export const DEFAULT_SLOTS: MusicControl[] = ["none", "previous", "playPause", "next", "none"]

export const MEDIA_DEFAULTS: MediaSettings = {
  source: "nowPlaying",
  liveActivity: true,
  sneakPeek: false,
  sneakPeekStyle: "standard",
  waitInterval: 3,
  hideNotchOption: "nowPlayingOnly",
  lyrics: false,
  slots: DEFAULT_SLOTS,
  coloredSpectrogram: true,
  playerColorTinting: true,
  lightingEffect: true,
  sliderColor: "white",
  cornerRadiusScaling: true,
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d)
const oneOf = <T extends string>(v: unknown, all: readonly T[], d: T): T => (all.includes(v as T) ? (v as T) : d)

/** Any JSON in, complete valid settings out. Slots are always exactly five long. */
export function normalizeMedia(raw: unknown): MediaSettings {
  const r = isObj(raw) ? raw : {}
  const D = MEDIA_DEFAULTS
  const slots = Array.isArray(r.slots) ? r.slots.map((s) => oneOf<MusicControl>(s, CONTROLS, "none")) : [...D.slots]
  while (slots.length < SLOT_COUNT) slots.push("none")
  return {
    source: oneOf(r.source, SOURCES.map((s) => s.value), D.source),
    liveActivity: bool(r.liveActivity, D.liveActivity),
    sneakPeek: bool(r.sneakPeek, D.sneakPeek),
    sneakPeekStyle: oneOf(r.sneakPeekStyle, ["standard", "inline"] as const, D.sneakPeekStyle),
    waitInterval: typeof r.waitInterval === "number" && Number.isFinite(r.waitInterval) ? Math.round(Math.min(10, Math.max(0, r.waitInterval))) : D.waitInterval,
    hideNotchOption: oneOf(r.hideNotchOption, ["always", "nowPlayingOnly", "never"] as const, D.hideNotchOption),
    lyrics: bool(r.lyrics, D.lyrics),
    slots: dedupe(slots.slice(0, SLOT_COUNT)),
    coloredSpectrogram: bool(r.coloredSpectrogram, D.coloredSpectrogram),
    playerColorTinting: bool(r.playerColorTinting, D.playerColorTinting),
    lightingEffect: bool(r.lightingEffect, D.lightingEffect),
    sliderColor: oneOf(r.sliderColor, ["white", "albumArt", "accent"] as const, D.sliderColor),
    cornerRadiusScaling: bool(r.cornerRadiusScaling, D.cornerRadiusScaling),
  }
}

/** A control appears once: later duplicates become empty slots. */
function dedupe(slots: MusicControl[]): MusicControl[] {
  const seen = new Set<MusicControl>()
  return slots.map((s) => {
    if (s === "none") return s
    if (seen.has(s)) return "none"
    seen.add(s)
    return s
  })
}
