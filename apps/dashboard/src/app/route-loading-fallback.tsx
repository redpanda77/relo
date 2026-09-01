import * as React from "react"

export const ROUTE_LOADING_DELAY_MS = 240

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

export function RouteLoadingFallback() {

  return (
    <main
      id="main-content"
      aria-busy="true"
      className="canvas relative min-h-[100dvh]"
    >
      <RouteLoadingIndicator />
    </main>
  )
}
