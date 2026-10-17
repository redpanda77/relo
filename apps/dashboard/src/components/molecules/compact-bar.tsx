import { ChevronLeft } from "lucide-react"
import * as React from "react"

export type PageBack = {
  href: string
  /** Where the link goes, in words ("History"). */
  label: string
}

/** The span of scroll, in px, over which the large title hands over to the bar. */
const HANDOVER_PX = 24

/**
 * The phone's compact bar, as iOS collapses a large title, tied to the scroll: over the last 24px
 * of scroll before the page's h1 slides under the bar, the bar's frost fades in, the h1 fades out and the
 * bar's own title rises into place. One number drives it all (`--bar-p`, 0 to 1, set on the page
 * once per frame from a passive scroll listener); the blur radius itself never changes. A page with a
 * parent keeps a 44pt back chevron in the bar at all times. The h1 stays the page's only title (the
 * bar's copy is hidden from assistive technology); from 768px up the bar is not shown (`nav.css`).
 */
export function CompactBar({
  title,
  back,
  scopeRef,
}: {
  /** The title to show; read from the page's h1 when omitted. */
  title?: string
  back?: PageBack
  /** The page whose h1 the bar watches. */
  scopeRef: React.RefObject<HTMLElement | null>
}) {
  const [shown, setShown] = React.useState(false)
  const [headingText, setHeadingText] = React.useState("")
  const barRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const scope = scopeRef.current
    const heading = scope?.querySelector("h1")
    if (!scope || !heading) return
    setHeadingText(heading.textContent ?? "")
    heading.dataset.barTitle = "true"
    const phone = typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 767px)") : null
    let frame = 0
    let last = -1
    const measure = () => {
      frame = 0
      if (phone && !phone.matches) return
      const barBottom = barRef.current?.getBoundingClientRect().bottom || 44
      // The scroll at which the h1's foot meets the bar's; the handover is the 24px before it, never
      // before the top of the page (a title that starts close under the bar still starts unfaded).
      const scrolled = window.scrollY
      const end = scrolled + heading.getBoundingClientRect().bottom - barBottom
      const start = Math.max(0, end - HANDOVER_PX)
      const raw = end <= 0 ? scrolled / HANDOVER_PX : (scrolled - start) / Math.max(1, end - start)
      const progress = Math.min(1, Math.max(0, raw))
      const rounded = Math.round(progress * 100) / 100
      if (rounded === last) return
      last = rounded
      scope.style.setProperty("--bar-p", String(rounded))
      setShown(rounded >= 1)
    }
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure)
    }
    measure()
    window.addEventListener("scroll", schedule, { passive: true })
    window.addEventListener("resize", schedule, { passive: true })
    phone?.addEventListener?.("change", schedule)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener("scroll", schedule)
      window.removeEventListener("resize", schedule)
      phone?.removeEventListener?.("change", schedule)
      delete heading.dataset.barTitle
      scope.style.removeProperty("--bar-p")
    }
  }, [scopeRef, title])

  return (
    <div ref={barRef} className="compact-bar" data-shown={shown} data-back={back ? "true" : undefined}>
      <div className="compact-bar-row">
        {back ? (
          <a href={back.href} className="compact-bar-back" aria-label={`Back to ${back.label}`} data-page-back="true">
            <ChevronLeft aria-hidden="true" />
          </a>
        ) : null}
        <p className="compact-bar-title" aria-hidden="true">
          {title ?? headingText}
        </p>
      </div>
    </div>
  )
}
