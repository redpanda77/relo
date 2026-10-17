import * as React from "react"

import { usePrefersReducedMotion } from "@/lib/motion"

/** A refusal: a head-shake that settles (0, −8, 7, −5, 3, 0 px over 420 ms). */
const SHAKE_KEYFRAMES: Keyframe[] = [0, -8, 7, -5, 3, 0].map((x) => ({ transform: `translateX(${x}px)` }))
const SHAKE_TIMING: KeyframeAnimationOptions = { duration: 420, easing: "cubic-bezier(.36,.07,.19,.97)" }

function prefersReducedMotion() {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}

/**
 * Shakes an element once (the Web Animations API, so it composes with nothing and leaves no style
 * behind). Nothing moves under reduced motion or where the API is missing; `then` still runs.
 */
export function shakeElement(node: Element | null | undefined, then?: () => void, reduced = prefersReducedMotion()) {
  if (!node || reduced || typeof (node as HTMLElement).animate !== "function") {
    then?.()
    return
  }
  const animation = (node as HTMLElement).animate(SHAKE_KEYFRAMES, SHAKE_TIMING)
  if (then) animation.addEventListener("finish", then, { once: true })
}

/** Moves focus to a field that was refused and selects its text, so the next try replaces it. */
export function focusAndSelect(field: HTMLInputElement | HTMLTextAreaElement | null | undefined) {
  if (!field) return
  field.focus({ preventScroll: false })
  if (typeof field.select === "function") field.select()
}

/**
 * `const [ref, shake] = useShake<HTMLFormElement>()`: attach `ref`, call `shake()` on a refusal
 * (a wrong code, a wrong password, a failed action). Optionally pass the field to focus and select.
 */
export function useShake<T extends HTMLElement>() {
  const ref = React.useRef<T>(null)
  const reduced = usePrefersReducedMotion()
  const shake = React.useCallback(
    (field?: HTMLInputElement | HTMLTextAreaElement | null) => {
      focusAndSelect(field)
      shakeElement(ref.current, undefined, reduced)
    },
    [reduced]
  )
  return [ref, shake] as const
}
