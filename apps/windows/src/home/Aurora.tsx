// Port of ReloAurora.swift (apps/notch/boringNotch/components/Relo/): the backdrop of Relo's own windows, slow light in
// the state colours on near black. Three blurred discs drift with one repeating CSS move (11 s ease-in-out,
// alternating), a vignette darkens the edges. Still with Reduce Motion (the app's setting sets data-reduce-motion on
// <html>; the OS setting is the media query); the rules are at the end of home.css. Home renders it; the onboarding
// window can too (it imports home.css). Hidden from assistive tech and in forced-colors mode.

import type { CSSProperties } from "react"
import { COLORS } from "../relo/ui/theme"

/** Disc size as a share of the width, drift start and end as shares of the width/height (ReloAurora.swift:21-30). */
export const AURORA_BLOBS = [
  { color: COLORS.running, size: 0.95, from: [0.08, -0.12], to: [-0.28, -0.32] },
  { color: COLORS.signalCoral, size: 0.72, from: [0.06, 0.36], to: [0.32, 0.08] },
  { color: COLORS.done, size: 0.6, from: [-0.36, 0.16], to: [-0.08, 0.42] },
] as const

export function Aurora({ intensity = 1 }: { intensity?: number }) {
  return (
    <div className="aurora" aria-hidden style={{ ["--aurora-i" as string]: String(0.5 * intensity) } as CSSProperties}>
      {AURORA_BLOBS.map((b) => (
        <i
          key={b.color}
          style={
            {
              ["--c" as string]: b.color,
              ["--s" as string]: b.size,
              ["--x0" as string]: b.from[0],
              ["--y0" as string]: b.from[1],
              ["--x1" as string]: b.to[0],
              ["--y1" as string]: b.to[1],
            } as CSSProperties
          }
        />
      ))}
      <b />
    </div>
  )
}
