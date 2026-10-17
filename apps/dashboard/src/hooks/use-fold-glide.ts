import * as React from "react"

/** The sidebar's sweep (`nav.css`, `sidebar.tsx`): the page glides on the same curve and time. */
const FOLD_MS = 300
const FOLD_EASE = "cubic-bezier(0.32, 0.72, 0, 1)"

/**
 * When the sidebar folds or opens, the page's column snaps to its new width in one layout (so a page
 * that changes its layout with the room it has, like Now's split, changes once, not every frame) and
 * then glides from where it stood to where it now is: a transform, on the sidebar's own curve, so
 * its left edge travels with the glass's edge. Nothing moves under reduced motion.
 */
export function useFoldGlide(
  ref: React.RefObject<HTMLElement | null>,
  open: boolean,
  enabled: boolean
) {
  const left = React.useRef<number | null>(null)

  React.useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const now = element.getBoundingClientRect().left
    const before = left.current
    left.current = now
    if (!enabled || before === null || typeof element.animate !== "function") return
    const delta = before - now
    if (Math.abs(delta) < 1) return
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return
    const glide = element.animate(
      [{ transform: `translateX(${delta}px)` }, { transform: "translateX(0)" }],
      { duration: FOLD_MS, easing: FOLD_EASE }
    )
    return () => glide.cancel()
  }, [ref, open, enabled])
}
