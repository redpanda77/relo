import { AnimatePresence, LazyMotion, m } from "motion/react"
import * as React from "react"

import { DUR, EASE_IN, EASE_OUT, loadMotionFeatures, usePrefersReducedMotion } from "@/lib/motion"
import { cn } from "@/lib/utils"

/** Room for a focus ring or a hover lift while clipped. */
const CLIP = { overflow: "clip", overflowClipMargin: 6 } as const

/**
 * Content that opens and closes in place instead of pushing the form: its height goes 0 ↔ auto
 * (enter 260 ms ease-out, exit 180 ms ease-in), and the content fades and rises 4 px 40 ms after the
 * room opens. The only place the Dashboard animates height; under reduced motion it is instant.
 */
export function AnimatedHeight({
  show,
  children,
  className,
  innerClassName,
  initial = false,
}: {
  show: boolean
  children: React.ReactNode
  className?: string
  innerClassName?: string
  /** Animate when it is shown at mount (a message that appears with its parent). */
  initial?: boolean
}) {
  const reduced = usePrefersReducedMotion()
  const enter = reduced ? { duration: 0 } : { duration: DUR.base, ease: EASE_OUT }
  const leave = reduced ? { duration: 0 } : { duration: DUR.fast, ease: EASE_IN }
  return (
    <LazyMotion features={loadMotionFeatures} strict>
      <AnimatePresence initial={initial}>
        {show ? (
          <m.div
            key="content"
            data-slot="animated-height"
            className={className}
            style={CLIP}
            initial={{ height: 0 }}
            animate={{ height: "auto", transition: enter }}
            exit={{ height: 0, transition: leave }}
          >
            <m.div
              className={innerClassName}
              initial={{ opacity: 0, y: reduced ? 0 : 4 }}
              animate={{ opacity: 1, y: 0, transition: reduced ? { duration: 0 } : { ...enter, delay: 0.04 } }}
              exit={{ opacity: 0, transition: leave }}
            >
              {children}
            </m.div>
          </m.div>
        ) : null}
      </AnimatePresence>
    </LazyMotion>
  )
}

/**
 * Text that changes in a fixed line: the old words fade up and out (120 ms ease-in) while the new
 * ones rise in (180 ms ease-out), stacked in one grid cell so the line never collapses between them.
 */
export function CrossfadeText({
  value,
  children,
  className,
}: {
  /** What identifies the text; a change crossfades. Defaults to the children when they are a string. */
  value?: React.Key
  children: React.ReactNode
  className?: string
}) {
  const reduced = usePrefersReducedMotion()
  const key = value ?? (typeof children === "string" || typeof children === "number" ? children : "text")
  return (
    <LazyMotion features={loadMotionFeatures} strict>
      <span className={cn("inline-grid [grid-template-areas:'stack'] *:[grid-area:stack]", className)}>
        <AnimatePresence initial={false}>
          <m.span
            key={key}
            initial={{ opacity: 0, y: reduced ? 0 : 3 }}
            animate={{ opacity: 1, y: 0, transition: { duration: reduced ? 0.06 : DUR.fast, ease: EASE_OUT } }}
            exit={{ opacity: 0, y: reduced ? 0 : -3, transition: { duration: reduced ? 0.06 : DUR.micro, ease: EASE_IN } }}
          >
            {children}
          </m.span>
        </AnimatePresence>
      </span>
    </LazyMotion>
  )
}
