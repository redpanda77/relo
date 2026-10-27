// The notch tells the Settings and onboarding windows where the account stands (`owner_state`) on every change of the
// owner's connection; they listen to drive their sign-in screens.

import { describe, expect, it, vi } from "vitest"

const reported: string[] = []
vi.mock("../local/api", () => ({
  onLocalSignIn: () => () => {},
  reportOwnerState: (state: string) => void reported.push(state),
}))

import { attachLocal } from "../local/notchLocal"

describe("owner_state", () => {
  it("is reported at once and on each change of the connection, not on every publish", () => {
    reported.length = 0
    let connection = "starting"
    const listeners = new Set<() => void>()
    const off = attachLocal({
      signInLocally: async () => {},
      signOut: async () => {},
      subscribe: (l) => (listeners.add(l), () => void listeners.delete(l)),
      getView: () => ({ connection }),
    })
    expect(reported).toEqual(["starting"])
    listeners.forEach((l) => l()) // a publish with nothing new
    connection = "signingIn"
    listeners.forEach((l) => l())
    connection = "live"
    listeners.forEach((l) => l())
    listeners.forEach((l) => l())
    expect(reported).toEqual(["starting", "signingIn", "live"])
    off()
    connection = "offline"
    listeners.forEach((l) => l())
    expect(reported).toEqual(["starting", "signingIn", "live"])
  })
})

describe("owner_state approval and problem", () => {
  it("carries approval and the problem text, and reports when either changes", async () => {
    const calls: Array<[string, unknown]> = []
    vi.resetModules()
    vi.doMock("../local/api", () => ({
      onLocalSignIn: () => () => {},
      reportOwnerState: (state: string, extra: unknown) => void calls.push([state, extra]),
    }))
    const { attachLocal: attach } = await import("../local/notchLocal")
    let view: { connection: string; approval: "waiting" | "approved" | null; problem: string | null } = { connection: "live", approval: "waiting", problem: null }
    const listeners = new Set<() => void>()
    attach({
      signInLocally: async () => {},
      signOut: async () => {},
      subscribe: (l) => (listeners.add(l), () => void listeners.delete(l)),
      getView: () => view,
    })
    view = { connection: "live", approval: "approved", problem: null }
    listeners.forEach((l) => l())
    view = { ...view, problem: "Keys not published" }
    listeners.forEach((l) => l())
    listeners.forEach((l) => l())
    expect(calls).toEqual([
      ["live", { approval: "waiting", problem: null }],
      ["live", { approval: "approved", problem: null }],
      ["live", { approval: "approved", problem: "Keys not published" }],
    ])
    vi.doUnmock("../local/api")
  })
})

describe("approvalOf", () => {
  it("is approved when the device is trusted, waiting only when a phone exists to ask", async () => {
    const { approvalOf } = await import("./view")
    expect(approvalOf({ connection: "live", deviceTrusted: true, phoneReceivesPushes: true })).toBe("approved")
    expect(approvalOf({ connection: "live", deviceTrusted: false, phoneReceivesPushes: true })).toBe("waiting")
    expect(approvalOf({ connection: "live", deviceTrusted: false, phoneReceivesPushes: false })).toBeNull()
    expect(approvalOf({ connection: "signedOut", deviceTrusted: true, phoneReceivesPushes: true })).toBeNull()
    expect(approvalOf({ connection: "live", deviceTrusted: null, phoneReceivesPushes: null })).toBeNull()
  })
})
