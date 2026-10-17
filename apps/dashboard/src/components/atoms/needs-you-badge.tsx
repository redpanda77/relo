import { cn } from "@/lib/utils"

/** The visible count: more than nine reads "9+", as on the iPhone. */
function needsYouLabel(count: number) {
  return count > 9 ? "9+" : String(count)
}

/**
 * The needs-you count in the meaning colour (orange): a number, or a dot on a folded icon. The
 * number is hidden from assistive technology and a sentence says it instead (", 3 need you"), since
 * an aria-label on a plain span is ignored. Nothing renders at zero.
 */
export function NeedsYouBadge({
  count,
  variant = "count",
  className,
}: {
  count: number
  variant?: "count" | "dot"
  className?: string
}) {
  if (count <= 0) return null
  return (
    <span className={cn("needs-you-badge", className)} data-variant={variant}>
      {variant === "count" ? <span aria-hidden="true">{needsYouLabel(count)}</span> : null}
      <span className="sr-only">{`, ${count} need you`}</span>
    </span>
  )
}
