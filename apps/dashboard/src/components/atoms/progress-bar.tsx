import type * as React from "react"
import type { NeonTone } from "@/lib/status-tone"
import { cn } from "@/lib/utils"

/**
 * A thin progress track in a meaning tone, or a literal colour (a Live Activity accent). The fill
 * scales from its left edge (420 ms ease-out), never animating its width.
 */
export function ProgressBar({
  value,
  tone = "cyan",
  color,
  label,
  className,
}: {
  /** 0 to 1. */
  value: number
  /** A meaning tone, or `inherit` to take the surrounding card's `--tone`. */
  tone?: NeonTone | "inherit"
  color?: string
  label?: string
  className?: string
}) {
  const fraction = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0))
  const percent = Math.round(fraction * 100)
  return (
    <span
      role={label ? "progressbar" : undefined}
      aria-label={label}
      aria-valuenow={label ? percent : undefined}
      aria-valuemin={label ? 0 : undefined}
      aria-valuemax={label ? 100 : undefined}
      aria-hidden={label ? undefined : true}
      className={cn("progress-track block", color || tone === "inherit" ? null : `tone-${tone}`, className)}
      style={color ? ({ "--tone": color } as React.CSSProperties) : undefined}
    >
      <span data-value={percent} style={{ scale: `${fraction} 1` }} />
    </span>
  )
}
