import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ComputersSection } from "@/features/connections/computers-section"
import { computer, report } from "@/features/connections/computers-fixtures"
import type { ConnectionsService } from "@/services/connections-service"
import { systemPresentationPolicy } from "@/features/presentation-policy/types"

function service(): ConnectionsService {
  return {
    createCiToken: vi.fn(),
    revokeCiToken: vi.fn(),
    createService: vi.fn(),
    editService: vi.fn(),
    rotateService: vi.fn(),
    deleteService: vi.fn(),
    revokePhone: vi.fn(),
    updateComputer: vi.fn(),
    revokeClient: vi.fn().mockResolvedValue(undefined),
    revokeHarnessCredential: vi.fn().mockResolvedValue(undefined),
    setClientCardLimit: vi.fn().mockResolvedValue(undefined),
    saveServiceLiveActivityPolicy: vi.fn(),
    resetServiceLiveActivityPolicy: vi.fn(),
    saveClientLiveActivityPolicy: vi.fn(),
    resetClientLiveActivityPolicy: vi.fn(),
  }
}

const studio = computer({
  tools: ["claude-code", "codex"],
  openCards: 2,
  lastSeenAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  scopes: ["notifications:send", "activities:write", "interactions:create", "services:read", "services:write"],
  report: report({ cli: { version: "0.17.10", latest: "0.17.12", update: "behind" } }),
  reportedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
})
const ci = computer({
  id: "cmp_00000000-0000-4000-8000-000000000002",
  loginId: "key_00000000-0000-4000-8000-000000000002",
  name: "Build box",
  label: "build-box",
  icon: "server",
  iconSource: "owner",
  maxActiveCards: 2,
  liveActivityPolicySource: "client",
  liveActivityPolicy: { ...systemPresentationPolicy, colorStrategy: "fixed", accentColor: "#FF6B57" },
  effectiveLiveActivityPolicy: { ...systemPresentationPolicy, colorStrategy: "fixed", accentColor: "#FF6B57" },
})

function renderSection(api = service(), computers = [studio, ci], unlinkedHooks: Parameters<typeof ComputersSection>[0]["unlinkedHooks"] = []) {
  render(<ComputersSection initial={computers} unlinkedHooks={unlinkedHooks} total={computers.length} api={api} />)
  return api
}

