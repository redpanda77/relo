import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { NowSummary } from "@/features/inbox/now-model"

const later = { serverTime: "2026-10-16T12:05:00.000Z", refreshAt: null, recent: [] } as unknown as NowSummary
let resolveFetch: (value: unknown) => void = () => {}

vi.mock("@/app/dashboard-route-loader", () => ({
  fetchDashboardRoute: () => new Promise((resolve) => { resolveFetch = resolve }),
}))
vi.mock("@/features/inbox/now-model", () => ({ overviewNow: (bootstrap: { now: unknown }) => bootstrap.now }))
vi.mock("@/features/inbox/use-now-live", () => ({ connectNowLive: () => () => {} }))
vi.mock("@/lib/e2ee/browser-link", () => ({ currentBrowserLink: () => null }))

const { useNowRefresh } = await import("@/features/inbox/use-now-refresh")

afterEach(cleanup)

describe("useNowRefresh", () => {
  it("a new page object with the page load's older Now never replaces a later refetch", async () => {
    const loaded = { serverTime: "2026-10-16T12:00:00.000Z", refreshAt: null, recent: [] } as unknown as NowSummary
    const { result, rerender } = renderHook(({ initial }) => useNowRefresh("acct_test", initial), { initialProps: { initial: loaded } })
    await act(async () => resolveFetch({ kind: "dashboard", bootstrap: { now: later } }))
    expect(result.current.summary).toBe(later)
    // Sealed text opened in place: the same page load's summary in a new object.
    rerender({ initial: { ...loaded } as NowSummary })
    expect(result.current.summary).toBe(later)
  })
})
