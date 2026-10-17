import { m } from "motion/react"

import { DUR, EASE_OUT, usePrefersReducedMotion } from "@/lib/motion"
import { cn } from "@/lib/utils"

/**
 * A checkmark that draws itself (stroke, 260 ms ease-out): the moment something succeeded. Shown at
 * once under reduced motion. Render inside a `LazyMotion` (every motion molecule already is).
 */
export function CheckDraw({ className, delay = 0 }: { className?: string; delay?: number }) {
  const reduced = usePrefersReducedMotion()
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-3.5 shrink-0", className)}
      aria-hidden="true"
      data-slot="check-draw"
    >
      <m.path
        d="M5 12.5l4.5 4.5L19 7.5"
        initial={{ pathLength: reduced ? 1 : 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: reduced ? 0 : DUR.base, ease: EASE_OUT, delay: reduced ? 0 : delay }}
      />
    </svg>
  )
}

/** The 14 px working spinner: a quarter arc turning on a steady beat (still under reduced motion). */
export function Spinner({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={cn("action-spinner size-3.5 shrink-0", className)} aria-hidden="true" data-slot="spinner">
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeOpacity="0.22" strokeWidth="1.75" />
      <path d="M8 1.75a6.25 6.25 0 0 1 6.25 6.25" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  )
}