async function openPanel(name: string) {
  fireEvent.click(screen.getByRole("button", { name: new RegExp(name) }))
  return await screen.findByRole("dialog")
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("Computers section", () => {
  it("shows each computer's name, tools, last seen, open cards and what differs from the account", () => {
    renderSection()
    const row = screen.getByRole("button", { name: /Studio Mac/ })
    expect(within(row).getByText("Claude Code")).toBeTruthy()
    expect(within(row).getByText("Codex")).toBeTruthy()
    expect(row.textContent).toContain("Last seen 5 minutes ago")
    expect(row.textContent).toContain("2 open cards")
    expect(row.closest("[data-slot=machine-card]")!.textContent).toContain("CLI behind")
    const other = screen.getByRole("button", { name: /Build box/ })
    const otherCard = other.closest("[data-slot=machine-card]")!.textContent
    expect(otherCard).toContain("One color")
    expect(otherCard).toContain("Max 2 cards")
    expect(other.textContent).toContain("Not used yet")
    expect(other.textContent).not.toContain("open card")
  })

  it("says what to do when there are no computers, and lists hooks that belong to none", () => {
    cleanup()
    renderSection(service(), [], [{ id: "hck_00000000-0000-4000-8000-000000000001", name: "Old hooks", prefix: "relo_x", createdAt: "2026-10-14T09:00:00.000Z", lastUsedAt: null }])
    expect(screen.getByText("No computers yet")).toBeTruthy()
    expect(screen.getByText("Add a computer on Devices: one command installs Relo there and signs it in.")).toBeTruthy()
    expect(screen.getByText("Other hooks credentials")).toBeTruthy()
    expect(screen.getByText("Old hooks")).toBeTruthy()
  })

  it("opens a panel with its five sections when a row is clicked", async () => {
    renderSection()
    const panel = await openPanel("Studio Mac")
    const nav = within(panel).getByRole("navigation", { name: "Computer sections" })
    expect(within(nav).getAllByRole("button").map((button) => button.textContent)).toEqual(["Overview", "On your iPhone", "Setup", "Settings", "Access"])
    for (const name of ["Overview", "On your iPhone", "Setup", "Settings", "Access"]) {
      expect(within(panel).getByRole("heading", { level: 2, name })).toBeTruthy()
    }
    expect(within(panel).getByRole("textbox", { name: "Computer name" })).toHaveProperty("value", "Studio Mac")
    expect(panel.textContent).toContain("CLI 0.17.10")
  })

  it("renames on Enter, reverts on Escape, and an empty name goes back to the login's name", async () => {
    const api = renderSection()
    vi.mocked(api.updateComputer).mockImplementation(async (_id, input) => ({ ...studio, name: input.name ?? studio.label }))
    const panel = await openPanel("Studio Mac")
    const field = within(panel).getByRole("textbox", { name: "Computer name" }) as HTMLInputElement
    fireEvent.change(field, { target: { value: "Desk Mac" } })
    fireEvent.keyDown(field, { key: "Escape" })
    expect(field.value).toBe("Studio Mac")
    expect(api.updateComputer).not.toHaveBeenCalled()

    fireEvent.change(field, { target: { value: "Desk Mac" } })
    field.focus()
    fireEvent.keyDown(field, { key: "Enter" })
    fireEvent.blur(field)
    await waitFor(() => expect(api.updateComputer).toHaveBeenCalledWith(studio.id, { name: "Desk Mac" }))
    expect(await screen.findByDisplayValue("Desk Mac")).toBeTruthy()
    expect(screen.getAllByText("Desk Mac").length).toBeGreaterThan(0)

    const next = screen.getByRole("textbox", { name: "Computer name" })
    fireEvent.change(next, { target: { value: "" } })
    fireEvent.blur(next)
    await waitFor(() => expect(api.updateComputer).toHaveBeenLastCalledWith(studio.id, { name: null }))
  })

  it("choosing an icon changes the preview before the server answers, and saves it", async () => {
    const api = renderSection()
    let answer!: () => void
    vi.mocked(api.updateComputer).mockImplementation(() => new Promise((resolve) => { answer = () => resolve({ ...studio, icon: "server", iconSource: "owner" }) }))
    const panel = await openPanel("Studio Mac")
    const header = () => panel.querySelector("[data-preview-header]")!
    expect(header().querySelector("svg.lucide-laptop")).toBeTruthy()
    fireEvent.click(within(panel).getByRole("radio", { name: "Server" }))
    expect(header().querySelector("svg.lucide-server")).toBeTruthy()
    expect(api.updateComputer).toHaveBeenCalledWith(studio.id, { icon: "server" })
    answer()
    expect(await within(panel).findAllByText("Saved")).toBeTruthy()
  })

  it("puts the old icon back when the server refuses it", async () => {
    const api = renderSection()
    vi.mocked(api.updateComputer).mockRejectedValue(new Error("not_found"))
    const panel = await openPanel("Studio Mac")
    fireEvent.click(within(panel).getByRole("radio", { name: "Cloud" }))
    expect(await within(panel).findByText("not_found")).toBeTruthy()
    expect(panel.querySelector("[data-preview-header] svg.lucide-laptop")).toBeTruthy()
  })

  it("offers Automatic with the detected icon and sends null for it", async () => {
    const api = renderSection(service(), [ci])
    vi.mocked(api.updateComputer).mockResolvedValue({ ...ci, icon: "laptop", iconSource: "default" })
    const panel = await openPanel("Build box")
    fireEvent.click(within(panel).getByRole("radio", { name: "Automatic (Laptop)" }))
    await waitFor(() => expect(api.updateComputer).toHaveBeenCalledWith(ci.id, { icon: null }))
  })

  it("shows steps on the example card, and the three states on request", async () => {
    renderSection()
    const panel = await openPanel("Studio Mac")
    const preview = within(panel).getByRole("img", { name: /Lock Screen Live Activity preview/ })
    expect(preview.querySelector("[data-preview-steps]")).toBeTruthy()
    expect(preview.querySelector("[data-preview-bar]")).toBeNull()
    expect(preview.textContent).toContain("2 of 4 · Run the migrations")
    expect(preview.textContent).toContain("WORKING")
    fireEvent.click(within(panel).getByRole("radio", { name: "Needs you" }))
    expect(preview.textContent).toContain("NEEDS YOU")
    fireEvent.click(within(panel).getByRole("radio", { name: "Done" }))
    expect(preview.textContent).toContain("DONE")
    expect(preview.textContent).toContain("4 of 4")
  })

  it("has no Layout control", async () => {
    renderSection()
    const panel = await openPanel("Studio Mac")
    expect(within(panel).queryByText("Layout")).toBeNull()
    expect(within(panel).queryByRole("radio", { name: "Steps" })).toBeNull()
  })

  it("One color plus a swatch saves the policy with that accent", async () => {
    const api = renderSection()
    vi.mocked(api.saveClientLiveActivityPolicy).mockImplementation(async (_id, policy) => ({ policy, source: "client" }))
    const panel = await openPanel("Studio Mac")
    fireEvent.click(within(panel).getByRole("radio", { name: "One color" }))
    await waitFor(() => expect(api.saveClientLiveActivityPolicy).toHaveBeenCalledWith(studio.loginId, { ...systemPresentationPolicy, colorStrategy: "fixed" }))
    fireEvent.click(await within(panel).findByRole("radio", { name: "Coral" }))
    await waitFor(() => expect(api.saveClientLiveActivityPolicy).toHaveBeenLastCalledWith(studio.loginId, {
      ...systemPresentationPolicy, colorStrategy: "fixed", accentColor: "#FF6B57",
    }))
    // The accent colors the header icon, nothing else.
    expect(panel.querySelector<SVGElement>("[data-preview-header] svg")!.style.color).toBe("rgb(255, 107, 87)")
  })

  it("saves the card limit, and shows Use account defaults only while something is overridden", async () => {
    const api = renderSection()
    const first = await openPanel("Studio Mac")
    expect(within(first).queryByRole("button", { name: "Use account defaults" })).toBeNull()
    fireEvent.click(within(first).getByRole("radio", { name: "3" }))
    await waitFor(() => expect(api.setClientCardLimit).toHaveBeenCalledWith(studio.loginId, 3))
    fireEvent.keyDown(first, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())

    vi.mocked(api.resetClientLiveActivityPolicy).mockResolvedValue({ policy: systemPresentationPolicy, source: "account" })
    const second = await openPanel("Build box")
    fireEvent.click(within(second).getByRole("button", { name: "Use account defaults" }))
    await waitFor(() => expect(api.resetClientLiveActivityPolicy).toHaveBeenCalledWith(ci.loginId))
    await waitFor(() => expect(within(second).queryByRole("button", { name: "Use account defaults" })).toBeNull())
  })

  it("gives every control ids of its own, so no id has a space and every radiogroup has a name", async () => {
    renderSection()
    const panel = await openPanel("Studio Mac")
    for (const element of panel.querySelectorAll("[id]")) expect(element.id).not.toMatch(/\s/)
    const groups = within(panel).getAllByRole("radiogroup")
    for (const group of groups) {
      const labelId = group.getAttribute("aria-labelledby")
      const name = labelId ? document.getElementById(labelId)?.textContent : group.getAttribute("aria-label")
      expect(name).toBeTruthy()
    }
    const ids = [...panel.querySelectorAll("[id]")].map((element) => element.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("shows Setup per tool and Settings with where each value comes from", async () => {
    renderSection()
    const panel = await openPanel("Studio Mac")
    expect(within(panel).getByText("0.17.12 available")).toBeTruthy()
    const tools = within(panel).getByRole("list", { name: "Tools on this computer" })
    expect(within(tools).getAllByText("Claude Code").length).toBeGreaterThan(0)
    expect(within(tools).getByLabelText("Hooks: Presence")).toBeTruthy()
    expect(within(tools).getByLabelText("Skill: Installed")).toBeTruthy()
    expect(within(tools).getByLabelText("MCP: Not installed")).toBeTruthy()
    const table = within(panel).getByRole("table", { name: "Settings on this computer" })
    expect(within(table).getByText("Environment (RELO_PROJECT)")).toBeTruthy()
    expect(within(table).getAllByText("Set").length).toBeGreaterThan(0)
    expect(within(panel).getAllByText(/Reported 5 minutes ago/)).toHaveLength(2)
  })

  it("tells an old CLI's computer to update, and warns when a report is over a week old", async () => {
    renderSection(service(), [ci])
    const old = await openPanel("Build box")
    expect(within(old).getAllByText(/Update the CLI on this computer/).length).toBe(2)
    cleanup()
    renderSection(service(), [{ ...studio, reportedAt: new Date(Date.now() - 9 * 86_400_000).toISOString() }])
    const stale = await openPanel("Studio Mac")
    expect(within(stale).getAllByText(/has not reported in over a week/).length).toBe(2)
  })

  it("maps permissions to sentences, revokes a hooks credential on its own and signs the computer out", async () => {
    const hook = { id: "hck_00000000-0000-4000-8000-000000000003", name: "Studio Mac hooks", prefix: "relo_h", createdAt: "2026-10-14T09:00:00.000Z", lastUsedAt: null }
    const api = renderSection(service(), [{ ...studio, hooks: [hook] }, ci])
    const panel = await openPanel("Studio Mac")
    const access = within(panel).getByRole("heading", { level: 2, name: "Access" }).closest("section")!
    for (const sentence of ["Send notifications", "Show and update cards", "Ask you questions", "Manage its hooks credential and webhooks"]) {
      expect(within(access).getByText(sentence)).toBeTruthy()
    }
    expect(access.textContent).not.toContain("notifications:send")
    fireEvent.click(within(access).getByRole("button", { name: "Revoke" }))
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Revoke" }))
    await waitFor(() => expect(api.revokeHarnessCredential).toHaveBeenCalledWith(hook.id))

    fireEvent.click(within(access).getByRole("button", { name: "Sign this computer out" }))
    const dialog = await screen.findByRole("alertdialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign this computer out" }))
    await waitFor(() => expect(api.revokeClient).toHaveBeenCalledWith(studio.loginId))
    await waitFor(() => expect(screen.queryByRole("button", { name: /Studio Mac/ })).toBeNull())
  })
})
