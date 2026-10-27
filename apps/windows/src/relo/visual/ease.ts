// The easing helpers of the Mac's painter, one for one: ReloOrbitWings.swift `enum Ease` (lines 160-168).

export const Ease = {
  clamp: (x: number): number => Math.min(1, Math.max(0, x)),
  /** Progress of `s` through the window [a, b], 0...1. */
  seg: (s: number, a: number, b: number): number => Ease.clamp((s - a) / (b - a)),
  out: (x: number): number => 1 - Math.pow(1 - x, 3),
  inOut: (x: number): number => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  outBack: (x: number): number => {
    const c1 = 1.70158
    const c3 = c1 + 1
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2)
  },
  spring: (x: number): number => (x <= 0 ? 0 : 1 - Math.exp(-7 * x) * Math.cos(12 * x)),
  decay: (s: number, at: number, k = 3): number => (s < at ? 0 : Math.exp(-(s - at) * k)),
} as const

/** Swift's `truncatingRemainder(dividingBy:)` (sign of the dividend). */
export const rem = (a: number, b: number): number => a % b

/** Seconds since 2001-01-01 UTC: `Date.timeIntervalSinceReferenceDate`, the clock the Mac's light runs on. */
export const REFERENCE_EPOCH_MS = 978_307_200_000
export const referenceSeconds = (nowMs: number): number => (nowMs - REFERENCE_EPOCH_MS) / 1000
