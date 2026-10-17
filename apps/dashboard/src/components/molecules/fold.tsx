import { ChevronRight } from "lucide-react"
import * as React from "react"

import { AnimatedNumber } from "@/components/atoms/animated-number"
import { FoldOpenContext } from "@/components/molecules/fold-context"
import { cn } from "@/lib/utils"

/**
 * A folded group: one quiet line ("Waiting on you (2)") that opens in place. The label is the whole
 * summary text, so it reads the same to a screen reader; the chevron turns as it opens. It stays a
 * native <details>: the height eases open and shut (`::details-content` in styles/motion.css) and the
 * content fades in, where the browser supports it; elsewhere it simply opens. With `count`, the
 * number rolls to each new value and the chevron nudges toward it, so a fold reads as a destination.
 */
export function Fold({
  label,
  count,
  color,
  name,
  className,
  onOpenChange,
  children,
}: {
  label: string
  /** Shown as " (n)" after the label, rolling when it changes. */
  count?: number
  /** The label's meaning colour, when it has one. */
  color?: string
  /** `data-fold`, naming the fold for tests and styling. */
  name: string
  className?: string
  onOpenChange?: (open: boolean) => void
  children: React.ReactNode
}) {
  const [open, setOpen] = React.useState(false)
  // A changed count nudges the chevron once; the first paint does not (adjusted while rendering).
  const [seen, setSeen] = React.useState({ count, nudges: 0 })
  if (seen.count !== count) setSeen({ count, nudges: seen.nudges + 1 })
  return (
    <details
      data-fold={name}
      className={cn("fold group/fold", className)}
      onToggle={(event) => {
        const next = event.currentTarget.open
        setOpen(next)
        onOpenChange?.(next)
      }}
    >
      <summary className="fold-summary" style={color ? { color } : undefined}>
        <span
          key={seen.nudges}
          aria-hidden="true"
          className={cn("fold-chevron-wrap inline-flex", seen.nudges > 0 && "fold-nudge")}
        >
          <ChevronRight className="fold-chevron size-3.5 shrink-0 group-open/fold:rotate-90" />
        </span>
        <span>
          {label}
          {count != null ? (
            <>
              {" ("}
              <AnimatedNumber value={count} />
              {")"}
            </>
          ) : null}
        </span>
      </summary>
      <FoldOpenContext.Provider value={open}>
        <div className="fold-body pt-3">{children}</div>
      </FoldOpenContext.Provider>
    </details>
  )
}
