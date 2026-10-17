import { Check, Copy } from "lucide-react"
import { AnimatePresence, LazyMotion, m } from "motion/react"
import * as React from "react"

import { Button } from "@/components/ui/button"
import { DUR, EASE_IN, EASE_OUT, SPRINGS, loadMotionFeatures, usePrefersReducedMotion } from "@/lib/motion"
import { cn } from "@/lib/utils"

/** How long "Copied" holds before the button returns to its label. */
export const COPIED_HOLD_MS = 1500

/**
 * Copies `value` and says so where the owner is looking: the copy icon turns into a check (scale
 * .6 → 1 on the press spring, 180 ms crossfade) and the label becomes "Copied" at the label's own
 * width, for 1.5 s. The result is announced politely unless the page announces it itself
 * (`announce={false}`). When the clipboard refuses, `onFailed` runs (select the text for a manual copy).
 */
export function CopyButton({
  value,
  label,
  copiedLabel = "Copied",
  announce = true,
  onCopied,
  onFailed,
  className,
  variant = "outline",
  size = "default",
  ...props
}: Omit<React.ComponentProps<typeof Button>, "value" | "onClick" | "children"> & {
  value: string
  label: string
  copiedLabel?: string
  announce?: boolean
  onCopied?: () => void
  onFailed?: (cause: unknown) => void
}) {
  const reduced = usePrefersReducedMotion()
  const [copied, setCopied] = React.useState(0)

  React.useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(0), COPIED_HOLD_MS)
    return () => window.clearTimeout(timer)
  }, [copied])

  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable")
      await navigator.clipboard.writeText(value)
      setCopied((count) => count + 1)
      onCopied?.()
    } catch (cause) {
      setCopied(0)
      onFailed?.(cause)
    }
  }

  const done = copied > 0
  const fade = { duration: reduced ? 0.06 : DUR.fast, ease: EASE_OUT }
  const out = { duration: reduced ? 0.06 : DUR.micro, ease: EASE_IN }
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      data-copied={done ? "true" : undefined}
      className={cn("copy-button", className)}
      onClick={() => void copy()}
      {...props}
    >
      <LazyMotion features={loadMotionFeatures} strict>
        <span className="relative inline-grid size-4 place-items-center [grid-template-areas:'stack'] *:[grid-area:stack] [[data-size=xs]_&]:size-3 [[data-size=sm]_&]:size-3.5" aria-hidden="true">
          <AnimatePresence initial={false}>
            <m.span
              key={done ? "check" : "copy"}
              className="grid place-items-center [&_svg]:size-full"
              initial={{ opacity: 0, scale: reduced ? 1 : 0.6 }}
              animate={{ opacity: 1, scale: 1, transition: { opacity: fade, scale: SPRINGS.press } }}
              exit={{ opacity: 0, scale: reduced ? 1 : 0.6, transition: out }}
            >
              {done ? <Check /> : <Copy />}
            </m.span>
          </AnimatePresence>
        </span>
        {/* Both words share one cell, so "Copied" never changes the button's width. */}
        <span className="inline-grid [grid-template-areas:'stack'] *:[grid-area:stack]">
          <m.span
            initial={false}
            animate={{ opacity: done ? 0 : 1, transition: done ? out : fade }}
            aria-hidden={done || undefined}
          >
            {label}
          </m.span>
          <m.span
            initial={false}
            animate={{ opacity: done ? 1 : 0, transition: done ? fade : out }}
            aria-hidden={done ? undefined : true}
            className="text-center"
          >
            {copiedLabel}
          </m.span>
        </span>
      </LazyMotion>
      {announce ? (
        <span className="sr-only" aria-live="polite">
          {done ? copiedLabel : ""}
        </span>
      ) : null}
    </Button>
  )
}
