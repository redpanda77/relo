// The closed notch's spectrum (components/Music/MusicVisualizer.swift): thin capsules, 2 pt wide, resting at 35% height.
// The Mac animates random heights; here five bands of the real output drive them (Rust loopback), only while `active`.

import { useEffect, useRef } from "react"
import { barScale, BAND_COUNT, watchBands } from "./bands"

const H = 14
const W = 2
const GAP = 1.5

export function Visualizer({ active, color }: { active: boolean; color: string }) {
  const bars = useRef<Array<HTMLSpanElement | null>>([])

  const paint = (levels: ArrayLike<number>) => {
    for (let i = 0; i < BAND_COUNT; i++) {
      const el = bars.current[i]
      if (el) el.style.transform = `scaleY(${barScale(levels[i] ?? 0)})`
    }
  }

  useEffect(() => {
    if (!active) {
      paint([])
      return
    }
    const off = watchBands(paint)
    return () => {
      off()
      paint([])
    }
  }, [active])

  return (
    <span aria-hidden className="inline-flex items-center" style={{ height: H, width: BAND_COUNT * W + (BAND_COUNT - 1) * GAP, gap: GAP }}>
      {Array.from({ length: BAND_COUNT }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            bars.current[i] = el
          }}
          style={{ width: W, height: H, borderRadius: W / 2, background: color, transform: `scaleY(${barScale(0)})`, transition: "transform 60ms linear, background 300ms" }}
        />
      ))}
    </span>
  )
}
