import * as React from "react"

export const ROUTE_LOADING_DELAY_MS = 400

function DelayedRouteLoadingIndicator() {
  const [visible, setVisible] = React.useState(false)

  React.useEffect(() => {
    const timer = window.setTimeout(
      () => setVisible(true),
      ROUTE_LOADING_DELAY_MS
    )
    return () => window.clearTimeout(timer)
  }, [])

  if (!visible) return null

  return (
    <div
      className="route-loading-progress"
      role="progressbar"
      aria-label="Loading page"
    >
      <span className="route-loading-progress-indicator" aria-hidden="true" />
    </div>
  )
}

export function RouteLoadingIndicator({ active = true }: { active?: boolean }) {
  return active ? <DelayedRouteLoadingIndicator /> : null
}

/** The page's shape while its code loads: a title and a frosted list, shimmering. */
export function RouteLoadingFallback() {
  return (
    <main
      id="main-content"
      aria-busy="true"
      className="canvas relative min-h-[100dvh] px-4 py-6 sm:px-8 sm:py-8 lg:px-12 lg:py-12"
    >
      <RouteLoadingIndicator />
      <div className="mx-auto w-full max-w-5xl" aria-hidden="true">
        <div className="skeleton h-9 w-44" />
        <div className="skeleton mt-3 h-4 w-64" />
        <div className="glass mt-10 divide-y divide-white/[0.06] overflow-hidden rounded-[20px]">
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="flex items-center gap-3 px-4 py-4">
              <div className="skeleton size-10 shrink-0 rounded-xl" />
              <div className="flex-1 space-y-2">
                <div className="skeleton h-3.5 w-2/5" />
                <div className="skeleton h-3 w-3/5" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  )
}
