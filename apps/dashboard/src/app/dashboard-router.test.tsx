import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DashboardBootstrap } from "@/app/bootstrap"
import { DashboardRouter } from "@/app/dashboard-router"
import { fetchDashboardRoute } from "@/app/dashboard-route-loader"

const account = {
  id: "acct_test",
  initial: "R",
  name: "Relo Owner",
  email: "owner@example.test",
}

const docsBootstrap = {
  version: 1,
  kind: "docs",
  route: { path: "/dashboard/docs" },
  shell: {
    title: "Documentation",
    description: "Product guidance.",
    active: "docs",
    releaseIdentity: "test-release",
    account,
  },
  introduction: "Use Relo from the dashboard and CLI.",
  sections: [],
  machineLinks: [],
} satisfies DashboardBootstrap

const inboxBootstrap = {
  version: 1,
  kind: "inbox-overview",
  route: { path: "/dashboard", page: 1 },
  shell: {
    title: "Inbox",
    description: "Recent durable events.",
    active: "inbox",
    releaseIdentity: "test-release",
    account,
    counts: { pending: 0, notifications: 0, deliveries: 0 },
  },
  summary: {
    pendingResponses: 0,
    pendingApprovals: 0,
    notifications: 0,
    deliveries: 0,
  },
  pendingResponses: [],
  approvalRequests: [],
  approvalPagination: {
    page: 1,
    pageSize: 25,
    total: 0,
    pageCount: 1,
    previousHref: null,
    nextHref: null,
  },
  recentNotifications: [],
} satisfies DashboardBootstrap

function dashboardHtml(bootstrap: DashboardBootstrap) {
  return `<!doctype html><html><body><script id="relo-dashboard-bootstrap" type="application/json">${JSON.stringify(bootstrap)}</script></body></html>`
}

beforeEach(() => {
  window.history.replaceState({}, "", "/dashboard/docs")
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("dashboard client navigation", () => {
  it("parses the server-authoritative bootstrap from an HTML route response", async () => {
    const fetcher = vi.fn(async () =>
      new Response(dashboardHtml(inboxBootstrap), {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    )

    await expect(
      fetchDashboardRoute("/dashboard", { fetcher })
    ).resolves.toMatchObject({
      kind: "dashboard",
      bootstrap: inboxBootstrap,
      url: "http://localhost:3000/dashboard",
    })
  })

  it("keeps the mounted shell and current page until the next route is ready", async () => {
    let resolveResponse: ((response: Response) => void) | undefined
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveResponse = resolve
          })
      )
    )

    render(<DashboardRouter bootstrap={docsBootstrap} />)
    expect(
      await screen.findByRole("heading", { name: "Documentation" })
    ).toBeInTheDocument()
    const shell = screen.getByRole("complementary", {
      name: "Dashboard navigation",
    })

    fireEvent.click(screen.getByRole("link", { name: "Now" }))
    expect(screen.getByRole("heading", { name: "Documentation" })).toBeInTheDocument()
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()

    resolveResponse?.(
      new Response(dashboardHtml(inboxBootstrap), {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    )

    expect(await screen.findByRole("heading", { name: "Now" })).toBeInTheDocument()
    expect(
      screen.getByRole("complementary", { name: "Dashboard navigation" })
    ).toBe(shell)
    expect(window.location.pathname).toBe("/dashboard")
  })
})
