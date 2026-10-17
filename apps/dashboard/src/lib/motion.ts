import * as React from "react"

/**
 * The motion system in JS, mirroring the CSS tokens in `styles/motion.css`: one spring for things
 * that move, one ease for things that appear, one for things that leave. Seconds, as `motion` takes.
 */
export const DUR = { micro: 0.12, fast: 0.18, base: 0.26, slow: 0.42 } as const
export const EASE_OUT = [0.22, 1, 0.36, 1] as const
export const EASE_IN = [0.4, 0, 1, 1] as const
export const EASE_SHEET = [0.32, 0.72, 0, 1] as const
/**
 * Springs as Apple defines them (response, damping fraction), converted for `motion` (mass 1):
 * press for touch release, snappy for things that move (layout, indicators, sheets), smooth for
 * larger travel, bouncy only for success moments (never lists). CSS twins: `--spring-*` in motion.css.
 */
export const SPRINGS = {
  press: { type: "spring", stiffness: 1218, damping: 69.8, mass: 1 },
  snappy: { type: "spring", stiffness: 504, damping: 38.6, mass: 1 },
  smooth: { type: "spring", stiffness: 322, damping: 35.9, mass: 1 },
  bouncy: { type: "spring", stiffness: 224, damping: 21.5, mass: 1 },
} as const
/** The default for movement: `snappy`. */
export const SPRING = SPRINGS.snappy
/** One depth for every press. */
export const PRESS_SCALE = 0.97

/** Entering list items wait 40 ms each, capped at six, so a burst never trickles in. */
export const STAGGER = 0.04
export const STAGGER_CAP = 6

/** Motion's feature bundle, loaded after first paint: `<LazyMotion features={loadMotionFeatures} strict>`. */
export const loadMotionFeatures = () => import("@/lib/motion-features").then((module) => module.default)

/** Follows the system's reduced-motion setting live. */
export function usePrefersReducedMotion() {
  const [reduced, setReduced] = React.useState(() =>
    typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false
  )
  React.useEffect(() => {
    if (typeof window.matchMedia !== "function") return
    const query = window.matchMedia("(prefers-reduced-motion: reduce)")
    const update = () => setReduced(query.matches)
    update()
    query.addEventListener?.("change", update)
    return () => query.removeEventListener?.("change", update)
  }, [])
  return reduced
}
