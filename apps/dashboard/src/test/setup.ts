import "@testing-library/jest-dom/vitest"
import { configure } from "@testing-library/react"
import { MotionGlobalConfig } from "motion/react"

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(key, String(value)) },
  }
}

Object.defineProperty(globalThis, "localStorage", { configurable: true, value: memoryStorage() })
Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: memoryStorage() })
Object.defineProperty(window, "localStorage", { configurable: true, value: globalThis.localStorage })
Object.defineProperty(window, "sessionStorage", { configurable: true, value: globalThis.sessionStorage })

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: query.includes("max-width") && window.innerWidth < 768,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }),
})

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

Object.defineProperty(window, "ResizeObserver", { value: ResizeObserverMock })
Object.defineProperty(globalThis, "ResizeObserver", { value: ResizeObserverMock })
Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { value: () => undefined })
Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", { value: () => false })
Object.defineProperty(HTMLElement.prototype, "setPointerCapture", { value: () => undefined })
Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", { value: () => undefined })

// jsdom has no frames to animate: motion jumps to each end state, so exits remove at once.
MotionGlobalConfig.skipAnimations = true

// findBy and waitFor wait up to 5 s, not 1: the release gates run on a capped builder where a busy moment
// stretches a render past a second (two tests failed that way on 20 Oct, never on a fast machine).
configure({ asyncUtilTimeout: 5000 })
