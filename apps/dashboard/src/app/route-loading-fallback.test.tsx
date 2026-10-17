import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  ROUTE_LOADING_DELAY_MS,
  ROUTE_SLOW_MS,
  RouteLoadingFallback,
  RouteLoadingIndicator,
} from "@/app/route-loading-fallback"
import { setLoadingPage } from "@/app/loading-page"

describe("RouteLoadingFallback", () => {
  beforeEach(() => vi.useFakeTimers())

  afterEach(() => {
    cleanup()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it("stays visually silent for immediate route loads", () => {
    render(<RouteLoadingFallback />)

    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()
    expect(document.querySelector("main")).toHaveAttribute("aria-busy", "true")

    act(() => vi.advanceTimersByTime(ROUTE_LOADING_DELAY_MS - 1))
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()
  })

  it("reveals an accessible non-text progress rail for a real wait", () => {
    render(<RouteLoadingFallback />)

    act(() => vi.advanceTimersByTime(ROUTE_LOADING_DELAY_MS))

    const progress = screen.getByRole("progressbar", { name: "Loading page" })
    expect(progress).toBeInTheDocument()
    expect(progress).not.toHaveTextContent(/\S/u)
  })

  it("uses the page rhythm, so the title does not jump when the page arrives", () => {
    render(<RouteLoadingFallback />)
    const main = document.querySelector("main")!
    expect(main).toHaveClass("page")
    expect(main.className).not.toMatch(/\bp[xy]-\d/u)
    expect(main.querySelector(".page-frame")).not.toHaveClass("mx-auto")
  })

  it("finishes the rail when the load ends instead of dropping it, and leaves the progressbar role at once", () => {
    const { rerender } = render(<RouteLoadingIndicator active />)
    act(() => vi.advanceTimersByTime(ROUTE_LOADING_DELAY_MS))
    expect(screen.getByRole("progressbar", { name: "Loading page" })).toBeInTheDocument()

    rerender(<RouteLoadingIndicator active={false} />)
    // No Web Animations in jsdom: the finish completes at once and the rail goes.
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()
    expect(document.querySelector(".loading-rail")).toBeNull()
  })

  it("is indeterminate: a travelling segment, never a percentage", () => {
    render(<RouteLoadingIndicator active />)
    act(() => vi.advanceTimersByTime(ROUTE_LOADING_DELAY_MS))
    const rail = screen.getByRole("progressbar", { name: "Loading page" })
    expect(rail).not.toHaveAttribute("aria-valuenow")
    expect(rail.querySelector(".loading-rail-segment")).not.toBeNull()
    expect(rail).toHaveAttribute("data-tone", "loading")
  })

  it("after 3 s turns attention yellow and says it is still waiting on the server", () => {
    render(<RouteLoadingIndicator active />)
    act(() => vi.advanceTimersByTime(ROUTE_SLOW_MS - 1))
    expect(screen.queryByText("Still waiting on your server")).not.toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByRole("progressbar")).toHaveAttribute("data-tone", "slow")
    expect(screen.getByRole("status")).toHaveTextContent("Still waiting on your server")
  })

  it("an unreachable server holds a red line with a retry", () => {
    const onRetry = vi.fn()
    render(<RouteLoadingIndicator active={false} failed onRetry={onRetry} />)
    expect(screen.getByRole("progressbar", { name: "Page failed to load" })).toHaveAttribute("data-tone", "failed")
    const alert = screen.getByRole("alert")
    expect(alert).toHaveTextContent("Can't reach your server")
    act(() => screen.getByRole("button", { name: "Retry" }).click())
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it("wears the shape of the page that is loading: Now's deck, a titled list, a detail page", () => {
    setLoadingPage("inbox-overview", "Now")
    const now = render(<RouteLoadingFallback />)
    expect(document.querySelector('[data-loading-page="now"] .now-deck-stage.orb-stage')).not.toBeNull()
    expect(document.querySelectorAll("[data-readout]")).toHaveLength(4)
    // The placeholder title is not a heading: focus after a navigation goes to the real page's h1.
    expect(document.querySelector("h1")).toBeNull()
    now.unmount()

    setLoadingPage("connections", "Connections")
    const list = render(<RouteLoadingFallback />)
    expect(document.querySelector('[data-loading-page="list"] .page-title')).toHaveTextContent("Connections")
    list.unmount()

    setLoadingPage("notification-detail")
    render(<RouteLoadingFallback />)
    expect(document.querySelector('[data-loading-page="detail"] .page-title')).toHaveTextContent("Notification")
    setLoadingPage("connections")
  })

  it("marks the page that replaces the skeleton to fade in where it stood", () => {
    const { unmount } = render(<RouteLoadingFallback />)
    unmount()
    expect(document.documentElement).toHaveAttribute("data-page-enter", "fade")
  })
})
