import { render, screen, within } from "@testing-library/react"
import { describe, expect, test } from "vitest"

import { DocsSite } from "@/features/docs/docs-site"
import type { DocsSiteBootstrap } from "@/features/docs/types"

const bootstrap: DocsSiteBootstrap = {
  version: 1,
  kind: "docs",
  route: { path: "/docs/guides/scripts" },
  viewer: { signedIn: false },
  release: { server: "0.18.30+abcdef12", cli: "0.17.3" },
  sections: [
    { title: "Overview", path: null, pages: [{ path: "/docs", title: "What Relo is" }], groups: [] },
    { title: "Guides", path: "/docs/guides", pages: [], groups: [{ title: "Scripts and apps", pages: [{ path: "/docs/guides/scripts", title: "Scripts and CI" }] }] },
  ],
  page: {
    path: "/docs/guides/scripts",
    title: "Scripts, cron and CI",
    summary: "Your jobs report progress.",
    section: "Guides",
    html: '<h2 id="why">Why</h2><p>Body</p><h2 id="start">Start</h2><h3 id="lease">Lease</h3><figure class="docs-code"><button class="docs-copy" type="button" data-copy="relo doctor" hidden>Copy</button><pre><code>relo doctor</code></pre></figure>',
    outline: [{ id: "why", text: "Why", level: 2 }, { id: "start", text: "Start", level: 2 }, { id: "lease", text: "Lease", level: 3 }],
    editUrl: "https://github.com/redpanda77/relo/blob/main/docs/site/guides/scripts.md",
    prev: { path: "/docs/guides/mcp", title: "MCP" },
    next: { path: "/docs/guides/asking", title: "Questions from code" },
    breadcrumbs: [{ path: "/docs", title: "Docs" }, { path: "/docs/guides", title: "Guides" }, { path: null, title: "Scripts and apps" }],
  },
}

describe("docs layout", () => {
  test("shows the page with its place in the docs: sidebar, breadcrumbs, outline, previous and next", () => {
    render(<DocsSite bootstrap={bootstrap} />)
    expect(screen.getByRole("heading", { level: 1, name: "Scripts, cron and CI" })).toBeInTheDocument()
    const sidebar = screen.getByRole("complementary", { name: "Docs pages" })
    expect(within(sidebar).getByRole("link", { name: "Scripts and CI" })).toHaveAttribute("aria-current", "page")
    expect(within(screen.getByRole("navigation", { name: "Breadcrumbs" })).getByRole("link", { name: "Guides" })).toHaveAttribute("href", "/docs/guides")
    const outline = screen.getByRole("complementary", { name: "On this page" })
    expect(within(outline).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["#why", "#start", "#lease"])
    expect(screen.getByRole("link", { name: /Next.*Questions from code/ })).toHaveAttribute("href", "/docs/guides/asking")
    expect(screen.getByRole("link", { name: /Edit this page/ })).toHaveAttribute("href", bootstrap.page!.editUrl)
    expect(screen.getByRole("button", { name: "Copy" })).toBeVisible()
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/sign-in")
  })

  test("a signed-in owner gets a way back to the Dashboard; an unknown page offers search", () => {
    render(<DocsSite bootstrap={{ ...bootstrap, viewer: { signedIn: true }, page: null }} />)
    expect(screen.getByRole("link", { name: "Open Dashboard" })).toHaveAttribute("href", "/dashboard")
    expect(screen.getByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Search the docs" })).toBeInTheDocument()
  })
})
