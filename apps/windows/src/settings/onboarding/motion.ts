// The onboarding's motion, with the Web Animations API (the Mac's ReloCards cascade, the orb's touch ripple, the window
// collapsing onto the notch). Each helper is a no-op where the API is missing (tests), and callers skip them for reduced motion.

/** Elements rise 12 px, 80 ms apart, the sixth and later together (OnboardingView.swift:271, ReloCards.swift:55-68). */
export const RISE_PX = 12
export const STAGGER_MS = 80
export const STAGGER_CAP = 6

/** The delay of the `index`-th element of a screen. */
export function staggerDelay(index: number): number {
  return Math.min(Math.max(0, index), STAGGER_CAP - 1) * STAGGER_MS
}

const canAnimate = (el: Element | null): el is HTMLElement => el !== null && typeof (el as HTMLElement).animate === "function"

/** A page turn: every child of `root` fades and rises into place, staggered. */
export function cascade(root: HTMLElement): void {
  Array.from(root.children).forEach((child, i) => {
    if (!canAnimate(child)) return
    child.animate(
      [
        { opacity: 0, transform: `translateY(${RISE_PX}px)` },
        { opacity: 1, transform: "none" },
      ],
      { duration: 360, delay: staggerDelay(i), easing: "cubic-bezier(0.22, 0.8, 0.3, 1)", fill: "backwards" },
    )
  })
}

/** The orb's touch: one ring of light spreading over two seconds (ReloTouchRipple). */
export function ripple(ring: HTMLElement | null): void {
  if (!canAnimate(ring)) return
  ring.animate(
    [
      { opacity: 0.6, transform: "scale(0.4)" },
      { opacity: 0, transform: "scale(1.6)" },
    ],
    { duration: 2000, easing: "cubic-bezier(0.2, 0.7, 0.3, 1)", fill: "none" },
  )
}

/** Start: the window's content shrinks up toward the notch and fades (the Mac's 56 x 68 collapse). Resolves when done; `undo` restores it. */
export async function collapseToNotch(): Promise<() => void> {
  const el = typeof document === "undefined" ? null : document.body
  if (!canAnimate(el)) return () => {}
  el.style.transformOrigin = "50% 0"
  const a = el.animate(
    [
      { transform: "none", opacity: 1 },
      { transform: "translateY(-24px) scale(0.1, 0.1)", opacity: 0 },
    ],
    { duration: 420, easing: "cubic-bezier(0.5, 0, 0.8, 0.4)", fill: "forwards" },
  )
  await a.finished.catch(() => undefined)
  return () => {
    a.cancel()
    el.style.transformOrigin = ""
  }
}
