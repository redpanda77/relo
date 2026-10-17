import { readFileSync } from "node:fs"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import type { AuthenticatedDashboardBootstrap } from "@/app/bootstrap"
import { DashboardShell } from "@/layouts/dashboard-shell"

const shell: AuthenticatedDashboardBootstrap["shell"] = {
  title: "Live Activity Test Lab",
  description: "Evidence",
  active: "testing",
  releaseIdentity: "test-release",
  account: {
    id: "acct_public",
    initial: "K",
    name: "Relo Owner",
    email: "owner@example.com",
  },
}

afterEach(() => {
  cleanup()
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 })
})

describe("Dashboard shell mobile contracts", () => {
  it("opens the More bottom sheet from the tab bar, traps focus, and restores the trigger after Escape", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 })
    render(<DashboardShell shell={shell}><main id="main-content">Monitor</main></DashboardShell>)

    await waitFor(() => expect(document.getElementById("more-sheet")).not.toBeInTheDocument())
    // A phone has the tab bar only: no sidebar behind it.
    expect(document.getElementById("dashboard-sidebar")).not.toBeInTheDocument()
    const tabs = screen.getByRole("navigation", { name: "Tabs" })
    expect(within(tabs).getByRole("link", { name: "Now" })).toHaveAttribute("href", "/dashboard")
    const trigger = within(tabs).getByRole("button", { name: "More" })
    // Test Lab lives under More: the button is lit, but aria-current is for links, not buttons.
    expect(trigger).toHaveAttribute("data-active", "true")
    expect(trigger).not.toHaveAttribute("aria-current")
    expect(trigger).toHaveAttribute("aria-controls", "more-sheet")
    fireEvent.click(trigger)

    const dialog = await screen.findByRole("dialog", { name: "More" })
    expect(dialog).toHaveAttribute("id", "more-sheet")
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement))
    expect(document.body).toHaveAttribute("data-scroll-locked", "1")
    expect(within(dialog).getByRole("button", { name: "Close menu" })).toHaveClass("size-11")
    const more = within(dialog).getByRole("navigation", { name: "More" })
    expect(within(more).getByRole("link", { name: "Test Lab" })).toHaveAttribute("aria-current", "page")
    expect(within(more).getByRole("link", { name: "Account" })).toHaveAttribute("href", "/dashboard/account")
    expect(within(more).getByRole("link", { name: "Documentation" })).toHaveAttribute("href", "/docs")
    expect(within(dialog).getByRole("button", { name: "Sign out" })).toHaveAttribute("id", "sign-out")
    expect(dialog.querySelector("[data-release-identity='test-release']")).toBeInTheDocument()

    fireEvent.keyDown(document.activeElement ?? document, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "More" })).not.toBeInTheDocument())
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it("closes the More sheet when the page changes under it", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 })
    const { rerender } = render(<DashboardShell shell={shell}><main id="main-content">Monitor</main></DashboardShell>)
    fireEvent.click(within(screen.getByRole("navigation", { name: "Tabs" })).getByRole("button", { name: "More" }))
    expect(await screen.findByRole("dialog", { name: "More" })).toBeInTheDocument()

    rerender(<DashboardShell shell={{ ...shell, title: "Account", active: "account" }}><main id="main-content">Account</main></DashboardShell>)
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "More" })).not.toBeInTheDocument())
  })

  it("says the needs-you count in words and caps the visible number", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 })
    render(<DashboardShell shell={{ ...shell, active: "inbox", counts: { pending: 12, notifications: 0, deliveries: 0 } }}><main id="main-content">Now</main></DashboardShell>)
    const now = within(screen.getByRole("navigation", { name: "Primary" })).getByRole("link", { name: /^Now/u })
    expect(now).toHaveAccessibleName("Now, 12 need you")
    const badge = now.querySelector(".needs-you-badge")!
    expect(badge.querySelector("[aria-hidden='true']")).toHaveTextContent("9+")
    expect(badge).not.toHaveAttribute("aria-label")
    const tab = document.querySelector<HTMLElement>(".tab-bar a[href='/dashboard']")!
    expect(tab.querySelector(".sr-only")).toHaveTextContent(", 12 need you")
    expect(tab.querySelector(".needs-you-badge [aria-hidden='true']")).toHaveTextContent("9+")
  })

  it("starts tablets on the icon rail and opens the sidebar over the page, closing on Escape", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 900 })
    document.cookie = "sidebar_state=true; path=/"
    const { container } = render(<DashboardShell shell={shell}><main id="main-content">Monitor</main></DashboardShell>)
    expect(container.querySelector("[data-slot='sidebar']")).toHaveAttribute("data-state", "collapsed")
    expect(container.querySelector("[data-slot='sidebar-wrapper']")).toHaveAttribute("data-tablet", "true")

    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }))
    expect(container.querySelector("[data-slot='sidebar']")).toHaveAttribute("data-state", "expanded")
    expect(container.querySelector(".sidebar-scrim")).toBeInTheDocument()
    // A passing drawer never overwrites the owner's remembered choice.
    expect(document.cookie).toContain("sidebar_state=true")

    fireEvent.keyDown(window, { key: "Escape" })
    await waitFor(() => expect(container.querySelector("[data-slot='sidebar']")).toHaveAttribute("data-state", "collapsed"))
    expect(container.querySelector(".sidebar-scrim")).not.toBeInTheDocument()
  })

  it("names each rail row's shortcut and keeps one set of landmarks", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 })
    render(<DashboardShell shell={shell}><main id="main-content">Monitor</main></DashboardShell>)
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument()
    expect(screen.getAllByRole("navigation").map((nav) => nav.getAttribute("aria-label"))).toEqual(["Primary", "Settings", "Tabs"])
  })

  it("opens the command menu with Ctrl+K and the shortcuts with ?", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 })
    render(<DashboardShell shell={shell}><main id="main-content">Monitor</main></DashboardShell>)
    fireEvent.keyDown(window, { key: "k", ctrlKey: true })
    const palette = await screen.findByRole("dialog", { name: "Command menu" })
    const field = within(palette).getByRole("combobox", { name: "Search pages and actions" })
    fireEvent.change(field, { target: { value: "hist" } })
    expect(within(palette).getAllByRole("option").map((option) => option.textContent)).toEqual(["HistoryG H"])
    expect(within(palette).getByRole("option", { name: /History/u })).toHaveAttribute("aria-selected", "true")
    // Test Lab moved to the settings and keeps its jump.
    fireEvent.change(field, { target: { value: "test lab" } })
    expect(within(palette).getAllByRole("option").map((option) => option.textContent)).toEqual(["Test LabG T"])
    fireEvent.change(field, { target: { value: "sidebar" } })
    expect(within(palette).getByRole("option", { name: /Collapse sidebar/u })).toBeInTheDocument()
    fireEvent.keyDown(field, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command menu" })).not.toBeInTheDocument())

    fireEvent.keyDown(document.body, { key: "?" })
    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument()
  })

  it("preserves navigation, release, account, and skip-link contracts", () => {
    const { container, rerender } = render(<DashboardShell shell={shell}><main id="main-content">Monitor</main></DashboardShell>)
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute("href", "#main-content")
    const primary = screen.getByRole("navigation", { name: "Primary" })
    expect(within(primary).getByRole("link", { name: "Now" })).toHaveAttribute("href", "/dashboard")
    expect(within(primary).getByRole("link", { name: "History" })).toHaveAttribute("href", "/dashboard/inbox/notifications")
    expect(within(primary).getByRole("link", { name: "Connections" })).toHaveAttribute("href", "/dashboard/connections")
    // Test Lab is a tool, not a daily place: it lives with the settings.
    expect(within(primary).queryByRole("link", { name: "Test Lab" })).toBeNull()
    const settings = screen.getByRole("navigation", { name: "Settings" })
    expect(within(settings).getByRole("link", { name: "Account" })).toHaveAttribute("href", "/dashboard/account")
    expect(within(settings).getByRole("link", { name: "Test Lab" })).toHaveAttribute("href", "/dashboard/testing")
    expect(within(settings).getByRole("link", { name: "Test Lab" })).toHaveAttribute("aria-current", "page")
    expect(within(settings).getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["/dashboard/account", "/dashboard/testing", "/docs"])
    expect(within(settings).getByRole("link", { name: "Documentation" })).toHaveAttribute("href", "/docs")
    const profile = container.querySelector<HTMLElement>("#profile-menu")!
    profile.focus()
    fireEvent.keyDown(profile, { key: "Enter" })
    expect(screen.getByRole("menuitem", { name: "Account" })).toHaveAttribute("href", "/dashboard/account")
    expect(document.querySelector("[data-release-identity='test-release']")).toBeInTheDocument()
    expect(screen.getByRole("menuitem", { name: "Sign out" })).toHaveAttribute("id", "sign-out")
    fireEvent.keyDown(document.activeElement!, { key: "Escape" })

    rerender(<DashboardShell shell={{ ...shell, title: "Inbox", active: "inbox", counts: { pending: 0, notifications: 0, deliveries: 0 } }}><main id="main-content">Inbox</main></DashboardShell>)
    expect(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("link", { name: "Now" })).toHaveAttribute("aria-current", "page")
    expect(within(screen.getByRole("navigation", { name: "Tabs" })).getByRole("link", { name: "Now" })).toHaveAttribute("aria-current", "page")
    expect(container.querySelector("[data-dashboard-main] > header")).toBeNull()
  })

  it("keeps the 320px content path shrink-safe without viewport-width utility overflow", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 320 })
    const { container } = render(<DashboardShell shell={shell}><main id="main-content">Monitor</main></DashboardShell>)
    expect(container.querySelector("[data-dashboard-main]")).toHaveClass("min-w-0", "max-w-full")

    const source = readFileSync("src/layouts/dashboard-shell.tsx", "utf8")
    const css = readFileSync("src/index.css", "utf8")
    const html = readFileSync("index.html", "utf8")
    expect(source).not.toMatch(/\bw-screen\b|\bmin-w-max\b|\bw-\[\d{3,}px\]/)
    expect(html).toContain("viewport-fit=cover")
    expect(css).toContain("@media (max-width: 767px)")
    expect(css).toContain('max-width: 100dvw')
    expect(css).toContain('overflow-x: clip')
    expect(css).toContain("safe-area-inset-top")
    expect(css).toContain("safe-area-inset-bottom")
  })
})
