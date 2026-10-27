// Relo's colour tokens, motion tokens and tone mappings, one for one with Relo for Mac.
// Sources (apps/notch/boringNotch/components/Relo/):
//   ReloNotchTheme.swift  lines 13-40  (every colour), 43-56 (tone colour), 58-70 (symbol), 72-85 (label)
//   ReloCards.swift       lines 43-53  (ReloMotion)
//   ReloOrb.swift         lines 38-52  (orb palettes per mood, the iPhone's ReloHoloTheme.colors(for:))
//   ReloAurora.swift      lines 21-30  (aurora backdrop)  ReloGlass.swift lines 17-110 (glass)
//   ReloOrbitWings.swift  lines 188-193 (painter colours)  sizing/matters.swift (closed sizes)
// Hex values are the Swift 0xRR/255 literals. A later step moves this into a shared package.

import type { Tone } from "../presentation"

export const COLORS = {
  mint: "#34d399", // ReloNotchTheme.swift:14
  orange: "#ff8a3d", // :15  (1, 0x8A, 0x3D)
  yellow: "#facc15", // :16
  red: "#f43f5e", // :17
  violet: "#8b7cff", // :18
  sky: "#7dd3fc", // :19
  azure: "#38bdf8", // :20
  blue: "#4d8dff", // :21
  coral: "#ff6b57", // :22
  amber: "#fbbf24", // :23
  emerald: "#10b981", // :24
  running: "#8b7cff", // :27  indigo
  runningSoft: "#c4bbff", // :29
  cyan: "#5ce1ff", // :31
  ice: "#e4f9ff", // :32
  signalCoral: "#ff7a66", // :35
  done: "#34d399", // :36
  info: "#94a3b8", // :37
  warning: "#fbbf24", // :38
  problem: "#f87171", // :39
  secondaryText: "rgb(255 255 255 / 0.6)", // :40 Color.white.opacity(0.6)
  tertiaryText: "rgb(255 255 255 / 0.4)", // :41
  /** ReloOrbitPainter.quiet: Color(white: 0.42), ReloOrbitWings.swift:193 (0.42 * 255 = 107). */
  quiet: "#6b6b6b",
} as const

/** The iPhone's holo pair as the Mac draws it, ReloNotchTheme.swift:33-34: cyan to violet, top-leading to bottom-trailing. */
export const HOLO_GRADIENT = `linear-gradient(135deg, ${COLORS.cyan}, ${COLORS.running})`
export const HOLO_DOWN_GRADIENT = `linear-gradient(180deg, ${COLORS.cyan}, ${COLORS.running})`

/** Colour per state: the iPhone's `HistoryServerOutcome.make`, ReloNotchTheme.swift:44-53. */
export function toneColor(tone: Tone): string {
  switch (tone) {
    case "needsYou":
    case "yourTurn":
      return COLORS.signalCoral
    case "working":
      return COLORS.running
    case "dropped":
    case "leftUnfinished":
      return COLORS.warning
    case "quiet":
    case "paused":
      return COLORS.info
    case "done":
      return COLORS.done
    case "failed":
      return COLORS.problem
  }
}

/** The SF Symbol the Mac draws per tone (ReloNotchTheme.swift:58-70); icons.tsx has the matching glyphs. */
export const TONE_SYMBOL: Readonly<Record<Tone, string>> = {
  needsYou: "exclamationmark.bubble.fill",
  yourTurn: "hand.raised.fill",
  working: "waveform",
  quiet: "moon.zzz",
  paused: "pause.fill",
  done: "checkmark",
  failed: "xmark.octagon.fill",
  dropped: "stop.fill",
  leftUnfinished: "exclamationmark.triangle.fill",
}

export function toneLabel(tone: Tone): string {
  return {
    needsYou: "Needs you",
    yourTurn: "Your turn",
    working: "Running",
    quiet: "Quiet",
    paused: "Paused",
    done: "Done",
    failed: "Failed",
    dropped: "Dropped",
    leftUnfinished: "Left unfinished",
  }[tone]
}

