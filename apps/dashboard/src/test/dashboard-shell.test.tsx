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
  it("opens the generated Sheet sidebar from the tab bar's More, traps focus, and restores the trigger after Escape", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 })
    render(<DashboardShell shell={shell}><main id="main-content">Monitor</main></DashboardShell>)

    await waitFor(() => expect(document.getElementById("dashboard-sidebar")).not.toBeInTheDocument())
    const tabs = screen.getByRole("navigation", { name: "Tabs" })
    expect(within(tabs).getByRole("link", { name: "Now" })).toHaveAttribute("href", "/dashboard")
    const trigger = within(tabs).getByRole("button", { name: "More" })
    expect(trigger).toHaveAttribute("aria-current", "page")
    fireEvent.click(trigger)

    const dialog = await screen.findByRole("dialog", { name: "Sidebar" })
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement))
    expect(document.body).toHaveAttribute("data-scroll-locked", "1")
    expect(within(dialog).getByRole("button", { name: "Close menu" })).toHaveClass("size-11")
    expect(document.getElementById("dashboard-sidebar")).toBeInTheDocument()

    fireEvent.keyDown(document, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Sidebar" })).not.toBeInTheDocument())
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it("preserves navigation, release, account, and skip-link contracts", () => {
    const { container, rerender } = render(<DashboardShell shell={shell}><main id="main-content">Monitor</main></DashboardShell>)
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute("href", "#main-content")
    const primary = screen.getByRole("navigation", { name: "Primary" })
    expect(within(primary).getByRole("link", { name: "Now" })).toHaveAttribute("href", "/dashboard")
    expect(within(primary).getByRole("link", { name: "History" })).toHaveAttribute("href", "/dashboard/inbox/notifications")
    expect(within(primary).getByRole("link", { name: "Connections" })).toHaveAttribute("href", "/dashboard/connections")
    expect(within(primary).getByRole("link", { name: "Test Lab" })).toHaveAttribute("href", "/dashboard/testing")
    expect(within(primary).getByRole("link", { name: "Test Lab" })).toHaveAttribute("aria-current", "page")
    const settings = screen.getByRole("navigation", { name: "Settings" })
    expect(within(settings).getByRole("link", { name: "Account" })).toHaveAttribute("href", "/dashboard/account")
    expect(within(settings).getByRole("link", { name: "Documentation" })).toHaveAttribute("href", "/dashboard/docs")
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
