import * as React from "react"

import { usePrefersReducedMotion } from "@/lib/motion"
import { cn } from "@/lib/utils"

const ROLL_MS = 600
/** --ease-out (cubic-bezier(.22, 1, .36, 1)) is the quintic ease-out. */
const easeOut = (t: number) => 1 - (1 - t) ** 5

/**
 * A count that rolls to its new value (0.6 s, ease-out) instead of jumping. The value itself is
 * plain text for assistive technology and tests; the rolling digits are a painted, hidden copy
 * (`::after` from `data-value`), so a screen reader never hears the frames. The first paint and
 * reduced motion show the value at once. A plain rAF tween: no animation library on this path.
 */
export function AnimatedNumber({
  value,
  className,
  style,
}: {
  value: number
  className?: string
  style?: React.CSSProperties
}) {
  const visual = React.useRef<HTMLSpanElement>(null)
  const shown = React.useRef(value)
  const reduced = usePrefersReducedMotion()

  // Before paint, so the painted copy never flashes the new value before it rolls.
  React.useLayoutEffect(() => {
    const node = visual.current
    if (!node) return
    const from = shown.current
    const paint = (n: number) => {
      shown.current = n
      node.dataset.value = String(Math.round(n))
    }
    if (from === value || reduced || typeof requestAnimationFrame !== "function") {
      paint(value)
      return
    }
    let frame = 0
    let start: number | undefined
    const step = (now: number) => {
      start ??= now
      const t = Math.min(1, (now - start) / ROLL_MS)
      paint(t === 1 ? value : from + (value - from) * easeOut(t))
      if (t < 1) frame = requestAnimationFrame(step)
    }
    node.dataset.value = String(Math.round(from))
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [value, reduced])

  return (
    <span className="animated-number">
      <span className="sr-only">{value}</span>
      <span ref={visual} aria-hidden="true" className={cn("animated-number-visual", className)} style={style} />
    </span>
  )
}
