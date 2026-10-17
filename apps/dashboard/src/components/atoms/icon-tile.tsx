import type * as React from "react"
import type { LucideIcon } from "lucide-react"

import type { NeonTone } from "@/lib/status-tone"
import { cn } from "@/lib/utils"

/**
 * The flat tile that leads a row: 30px (sm) or 36px (md), radius 8, the symbol in its tone over
 * a low-strength fill of it. Colour it with a meaning tone, or a project's own colour through
 * `color`. Neutral is the plain control fill. A new tone crossfades (`tint`).
 */
export function IconTile({
  icon: Icon,
  tone = "neutral",
  color,
  size = "sm",
  className,
}: {
  icon: LucideIcon
  tone?: NeonTone
  /** A literal colour (a project's palette slot); wins over `tone`. */
  color?: string
  size?: "sm" | "md"
  className?: string
}) {
  return (
    <span
      data-slot="icon-tile"
      data-size={size}
      className={cn("icon-tile tint", color ? null : `tone-${tone}`, className)}
      style={color ? ({ "--tone": color } as React.CSSProperties) : undefined}
      aria-hidden="true"
    >
      <Icon />
    </span>
  )
}
