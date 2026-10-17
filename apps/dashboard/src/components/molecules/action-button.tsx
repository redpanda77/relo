import { AnimatePresence, LazyMotion, m, useIsPresent } from "motion/react"
import * as React from "react"

import { CheckDraw, Spinner } from "@/components/atoms/check-draw"
import { Button } from "@/components/ui/button"
import { DUR, EASE_IN, EASE_OUT, loadMotionFeatures, usePrefersReducedMotion } from "@/lib/motion"
import { cn } from "@/lib/utils"
import { shakeElement } from "@/lib/use-shake"

/** Where an action stands: at rest, working, just succeeded, or just refused. */
export type ActionPhase = "idle" | "pending" | "success" | "error"

/** How long a success holds its short label before the button returns to rest. */
export const SUCCESS_HOLD_MS = 1600

type Shown = "idle" | "pending" | "success"
type Track = { signal: ActionPhase; shown: Shown; run: number; shake: boolean }

function next(track: Track, signal: ActionPhase, inferred: boolean, failed: boolean, successLabel: string | null): Track {
  let shown: Shown = "idle"
  let shake = false
  if (signal === "pending") shown = "pending"
  else if (signal === "success") shown = successLabel ? "success" : "idle"
  else if (signal === "error") shake = true
  else if (inferred && track.signal === "pending") {
    // `pending` fell: the outcome is `failed` (set in the same update), otherwise a success.
    if (failed) shake = true
    else shown = successLabel ? "success" : "idle"
  }
  return { signal, shown, run: track.run + 1, shake }
}

const enter = { duration: DUR.fast, ease: EASE_OUT }
const leave = { duration: DUR.micro, ease: EASE_IN }
// The resting label leaves upward and comes back from below, like every other state here.
const LABEL = {
  rest: { opacity: 1, y: 0, transition: enter },
  away: { opacity: 0, y: -3, transition: leave, transitionEnd: { y: 3 } },
}
const STILL = {
  rest: { opacity: 1, y: 0, transition: enter },
  away: { opacity: 0, y: 0, transition: leave },
}

/** A state layer over the label; once it is leaving, assistive technology no longer hears it. */
function Layer(props: React.ComponentProps<typeof m.span>) {
  const present = useIsPresent()
  return <m.span aria-hidden={present ? undefined : true} {...props} />
}

/**
 * A Button that shows what its action is doing without moving the page. Its width is the resting
 * label's for good (the label stays in flow, faded, while the other states sit over it), so nothing
 * beside it jumps. Pending crossfades the label to a 14 px spinner (old out up 3 px in 120 ms
 * ease-in, new in from 3 px below in 180 ms ease-out) and names the button `pendingLabel`; success
 * draws a checkmark with a short `successLabel` for 1.6 s, then rests; a failure shakes once.
 *
 * Drive it with `pending` (plus `failed`, set in the same update as `pending` falls) or with
 * `phase` (an OperationState's status): each change to success or error plays once.
 */
export function ActionButton({
  pending = false,
  failed = false,
  phase,
  pendingLabel = "Working…",
  successLabel = "Done",
  children,
  disabled,
  className,
  ref,
  ...props
}: React.ComponentProps<typeof Button> & {
  pending?: boolean
  failed?: boolean
  phase?: ActionPhase
  pendingLabel?: string
  /** A word or two ("Saved", "Done"); null skips the success state. */
  successLabel?: string | null
}) {
  const reduced = usePrefersReducedMotion()
  const signal: ActionPhase = phase ?? (pending ? "pending" : "idle")
  const [track, setTrack] = React.useState<Track>(() => ({
    signal,
    shown: signal === "pending" ? "pending" : "idle",
    run: 0,
    shake: false,
  }))
  if (track.signal !== signal) {
    // Adjusting state while rendering (React's sanctioned pattern): the change shows in this paint.
    setTrack(next(track, signal, phase === undefined, failed, successLabel))
  }
  const node = React.useRef<HTMLButtonElement | null>(null)
  const setNode = React.useCallback(
    (element: HTMLButtonElement | null) => {
      node.current = element
      if (typeof ref === "function") ref(element)
      else if (ref) ref.current = element
    },
    [ref]
  )

  const { run, shown, shake } = track
  React.useEffect(() => {
    if (shake) shakeElement(node.current, undefined, reduced)
    if (shown !== "success") return
    const timer = window.setTimeout(
      () => setTrack((current) => (current.run === run ? { ...current, shown: "idle" } : current)),
      SUCCESS_HOLD_MS
    )
    return () => window.clearTimeout(timer)
    // Once per transition: `run` changes exactly when the phase does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run])

  const travel = reduced ? 0 : 3
  const resting = shown === "idle"
  return (
    <Button
      ref={setNode}
      disabled={disabled || shown === "pending"}
      aria-busy={shown === "pending" || undefined}
      data-phase={shown}
      className={cn("relative", className)}
      {...props}
    >
      <LazyMotion features={loadMotionFeatures} strict>
        <m.span
          className="inline-flex items-center justify-center gap-[inherit]"
          aria-hidden={resting ? undefined : true}
          initial={false}
          variants={reduced ? STILL : LABEL}
          animate={resting ? "rest" : "away"}
        >
          {children}
        </m.span>
        <AnimatePresence>
          {shown === "pending" ? (
            <Layer
              key="pending"
              data-slot="action-pending"
              className="absolute inset-0 flex items-center justify-center"
              initial={{ opacity: 0, y: travel }}
              animate={{ opacity: 1, y: 0, transition: enter }}
              exit={{ opacity: 0, y: -travel, transition: leave }}
            >
              <Spinner />
              <span className="sr-only">{pendingLabel}</span>
            </Layer>
          ) : null}
          {shown === "success" ? (
            <Layer
              key="success"
              data-slot="action-success"
              className="absolute inset-0 flex items-center justify-center gap-1.5 whitespace-nowrap"
              initial={{ opacity: 0, y: travel }}
              animate={{ opacity: 1, y: 0, transition: enter }}
              exit={{ opacity: 0, y: -travel, transition: leave }}
            >
              <CheckDraw delay={0.06} />
              {successLabel}
            </Layer>
          ) : null}
        </AnimatePresence>
      </LazyMotion>
    </Button>
  )
}
