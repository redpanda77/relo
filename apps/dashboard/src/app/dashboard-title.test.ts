import { afterEach, describe, expect, it } from "vitest"

import type { DashboardBootstrap } from "@/app/bootstrap"
import { dashboardTitle, dashboardWaiting } from "@/app/dashboard-title"
import { setFavicon, setLiveNeedsYou, waitingPrefix } from "@/lib/attention"

const page = (pending: number) =>
  ({ kind: "inbox-overview", shell: { title: "Now", counts: { pending } } }) as unknown as DashboardBootstrap

describe("the tab title", () => {
  it("leads with the bootstrap's count until Now has a live one", () => {
    expect(dashboardTitle(page(3))).toBe("(3) Now · Relo")
    expect(dashboardTitle(page(0))).toBe("Now · Relo")
  })

  it("follows Now's live count, including back to zero", () => {
    expect(dashboardTitle(page(3), 5)).toBe("(5) Now · Relo")
    expect(dashboardTitle(page(3), 0)).toBe("Now · Relo")
    expect(dashboardWaiting(page(3), 0)).toBe(0)
  })

  it("caps a long count", () => {
    expect(waitingPrefix(150)).toBe("(99+) ")
  })
})

describe("the favicon", () => {
  afterEach(() => {
    document.head.querySelectorAll('link[rel="icon"]').forEach((link) => link.remove())
    setLiveNeedsYou(null)
  })

  it("is one link, calm by default and coral while something needs you", () => {
    setFavicon(false)
    const link = document.head.querySelector('link[rel="icon"]')!
    const calm = link.getAttribute("href")
    expect(calm).toContain("data:image/svg+xml")
    setFavicon(true)
    expect(document.head.querySelectorAll('link[rel="icon"]')).toHaveLength(1)
    expect(decodeURIComponent(link.getAttribute("href")!)).toContain("#FF7A66")
    setFavicon(false)
    expect(link.getAttribute("href")).toBe(calm)
  })
})
