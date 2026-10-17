import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DashboardBootstrap } from "@/app/bootstrap"
import { isSealedOpening } from "@/lib/sealed-opening"

let linked = true
const listeners = new Set<() => void>()
const link = {
  accountId: "acct_test",
  isLinked: () => linked,
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}
const openSealedBootstrap = vi.fn()

vi.mock("@/lib/e2ee/browser-link", () => ({ currentBrowserLink: () => link }))
vi.mock("@/app/sealed-bootstrap", () => ({
  accountIdOf: () => "acct_test",
  openSealedBootstrap: (bootstrap: unknown) => openSealedBootstrap(bootstrap),
}))

const { useSealedRetry, SEALED_RETRY_MS } = await import("@/app/use-sealed-retry")

const locked = () => ({ kind: "projects", items: [{ encrypted: true }] }) as unknown as DashboardBootstrap

beforeEach(() => {
  vi.useFakeTimers()
  linked = true
  listeners.clear()
  openSealedBootstrap.mockReset()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("useSealedRetry", () => {
  it("tries again soon after the page appears and applies what opened", async () => {
    const page = locked()
    const opened = { kind: "projects", items: [{ encrypted: false }] } as unknown as DashboardBootstrap
    openSealedBootstrap.mockResolvedValueOnce(page).mockResolvedValueOnce(opened)
    const apply = vi.fn()
    renderHook(() => useSealedRetry(page, apply))
    await act(() => vi.advanceTimersByTimeAsync(SEALED_RETRY_MS[0]!))
    expect(openSealedBootstrap).toHaveBeenCalledTimes(1)
    expect(apply).not.toHaveBeenCalled()
    await act(() => vi.advanceTimersByTimeAsync(SEALED_RETRY_MS[1]!))
    expect(apply).toHaveBeenCalledWith(opened)
  })

  it("stops after its bounded attempts when items stay sealed (sent before the link)", async () => {
    const page = locked()
    openSealedBootstrap.mockResolvedValue(page)
    renderHook(() => useSealedRetry(page, vi.fn()))
    await act(() => vi.advanceTimersByTimeAsync(10 * 60_000))
    expect(openSealedBootstrap).toHaveBeenCalledTimes(SEALED_RETRY_MS.length)
  })

  it("does nothing for a page with nothing sealed", async () => {
    renderHook(() => useSealedRetry({ kind: "projects" } as unknown as DashboardBootstrap, vi.fn()))
    await act(() => vi.advanceTimersByTimeAsync(60_000))
    expect(openSealedBootstrap).not.toHaveBeenCalled()
  })

  it("opens the page in place the moment the browser becomes linked, saying so while it does", async () => {
    linked = false
    // No sealed flag on the page: a sessions list with handles still opens when linking.
    const page = { kind: "projects", sessions: [{ id: "ags_1" }] } as unknown as DashboardBootstrap
    const opened = { kind: "projects", sessions: [{ id: "ags_1", name: "relo" }] } as unknown as DashboardBootstrap
    let finish: (value: DashboardBootstrap) => void = () => undefined
    openSealedBootstrap.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    const apply = vi.fn()
    renderHook(() => useSealedRetry(page, apply))
    linked = true
    await act(async () => {
      for (const listener of listeners) listener()
    })
    expect(openSealedBootstrap).toHaveBeenCalledTimes(1)
    expect(isSealedOpening()).toBe(true)
    await act(async () => finish(opened))
    expect(apply).toHaveBeenCalledWith(opened)
    expect(isSealedOpening()).toBe(false)
  })
})
