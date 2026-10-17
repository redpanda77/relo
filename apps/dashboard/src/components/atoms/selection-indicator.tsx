import { m } from "motion/react"

import { SPRING, usePrefersReducedMotion } from "@/lib/motion"
import { cn } from "@/lib/utils"

/**
 * The lit capsule behind the selected choice of a segmented control or a pill row. Render it inside
 * the selected option only, with one `layoutId` per control, under a `LazyMotion` (domMax): when the
 * choice changes it slides to the new option on the snappy spring instead of jumping. Under reduced
 * motion it moves at once. The option needs `position: relative; isolation: isolate` (`.pill` and
 * `.segment` have it): the capsule sits at z-index −1, under the label and above the option's face.
 */
export function SelectionIndicator({
  layoutId,
  variant = "pill",
  className,
}: {
  layoutId: string
  /** pill: the tinted capsule of a filter pill · segment: a raised thumb · row: a list row's selected fill. */
  variant?: "pill" | "segment" | "row"
  className?: string
}) {
  const reduced = usePrefersReducedMotion()
  return (
    <m.span
      layoutId={layoutId}
      aria-hidden="true"
      data-slot="selection-indicator"
      data-variant={variant}
      className={cn("selection-indicator pointer-events-none absolute inset-0", className)}
      transition={reduced ? { duration: 0 } : SPRING}
    />
  )
}
