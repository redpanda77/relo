import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { handOffSkeleton } from "@/app/skeleton-handoff"

// The server's first frame on a list page: rows, and the words under them.
const SKELETON = `<div class="loading-shell" data-page-skeleton="list"><main><div class="page-stack">`
  + `<div class="glass loading-list" data-skeleton-rows><div class="loading-row"></div></div>`
  + `<div class="loading-frame-words"><p class="micro loading-words"><span class="loading-words-start">Starting Relo</span></p></div>`
  + `</div></main></div>`

const flush = () => new Promise((resolve) => queueMicrotask(() => resolve(undefined)))

beforeEach(() => {
  document.body.innerHTML = `<div id="root">${SKELETON}</div>`
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ top: 10, left: 10, width: 300, height: 60, right: 310, bottom: 70, x: 10, y: 10, toJSON: () => ({}) })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.innerHTML = ""
  delete document.documentElement.dataset.skeletonHandoff
  Reflect.deleteProperty(HTMLElement.prototype, "animate")
})

describe("the skeleton's hand-off", () => {
  it("leaves no copy of the placeholder behind, even when its fade never gets a frame", async () => {
    vi.useFakeTimers()
    // A hidden page: the fade is created but never finishes.
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: () => ({ onfinish: null }),
    })
    const handOff = handOffSkeleton()
    handOff()
    document.getElementById("root")!.innerHTML = "<main>React</main>"
    await flush()
    expect(document.querySelector(".loading-ghosts")).not.toBeNull()
    expect(document.documentElement.dataset.skeletonHandoff).toBe("true")

    vi.advanceTimersByTime(1000)
    expect(document.querySelector(".loading-ghosts")).toBeNull()
    expect(document.body.textContent).not.toContain("Starting Relo")
    expect(document.documentElement.dataset.skeletonHandoff).toBeUndefined()
  })

  it("shows no copies on a hidden page", async () => {
    vi.spyOn(document, "hidden", "get").mockReturnValue(true)
    const handOff = handOffSkeleton()
    handOff()
    document.getElementById("root")!.innerHTML = "<main>React</main>"
    await flush()
    expect(document.querySelector(".loading-ghosts")).toBeNull()
    expect(document.body.textContent).not.toContain("Starting Relo")
  })
})
