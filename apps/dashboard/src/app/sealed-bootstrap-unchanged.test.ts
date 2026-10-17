import { beforeEach, describe, expect, it, vi } from "vitest"

import type { DashboardBootstrap } from "@/app/bootstrap"

const openSealedTree = vi.fn()
const link = { accountId: "acct_test", opener: async () => ({}) }

vi.mock("@/lib/e2ee/browser-link", () => ({ currentBrowserLink: () => link, browserLinkFor: () => link }))
vi.mock("@/lib/e2ee/open-sealed", () => ({ openSealedTree: (tree: unknown) => openSealedTree(tree) }))

const { openSealedBootstrap } = await import("@/app/sealed-bootstrap")

const page = () => ({ kind: "inbox-overview", shell: { account: { id: "acct_test" } }, items: [{ title: "Deploy" }] }) as unknown as DashboardBootstrap

beforeEach(() => openSealedTree.mockReset())

describe("openSealedBootstrap", () => {
  it("returns the same page when the open changed nothing (names it already shows), so retries stop", async () => {
    const bootstrap = page()
    openSealedTree.mockResolvedValue({ tree: structuredClone(bootstrap), opened: 0 })
    expect(await openSealedBootstrap(bootstrap)).toBe(bootstrap)
  })

  it("returns the opened page when something new opened", async () => {
    const bootstrap = page()
    const opened = { ...structuredClone(bootstrap), items: [{ title: "Deploy api" }] }
    openSealedTree.mockResolvedValue({ tree: opened, opened: 1 })
    expect(await openSealedBootstrap(bootstrap)).toBe(opened)
  })
})
