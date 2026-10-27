import { describe, expect, it, vi } from "vitest"

const logged: string[] = []
vi.mock("./client/native", () => ({ logEvent: (_level: string, message: string) => void logged.push(message) }))

const { NotchBoundary } = await import("./NotchBoundary")

describe("NotchBoundary", () => {
  it("turns a render error into the problem state and logs it with the component stack", () => {
    const error = new Error("bad row")
    expect(NotchBoundary.getDerivedStateFromError(error)).toEqual({ error })
    const boundary = new NotchBoundary({ children: null })
    boundary.componentDidCatch(error, { componentStack: "\n    at Card\n    at Panel" })
    expect(logged.at(-1)).toContain("notch: render failed Error: bad row")
    expect(logged.at(-1)).toContain("at Card")
  })

  it("Try again clears the error and remounts the notch under a new key", () => {
    const boundary = new NotchBoundary({ children: null })
    let state = { error: new Error("x") as Error | null, key: 0 }
    boundary.setState = ((update: (s: typeof state) => typeof state) => void (state = { ...state, ...update(state) })) as never
    ;(boundary as unknown as { retry: () => void }).retry()
    expect(state).toEqual({ error: null, key: 1 })
  })
})
