import { AnimatePresence, LazyMotion, m } from "motion/react"
import type * as React from "react"

import { DUR, EASE_IN, EASE_OUT, SPRING, loadMotionFeatures, usePrefersReducedMotion } from "@/lib/motion"
import type { NeonTone } from "@/lib/status-tone"
import { cn } from "@/lib/utils"

/**
 * The one badge, for state ("Waiting for approval", "This browser", "Live on iPhone") and plain
 * labels alike: a meaning colour, an optional icon, 20px high, mono caps (`sentence` for host and version labels). Soft is the tinted fill; hairline is
 * the quieter outline; `mono` sets a tool or version label in the mono face. Inline in a card's
 * header or footer, never a row of its own.
 *
 * A change of words crossfades (the old ones leave up 3 px, the new rise 3 px, 180 ms) while the
 * chip's width follows on the snappy spring; a change of tone crossfades through `--tone`.
 */
/** The meaning palette, plus the two accent tones a History card can carry. */
export type BadgeTone = NeonTone | "magenta" | "coral"

export function Badge({
  tone,
  icon,
  children,
  value,
  variant = "soft",
  mono = false,
  sentence = false,
  live = false,
  dot = false,
  label,
  title,
  part,
  className,
}: {
  tone: BadgeTone
  /** Leads the words; the meaning dot by default, `null` for none. */
  icon?: React.ReactNode
  children: React.ReactNode
  /** What identifies the words when they are not plain text; a change crossfades them. */
  value?: React.Key
  variant?: "soft" | "hairline"
  mono?: boolean
  /** Host and version labels: sentence case instead of caps. */
  sentence?: boolean
  /** A running chip: a light sweeps across it (motion allowed only). */
  live?: boolean
  /** The leading dot blinks (.45 to 1). */
  dot?: boolean
  /** An accessible name for the chip when its words need context ("Status: retry"). */
  label?: string
  /** A tooltip. */
  title?: string
  /** The card part this chip is (`data-part`), for tests and hooks. */
  part?: string
  className?: string
}) {
  const reduced = usePrefersReducedMotion()
  const key = value ?? (typeof children === "string" || typeof children === "number" ? children : "chip")
  const travel = reduced ? 0 : 3
  return (
    <LazyMotion features={loadMotionFeatures} strict>
      <m.span
        layout={!reduced}
        transition={{ layout: SPRING }}
        style={{ borderRadius: 999 }}
        data-slot="badge"
        data-variant={variant}
        data-mono={mono || undefined}
        data-case={sentence ? "sentence" : undefined}
        data-live={live || undefined}
        data-dot={dot || undefined}
        data-part={part}
        aria-label={label}
        title={title}
        className={cn("badge", `tone-${tone}`, className)}
      >
        {icon === undefined ? (
          <m.span layout={!reduced ? "position" : false} className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
        ) : (
          icon
        )}
        <AnimatePresence initial={false} mode="popLayout">
          <m.span
            key={key}
            layout={!reduced ? "position" : false}
            initial={{ opacity: 0, y: travel }}
            animate={{ opacity: 1, y: 0, transition: { duration: DUR.fast, ease: EASE_OUT } }}
            exit={{ opacity: 0, y: -travel, transition: { duration: DUR.micro, ease: EASE_IN } }}
          >
            {children}
          </m.span>
        </AnimatePresence>
      </m.span>
    </LazyMotion>
  )
}
