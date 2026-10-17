import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
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

const accountBootstrap = {
  version: 1,
  kind: "account",
  route: { path: "/dashboard/account" },
  shell: {
    title: "Account",
    description: "Your account.",
    active: "account",
    releaseIdentity: "test-release",
    account,
  },
  account: {
    id: "acc_1",
    name: "Relo Owner",
    email: "owner@example.test",
    serverOrigin: "https://relo.example.test",
    authentication: "Better Auth email/password session",
    liveActivityPolicy: { version: 1, rules: [] },
    liveActivityPolicySource: "system",
  },
  users: [],
  server: null,
} as unknown as DashboardBootstrap

const inboxBootstrap = {
  version: 1,
  kind: "inbox-overview",
  route: { path: "/dashboard", page: 1 },
  shell: {
    title: "Now",
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
  window.history.replaceState({}, "", "/dashboard/account")
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("dashboard client navigation", () => {
  it("scrolls to a section of the page shown (the landing's nav) and never loads a page for it, back and forward included", () => {
    window.history.replaceState({}, "", "/")
    const fetcher = vi.fn()
    vi.stubGlobal("fetch", fetcher)
    render(
      <>
        <DashboardRouter bootstrap={accountBootstrap} />
        <a href="#features">Features</a>
        <section id="features" />
      </>
    )
    const scrollIntoView = vi.fn()
    Object.defineProperty(document.getElementById("features")!, "scrollIntoView", { value: scrollIntoView })

    fireEvent.click(screen.getByRole("link", { name: "Features" }))
    expect(window.location.hash).toBe("#features")
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" })

    window.history.replaceState({}, "", "/")
    window.dispatchEvent(new PopStateEvent("popstate", { state: {} }))
    expect(fetcher).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

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

    render(<DashboardRouter bootstrap={accountBootstrap} />)
    expect(
      await screen.findByRole("heading", { name: "Account" })
    ).toBeInTheDocument()
    // One set of landmarks: the navs and main, no duplicate labelled aside.
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument()
    const shell = document.getElementById("dashboard-sidebar")
    expect(shell).toBeInTheDocument()

    fireEvent.click(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("link", { name: "Now" }))
    expect(screen.getByRole("heading", { name: "Account" })).toBeInTheDocument()
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument()

    resolveResponse?.(
      new Response(dashboardHtml(inboxBootstrap), {
        status: 200,
        headers: { "content-type": "text/html" },
      })
    )

    expect(await screen.findByRole("heading", { name: "Now" })).toBeInTheDocument()
    expect(
      document.getElementById("dashboard-sidebar")
    ).toBe(shell)
    expect(window.location.pathname).toBe("/dashboard")
  })

  it("leads the tab title with the needs-you count and glides to the top when the shown page's link is tapped again", () => {
    window.history.replaceState({}, "", "/dashboard")
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)))
    render(
      <DashboardRouter
        bootstrap={{ ...inboxBootstrap, shell: { ...inboxBootstrap.shell, counts: { pending: 3, notifications: 0, deliveries: 0 } } }}
      />
    )
    expect(document.title).toBe("(3) Now · Relo")

    fireEvent.click(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("link", { name: /^Now/u }))
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" })
    expect(window.location.pathname).toBe("/dashboard")
    vi.unstubAllGlobals()
  })

  it("keeps the page when the server cannot be reached, says so with a retry, and retries when the network returns", async () => {
    window.history.replaceState({}, "", "/dashboard/account")
    // Only the navigation to Now fails once; anything else the shown page fetches is answered.
    let refused = false
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin)
      if (url.pathname === "/dashboard" && !refused) {
        refused = true
        throw new TypeError("Failed to fetch")
      }
      return new Response(dashboardHtml(inboxBootstrap), { status: 200, headers: { "content-type": "text/html" } })
    })
    vi.stubGlobal("fetch", fetcher)
    render(<DashboardRouter bootstrap={accountBootstrap} />)
    expect(await screen.findByRole("heading", { name: "Account" })).toBeInTheDocument()

    fireEvent.click(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("link", { name: "Now" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("Can't reach your server")
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Account" })).toBeInTheDocument()
    expect(window.location.pathname).toBe("/dashboard/account")

    window.dispatchEvent(new Event("online"))
    expect(await screen.findByRole("heading", { name: "Now" })).toBeInTheDocument()
    expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    vi.unstubAllGlobals()
  })
})
