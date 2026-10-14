/**
 * What a thing on the Now screen means. Mirrors the iPhone app's NowSignal / NowMix
 * (apps/ios/Sources/ReloCore/Policies/NowSignal.swift): every color maps to one meaning.
 */

export type RGB = [number, number, number]

export const rgbOf = (value: number): RGB => [(value >> 16) & 255, (value >> 8) & 255, value & 255]

export type Signal = "done" | "running" | "needsYou" | "attention" | "failed" | "message"

/** Display order. */
export const SIGNALS: readonly Signal[] = ["done", "running", "needsYou", "attention", "failed", "message"]

export const SIGNAL_LABEL: Record<Signal, string> = {
  done: "Done",
  running: "Running",
  needsYou: "Needs you",
  attention: "Attention",
  failed: "Failed",
  message: "Messages",
}

/** Light and deep shade per meaning (ReloHoloTheme.color / deep). */
export const SIGNAL_RAMP: Record<Signal, { light: RGB; deep: RGB }> = {
  done: { light: rgbOf(0x34d399), deep: rgbOf(0x10b981) },
  running: { light: rgbOf(0x5ce1ff), deep: rgbOf(0x4d8dff) },
  needsYou: { light: rgbOf(0xff8a3d), deep: rgbOf(0xff6b57) },
  attention: { light: rgbOf(0xfacc15), deep: rgbOf(0xfbbf24) },
  failed: { light: rgbOf(0xf43f5e), deep: rgbOf(0xbe123c) },
  message: { light: rgbOf(0x8b7cff), deep: rgbOf(0xd65cf0) },
}

/** The one CSS color for each meaning. */
export const SIGNAL_CSS: Record<Signal, string> = {
  done: "#34D399",
  running: "#5CE1FF",
  needsYou: "#FF8A3D",
  attention: "#FACC15",
  failed: "#F43F5E",
  message: "#8B7CFF",
}

/** Today's work by meaning. */
export type NowMix = Partial<Record<Signal, number>>

export const mixTotal = (mix: NowMix) => SIGNALS.reduce((sum, signal) => sum + (mix[signal] ?? 0), 0)

/** Present signals in display order with their share of the whole. */
export function mixShares(mix: NowMix): Array<{ signal: Signal; count: number; share: number }> {
  const total = Math.max(mixTotal(mix), 1)
  return SIGNALS.flatMap((signal) => {
    const count = mix[signal] ?? 0
    return count > 0 ? [{ signal, count, share: count / total }] : []
  })
}

/** The signal at a position along the mix (0...1), for coloring a particle by its slot. */
export function signalAt(mix: NowMix, position: number): Signal | null {
  const shares = mixShares(mix)
  let cumulative = 0
  for (const entry of shares) {
    cumulative += entry.share
    if (position < cumulative) return entry.signal
  }
  return shares.at(-1)?.signal ?? null
}

/** The Sessions section's violet (iOS ReloHoloTheme.sessions); not a work meaning, so not a Signal. */
export const SESSIONS_CSS = "#8B7CFF"
