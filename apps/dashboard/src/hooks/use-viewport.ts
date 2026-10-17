import * as React from "react"

/** Tablets get the icon rail and an overlay drawer; at this width and up the sidebar pushes the page. */
export const TABLET_MIN = 768
export const DESKTOP_MIN = 1100

function inRange(min: number, max: number) {
  if (typeof window === "undefined") return false
  const width = window.innerWidth
  return width >= min && width < max
}

/**
 * Whether the window is between two widths (min inclusive, max exclusive). Read from innerWidth
 * (as `useIsMobile` does) and refreshed whenever either edge is crossed.
 */
export function useViewportRange(min: number, max: number) {
  const [matches, setMatches] = React.useState(() => inRange(min, max))

  React.useEffect(() => {
    const queries = [
      window.matchMedia(`(min-width: ${min}px)`),
      window.matchMedia(`(max-width: ${max - 1}px)`),
    ]
    const update = () => setMatches(inRange(min, max))
    queries.forEach((query) => query.addEventListener("change", update))
    update()
    return () => queries.forEach((query) => query.removeEventListener("change", update))
  }, [min, max])

  return matches
}

export function useIsTablet() {
  return useViewportRange(TABLET_MIN, DESKTOP_MIN)
}
