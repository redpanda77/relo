import * as React from "react"

import { SECTION_CAPTION_CLASS } from "@/components/list"
import { cn } from "@/lib/utils"

/**
 * A section of the panel: the section caption, a hairline above (except the first), the content. Sections are
 * separated by lines, never nested in cards; an inner group is a `PanelBox`.
 */
export const PanelSection = React.forwardRef<
  HTMLElement,
  { id: string; title: string; description?: React.ReactNode; first?: boolean; children: React.ReactNode }
>(function PanelSection({ id, title, description, first = false, children }, ref) {
  const headingId = `${id}-heading`
  return (
    <section ref={ref} id={id} aria-labelledby={headingId} data-panel-section className={cn("scroll-mt-16 px-4 pb-6 sm:px-6", !first && "border-t border-[var(--divider)] pt-6")}>
      <h2 id={headingId} className={cn(SECTION_CAPTION_CLASS, "mb-3")}>{title}</h2>
      {description ? <p className="-mt-1 mb-3 max-w-[65ch] text-sm leading-6 text-muted-foreground">{description}</p> : null}
      {children}
    </section>
  )
})

/** An inner group inside a section: radius 14, a hairline, white 3% (DESIGN.md, "Inner boxes"). */
export function PanelBox({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div className={cn("rounded-[14px] border border-[var(--hairline)] bg-white/[0.03]", className)} {...props}>
      {children}
    </div>
  )
}
