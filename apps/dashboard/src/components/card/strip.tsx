import type * as React from "react"

import type { NeonTone } from "@/lib/status-tone"
import { cn } from "@/lib/utils"

/**
 * The one tinted note: a whisper of its meaning colour on the glass, an optional icon, label and
 * trailing node. `tint` (default) is the small inline strip (a question and what became of it);
 * `bordered` is the larger one that leads a page (the pending question on the detail). The words
 * stay plain: the icon and the label carry the colour.
 */
export function Strip({
  tone = "neutral",
  variant = "tint",
  icon,
  label,
  trailing,
  children,
  className,
  ...props
}: {
  tone?: NeonTone
  variant?: "tint" | "bordered"
  icon?: React.ReactNode
  /** A mono caption before the words ("Asks you"). */
  label?: React.ReactNode
  trailing?: React.ReactNode
  children?: React.ReactNode
  className?: string
} & Omit<React.ComponentProps<"div">, "children">) {
  return (
    <div data-slot="strip" data-variant={variant} className={cn("strip", `tone-${tone}`, className)} {...props}>
      {icon ? <span className="strip-icon" aria-hidden="true">{icon}</span> : null}
      {label ? <span className="strip-label">{label}</span> : null}
      {children != null ? <div className="strip-body">{children}</div> : null}
      {trailing ? <span className="strip-end">{trailing}</span> : null}
    </div>
  )
}
