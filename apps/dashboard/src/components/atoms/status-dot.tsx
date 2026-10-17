import type * as React from "react"
import type { NeonTone } from "@/lib/status-tone"
import { cn } from "@/lib/utils"

/**
 * State as a dot in its meaning colour, with its word beside it when there is one: colour is never
 * the only cue. A live dot glows and breathes (still under reduced motion).
 */
export function StatusDot({
  tone,
  label,
  live = false,
  className,
}: {
  tone: NeonTone
  label?: React.ReactNode
  live?: boolean
  className?: string
}) {
  return (
    <span
      data-slot="status-dot"
      data-live={live ? "true" : undefined}
      className={cn("status-dot", `tone-${tone}`, className)}
      aria-hidden={label ? undefined : true}
    >
      {label}
    </span>
  )
}
