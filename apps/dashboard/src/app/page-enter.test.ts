import { afterEach, describe, expect, it, vi } from "vitest"

import { classifyPageEnter, markPageEnter, PAGE_ENTER_MS } from "@/app/page-enter"

afterEach(() => {
  vi.useRealTimers()
  delete document.documentElement.dataset.pageEnter
})

describe("page entrances", () => {
  it("pushes into a detail page, pops only through its back link, and switches siblings as tabs", () => {
    expect(classifyPageEnter("notification-history", "notification-detail")).toBe("push")
    expect(classifyPageEnter("notification-history", "delivery-history")).toBe("push")
    expect(classifyPageEnter("notification-detail", "notification-history", true)).toBe("pop")
    // The tab bar out of a detail page is a sibling switch, not a pop.
    expect(classifyPageEnter("notification-detail", "connections")).toBe("tab")
    expect(classifyPageEnter("inbox-overview", "connections")).toBe("tab")
  })

  it("marks the entrance for its window only, and clears it for history traversal", () => {
    vi.useFakeTimers()
    markPageEnter("push")
    expect(document.documentElement).toHaveAttribute("data-page-enter", "push")
    vi.advanceTimersByTime(PAGE_ENTER_MS)
    expect(document.documentElement).not.toHaveAttribute("data-page-enter")

    markPageEnter("tab")
    markPageEnter(null)
    expect(document.documentElement).not.toHaveAttribute("data-page-enter")
  })
})
