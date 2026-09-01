import "@testing-library/jest-dom/vitest"

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
