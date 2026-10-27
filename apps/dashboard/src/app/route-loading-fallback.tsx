import * as React from "react"

import { loadingPage, type SkeletonKind } from "@/app/loading-page"

import { markPageEnter } from "@/app/page-enter"
import { Readout } from "@/components/atoms/readout"
import { Notice } from "@/components/molecules/notice"
import { Button } from "@/components/ui/button"
import { GAUGES } from "@/lib/now-header"

/** A load quicker than this shows nothing at all. */
export const ROUTE_LOADING_DELAY_MS = 400
/** A wait this long turns the rail attention yellow and says so. */
export const ROUTE_SLOW_MS = 3000
/** Anything shown stays at least this long, so it never flickers. */
export const ROUTE_MIN_SHOWN_MS = 500

/** The arrival: the rail sweeps to the end (--dur-micro), then fades (--dur-fast). */
const SWEEP: KeyframeAnimationOptions = { duration: 120, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" }
const FADE: KeyframeAnimationOptions = { duration: 180, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" }

type Phase = "hidden" | "loading" | "done"

export type RouteLoadingProps = {
  /** A page is loading. */
  active?: boolean
  /** The last load could not reach the server: the rail stays, red, with a way to retry. */
  failed?: boolean
  onRetry?: () => void
}

/**
 * The hairline along the top while a page loads. Silent for a quick load (400 ms); then a coral
 * segment travels it, one lap per half breath, saying "working" without pretending to know how far.
 * After 3 s it turns attention yellow and says it is still waiting on the server. When the page
 * lands it sweeps to the end and fades; when the server cannot be reached it holds as a red line
 * with "Can't reach your server · Retry". Reduced motion: a still line.
 */
export function RouteLoadingIndicator({ active = true, failed = false, onRetry }: RouteLoadingProps) {
  const [phase, setPhase] = React.useState<Phase>(failed ? "loading" : "hidden")
  const [slow, setSlow] = React.useState(false)
  const [wasActive, setWasActive] = React.useState(active)
  const [shownAt, setShownAt] = React.useState(0)
  if (wasActive !== active) {
    setWasActive(active)
    if (active) {
      setSlow(false)
      if (phase !== "loading") setPhase("hidden")
    } else if (phase === "loading" && !failed) setPhase("done")
    else if (!failed) setPhase("hidden")
  }
  if (failed && phase !== "loading") setPhase("loading")

  React.useEffect(() => {
    if (!active || failed || phase !== "hidden") return
    const timer = window.setTimeout(() => {
      setShownAt(performance.now())
      setPhase("loading")
    }, ROUTE_LOADING_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [active, failed, phase])

  React.useEffect(() => {
    if (!active || failed) return
    const timer = window.setTimeout(() => setSlow(true), ROUTE_SLOW_MS)
    return () => window.clearTimeout(timer)
  }, [active, failed])

  if (phase === "hidden") return null
  const tone = failed ? "failed" : slow && phase === "loading" ? "slow" : "loading"
  return (
    <>
      <LoadingRail
        done={phase === "done"}
        tone={tone}
        shownAt={shownAt}
        onFinished={() => {
          setPhase("hidden")
          setSlow(false)
        }}
      />
      {tone === "slow" ? (
        <div className="loading-notice-host">
          <Notice tone="yellow" role="status" title="Still waiting on your server" />
        </div>
      ) : null}
      {tone === "failed" ? (
        <div className="loading-notice-host">
          <Notice
            tone="red"
            role="alert"
            title="Can't reach your server"
            action={
              onRetry ? (
                <Button size="sm" variant="outline" onClick={onRetry}>
                  Retry
                </Button>
              ) : null
            }
          />
        </div>
      ) : null}
    </>
  )
}

function LoadingRail({
  done,
  tone,
  shownAt,
  onFinished,
}: {
  done: boolean
  tone: "loading" | "slow" | "failed"
  shownAt: number
  onFinished: () => void
}) {
  const railRef = React.useRef<HTMLDivElement>(null)
  const fillRef = React.useRef<HTMLSpanElement>(null)
  const finished = React.useRef(onFinished)
  React.useEffect(() => {
    finished.current = onFinished
  })

  React.useEffect(() => {
    if (!done) return
    const rail = railRef.current
    const fill = fillRef.current
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
    // No Web Animations (or reduced motion, where the rail is a still line): it simply goes.
    if (!rail || !fill || typeof fill.animate !== "function" || reduced) {
      finished.current()
      return
    }
    let sweep: Animation | undefined
    let fade: Animation | undefined
    // Shown at least ROUTE_MIN_SHOWN_MS before it leaves.
    const hold = window.setTimeout(() => {
      sweep = fill.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], SWEEP)
      sweep.onfinish = () => {
        fade = rail.animate([{ opacity: 1 }, { opacity: 0 }], FADE)
        fade.onfinish = () => finished.current()
      }
    }, Math.max(0, ROUTE_MIN_SHOWN_MS - (performance.now() - shownAt)))
    return () => {
      window.clearTimeout(hold)
      sweep?.cancel()
      fade?.cancel()
    }
  }, [done, shownAt])

  return (
    <div
      ref={railRef}
      className="loading-rail"
      role={done ? undefined : "progressbar"}
      aria-label={done ? undefined : tone === "failed" ? "Page failed to load" : "Loading page"}
      aria-hidden={done ? "true" : undefined}
      data-phase={done ? "done" : "loading"}
      data-tone={tone}
    >
      <span className="loading-rail-segment" aria-hidden="true" />
      <span ref={fillRef} className="loading-rail-fill" aria-hidden="true" />
    </div>
  )
}

/**
 * The title as the page will set it, but not a heading: focus after a navigation goes to the real
 * page's h1, never to a placeholder that is about to leave.
 */
function SkeletonTitle({ title, eyebrow }: { title: string; eyebrow?: string }) {
  return (
    <div className="min-w-0" aria-hidden="true">
      <p className="page-title">{title}</p>
      {eyebrow ? <p className="mt-1 text-sm text-muted-foreground">{eyebrow}</p> : null}
    </div>
  )
}

/** When the skeleton gives way to the page, the page fades in where the skeleton stood. */
function useFadeInPageAfter() {
  React.useLayoutEffect(() => () => markPageEnter("fade"), [])
}

/** Now's work rows (the server's first frame draws the same, dashboard-skeleton.ts `WORK_ROW`). */
function SkeletonWorkRows({ count }: { count: number }) {
  return (
    <div className="glass loading-list loading-list-now" data-skeleton-rows>
      {Array.from({ length: count }, (_, row) => (
        <div key={row} className="loading-work-row">
          {["28%", "52%", "70%", "22%"].map((width) => (
            <span key={width}>
              <span className="skeleton loading-line" style={{ width }} />
            </span>
          ))}
        </div>
      ))}
    </div>
  )
}

function SkeletonRows({ count }: { count: number }) {
  return (
    <div className="glass loading-list" data-skeleton-rows>
      {Array.from({ length: count }, (_, row) => (
        <div key={row} className="loading-row">
          <div className="skeleton loading-row-tile" />
          <div className="loading-row-lines">
            <div className="skeleton loading-line" style={{ width: "40%" }} />
            <div className="skeleton loading-line loading-line-sm" style={{ width: "62%" }} />
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * The page's shape while its code loads, the same as the server's first frame (dashboard-skeleton.ts):
 * Now's deck with the core and readouts, a titled list, or a detail page. Its rail and shimmer
 * appear only once the wait is noticeable.
 */
export function RouteLoadingFallback({ kind: kindProp }: { kind?: SkeletonKind } = {}) {
  useFadeInPageAfter()
  const { kind: pendingKind, title } = loadingPage()
  const kind = kindProp ?? pendingKind
  if (kind === "now")
    return (
      <main id="main-content" aria-busy="true" className="split-page canvas" data-loading-page="now">
        <RouteLoadingIndicator />
        <div className="split-page-grid">
          <div className="split-page-aside">
            <section aria-label="Now overview" className="now-deck" data-state="clear">
              <header className="now-deck-head">
                <SkeletonTitle title="Now" />
              </header>
              <div className="orb-stage now-deck-stage" data-orb-stage="loading" data-loading-core>
                <span aria-hidden="true" className="orb-stage-painted" />
                <div className="orb-stage-centre">
                  <div aria-hidden="true" className="now-hud">
                    <div className="now-hud-frame">
                      <div className="now-deck-readouts">
                        {GAUGES.map((gauge) => (
                          <Readout key={gauge.key} label={gauge.label} value="–" color={gauge.color} lit={false} />
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </div>
          <div className="split-page-body page-stack" aria-hidden="true">
            {/* As React's Now opens: the "Since you looked" caption, its rows 10px under it. */}
            <div className="now-block">
              <section className="now-section now-since space-y-2.5">
                <p className="micro loading-heading">
                  <span className="skeleton loading-line" style={{ width: "7rem" }} />
                </p>
                <SkeletonWorkRows count={3} />
              </section>
            </div>
          </div>
        </div>
      </main>
    )
  return (
    <main id="main-content" aria-busy="true" className="page canvas relative" data-loading-page={kind}>
      <RouteLoadingIndicator />
      {/* The same frame as `Page`: the title sits exactly where the title will land. */}
      <div className="page-frame w-full max-w-[1120px]">
        <header className="flex flex-wrap items-end justify-between gap-4">
          {kind === "detail" ? (
            <SkeletonTitle title="Notification" eyebrow="Activity detail" />
          ) : title ? (
            <SkeletonTitle title={title} />
          ) : (
            <div className="skeleton h-[37px] w-44 sm:h-11" aria-hidden="true" />
          )}
        </header>
        <div className="page-stack mt-8" aria-hidden="true">
          {kind === "detail" ? (
            <div className="glass loading-detail" data-skeleton-rows>
              {["30%", "72%", "100%", "88%", "60%"].map((width, index) => (
                <div key={width} className={index === 1 ? "skeleton loading-line loading-line-lg" : "skeleton loading-line"} style={{ width }} />
              ))}
            </div>
          ) : (
            <SkeletonRows count={4} />
          )}
        </div>
      </div>
    </main>
  )
}
