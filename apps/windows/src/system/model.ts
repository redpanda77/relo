// The System tab's data and its pure helpers. Mac source: components/System/SystemMonitor.swift and SystemView.swift.
// The numbers come from Rust (`system_sample`, src-tauri/src/system); everything here is formatting and shaping.

export interface Sample {
  /** 0..1 */
  cpu: number
  cores: number[]
  memoryUsed: number
  memoryTotal: number
  storageFree: number
  storageTotal: number
  downBytesPerSecond: number
  upBytesPerSecond: number
  /** 0..1; null on a PC without a battery. */
  battery: number | null
  charging: boolean
  thermal: "nominal" | "fair" | "serious" | "critical"
}

export const EMPTY_SAMPLE: Sample = {
  cpu: 0,
  cores: [],
  memoryUsed: 0,
  memoryTotal: 0,
  storageFree: 0,
  storageTotal: 0,
  downBytesPerSecond: 0,
  upBytesPerSecond: 0,
  battery: null,
  charging: false,
  thermal: "nominal",
}

export const memoryShare = (s: Sample): number => (s.memoryTotal === 0 ? 0 : s.memoryUsed / s.memoryTotal)
export const storageShare = (s: Sample): number => (s.storageTotal === 0 ? 0 : 1 - s.storageFree / s.storageTotal)

/** Two minutes at one sample per 2 s. */
export const HISTORY_LENGTH = 60

/** Appends a reading; the first one fills the graph so it opens as a line, not a dot at the right edge. */
export function pushHistory(history: readonly number[], value: number): number[] {
  const base = history.length === 0 ? new Array<number>(HISTORY_LENGTH - 1).fill(value) : [...history]
  base.push(value)
  return base.length > HISTORY_LENGTH ? base.slice(base.length - HISTORY_LENGTH) : base
}

/** A core is drawn orange above this load (SystemView.swift CoreBars). */
export const HOT_CORE = 0.85
/** The battery chip turns red under this level unless charging. */
export const LOW_BATTERY = 0.2

export type BatteryGlyph = "empty" | "quarter" | "half" | "threeQuarters" | "full" | "charging"

export function batteryGlyph(level: number, charging: boolean): BatteryGlyph {
  if (charging) return "charging"
  if (level < 0.13) return "empty"
  if (level < 0.38) return "quarter"
  if (level < 0.63) return "half"
  if (level < 0.88) return "threeQuarters"
  return "full"
}

export const percent = (v: number): string => `${Math.round(v * 100)}%`

const UNITS = ["bytes", "KB", "MB", "GB", "TB", "PB"]

/** ByteCountFormatter: 1024-based, "8 GB", "15.4 GB", "512 MB", "Zero KB" for nothing. */
export function formatBytes(value: number): string {
  const v = Math.max(0, value)
  if (v === 0) return "Zero KB"
  let n = v
  let i = 0
  while (n >= 1024 && i < UNITS.length - 1) {
    n /= 1024
    i++
  }
  if (i === 0) return `${Math.round(n)} bytes`
  const text = n >= 100 || i <= 1 ? String(Math.round(n)) : n.toFixed(1).replace(/\.0$/, "")
  return `${text} ${UNITS[i]}`
}

export const formatRate = (bytesPerSecond: number): string => `${formatBytes(bytesPerSecond)}/s`

export interface Point {
  x: number
  y: number
}

/**
 * The sparkline's points in a `width` x `height` box, newest at the right, on a fixed 60-sample step so a young
 * history grows in from the right (SystemView.swift Sparkline). `relative` scales to the series' own peak.
 */
export function sparkPoints(values: readonly number[], width: number, height: number, relative = false): Point[] {
  if (values.length < 2) return []
  const peak = relative ? Math.max(Math.max(...values), 1) : 1
  const step = width / Math.max(HISTORY_LENGTH - 1, values.length - 1)
  const start = width - step * (values.length - 1)
  return values.map((v, i) => ({ x: start + step * i, y: height - 1 - (height - 2) * Math.min(1, Math.max(0, v) / peak) }))
}

/** The demo reading a browser shows (no Rust): so the tab can be previewed. */
export const DEMO_SAMPLE: Sample = {
  cpu: 0.34,
  cores: [0.62, 0.3, 0.18, 0.92, 0.22, 0.4, 0.12, 0.28, 0.5, 0.2, 0.1, 0.35],
  memoryUsed: 11.4 * 1024 ** 3,
  memoryTotal: 32 * 1024 ** 3,
  storageFree: 412 * 1024 ** 3,
  storageTotal: 953 * 1024 ** 3,
  downBytesPerSecond: 1.8 * 1024 ** 2,
  upBytesPerSecond: 96 * 1024,
  battery: 0.82,
  charging: false,
  thermal: "nominal",
}
