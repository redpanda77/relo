import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DashboardBootstrap } from "@/app/bootstrap"
import { EncryptedText } from "@/components/atoms/encrypted-text"
import { setBrowserLinked, setSealedOpening } from "@/lib/sealed-opening"
import { ENCRYPTED_TEXT, SEALED_BEFORE_LINK_TEXT } from "@/lib/encrypted"

let resolveOpen: ((value: unknown) => void) | null = null
let linkStatus = "linked"
const link = {
  accountId: "acct_test",
  getState: () => ({ status: linkStatus }),
  subscribe: () => () => undefined,
  start: () => Promise.resolve(),
  startRotationTimer: () => undefined,
  opener: () => Promise.resolve({}),
}

vi.mock("@/lib/e2ee/browser-link", () => ({
  browserLinkFor: () => link,
  currentBrowserLink: () => link,
}))
vi.mock("@/lib/e2ee/open-sealed", () => ({
  openSealedTree: () => new Promise((resolve) => (resolveOpen = resolve)),
}))

const { openSealedFirst, SEALED_OPENING_CAP_MS } = await import("@/app/sealed-bootstrap")

const page = () =>
  ({ kind: "projects", shell: { account: { id: "acct_test" } } }) as unknown as DashboardBootstrap

beforeEach(() => {
  vi.useFakeTimers()
  resolveOpen = null
  window.localStorage.clear()
  setSealedOpening(false)
  setBrowserLinked(false)
  linkStatus = "linked"
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("sealed text on the first page", () => {
  it("an unlinked browser waits for nothing and says open on iPhone at once", async () => {
    window.localStorage.removeItem("relo-linked-browser:acct_test")
    linkStatus = "unlinked"
    const bootstrap = page()
    await expect(openSealedFirst(bootstrap, 800)).resolves.toBe(bootstrap)
    render(<EncryptedText />)
    expect(screen.getByText(ENCRYPTED_TEXT)).toBeInTheDocument()
  })

  it("a linked browser renders opened text that arrives within the budget", async () => {
    window.localStorage.setItem("relo-linked-browser:acct_test", "1")
    setBrowserLinked(true)
    const opened = { ...page(), opened: true } as unknown as DashboardBootstrap
    const first = openSealedFirst(page(), 800)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
      resolveOpen?.({ tree: opened })
    })
    await expect(first).resolves.toBe(opened)
  })

  it("a linked browser never says open on iPhone before the 5 s cap", async () => {
    window.localStorage.setItem("relo-linked-browser:acct_test", "1")
    setBrowserLinked(true)
    const bootstrap = page()
    const first = openSealedFirst(bootstrap, 800)
    await act(() => vi.advanceTimersByTimeAsync(800))
    await expect(first).resolves.toBe(bootstrap)
    render(<EncryptedText />)
    expect(screen.queryByText(SEALED_BEFORE_LINK_TEXT)).not.toBeInTheDocument()
    expect(screen.getByText("Opening on this device")).toBeInTheDocument()

    await act(() => vi.advanceTimersByTimeAsync(SEALED_OPENING_CAP_MS - 800 - 1))
    expect(screen.queryByText(SEALED_BEFORE_LINK_TEXT)).not.toBeInTheDocument()
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(screen.getByText(SEALED_BEFORE_LINK_TEXT)).toBeInTheDocument()
  })

  it("a linked browser whose open fails shows the honest lock then", async () => {
    window.localStorage.setItem("relo-linked-browser:acct_test", "1")
    setBrowserLinked(true)
    const bootstrap = page()
    void openSealedFirst(bootstrap, 800)
    await act(() => vi.advanceTimersByTimeAsync(800))
    render(<EncryptedText />)
    expect(screen.getByText("Opening on this device")).toBeInTheDocument()
    // Nothing could be opened: the tree comes back as it was.
    await act(async () => {
      resolveOpen?.({ tree: bootstrap })
      await vi.advanceTimersByTimeAsync(10)
    })
    expect(screen.getByText(SEALED_BEFORE_LINK_TEXT)).toBeInTheDocument()
  })
})