/**
 * ReloMotion (ReloCards.swift:43-48) as `motion` transitions. SwiftUI spring(response r, dampingFraction z) is a
 * damped spring with period r; `duration`/`bounce` in motion are the same model: bounce = 1 - z (z <= 1).
 * press 0.18/1, snappy 0.28/0.86, smooth 0.35/1, bouncy 0.42/0.72; base easeInOut 0.26, fast easeOut 0.18.
 */
export const MOTION = {
  press: { type: "spring", duration: 0.18, bounce: 0 },
  snappy: { type: "spring", duration: 0.28, bounce: 0.14 },
  smooth: { type: "spring", duration: 0.35, bounce: 0 },
  bouncy: { type: "spring", duration: 0.42, bounce: 0.28 },
  base: { duration: 0.26, ease: "easeInOut" },
  fast: { duration: 0.18, ease: "easeOut" },
} as const

/** CSS equivalents of the two eased curves (SwiftUI easeInOut / easeOut are cubic beziers). */
export const CSS_EASE = { inOut: "cubic-bezier(0.42, 0, 0.58, 1)", out: "cubic-bezier(0, 0, 0.58, 1)" } as const

/** BoringAnimations.animation (animations/drop.swift:17): `.spring(.bouncy(duration: 0.4))`. */
export const NOTCH_SPRING = { duration: 0.4, bounce: 0.3 } as const

/** The closed notch's corner radii and wing metrics: sizing/matters.swift:63, ReloClosedActivity.swift:93-100. */
export const CLOSED_METRICS = {
  cornerTop: 6,
  cornerBottom: 14,
  /** Outer margin (clear of the notch's rounded corner) and the gap to the housing. */
  outer: 6,
  gap: 8,
  /** The wing's content width while anything is live. */
  orbit: 58,
  /** Up to this many steps draw as segments; more read as one continuous bar. */
  maxSegments: 8,
  maxSatellites: 6,
  /** Hardware notch width the Mac reads from the screen (+4), 185 by default (getClosedNotchSize). */
  housing: 185,
} as const

export type Mood = "clear" | "running" | "needsYou"

/** ReloOrb.swift:38-52, the iPhone's ReloHoloTheme.colors(for:). */
export const ORB_PALETTE: Readonly<Record<Mood, readonly [string, string, string]>> = {
  clear: [COLORS.cyan, COLORS.blue, COLORS.violet],
  running: [COLORS.cyan, COLORS.sky, COLORS.azure],
  needsYou: [COLORS.orange, COLORS.coral, COLORS.amber],
}

/** ReloOrb.swift:30-36. */
export const ORB_ENERGY: Readonly<Record<Mood, number>> = { clear: 0.35, running: 0.7, needsYou: 1 }

/** ReloAurora.swift:21-33: near-black base, three blurred discs, a radial vignette. */
export const AURORA = {
  base: "rgb(8 8 14)", // Color(red: 0.03, green: 0.03, blue: 0.055) = 7.65, 7.65, 14.0
  blobAlpha: 0.5,
  blobs: [
    { color: COLORS.running, size: 0.95 },
    { color: COLORS.signalCoral, size: 0.72 },
    { color: COLORS.done, size: 0.6 },
  ],
  vignette: 0.6,
  driftSeconds: 11,
} as const

/** ReloGlass.swift: radius 20; panel fill white .085 to .03; hairline .13; top light .2; shadow black .22, radius 16, y 8. */
export const GLASS = {
  radius: 20,
  fillTop: 0.085,
  fillBottom: 0.03,
  hairline: 0.13,
  topLight: 0.2,
  shadow: { alpha: 0.22, radius: 16, y: 8 },
  backdrop: { tint: "rgb(8 9 18 / 0.6)", blobAlpha: 0.32, driftSeconds: 13 },
  wash: { stops: [0.36, 0.12], breathe: { calm: 2.1, urgent: 1.1 }, endRadius: 0.7 },
} as const
