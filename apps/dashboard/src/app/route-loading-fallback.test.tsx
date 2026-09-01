import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  ROUTE_LOADING_DELAY_MS,
  RouteLoadingFallback,
} from "@/app/route-loading-fallback"

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
})
