import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ConnectionsFeature } from "@/features/connections/connections-feature"
import type { ConnectionsOverview } from "@/features/connections/types"
import { systemPresentationPolicy } from "@/features/presentation-policy/types"
import type { ConnectionsService } from "@/services/connections-service"

const api: ConnectionsService = {
  createCiToken: vi.fn(),
  revokeCiToken: vi.fn(),
  createService: vi.fn(),
  editService: vi.fn(),
  rotateService: vi.fn(),
  deleteService: vi.fn(),
  revokePhone: vi.fn(),
  updateComputer: vi.fn(),
  revokeClient: vi.fn(),
  revokeHarnessCredential: vi.fn().mockResolvedValue(undefined),
  setClientCardLimit: vi.fn().mockResolvedValue(undefined),
  saveServiceLiveActivityPolicy: vi.fn(),
  resetServiceLiveActivityPolicy: vi.fn(),
  saveClientLiveActivityPolicy: vi.fn(),
  resetClientLiveActivityPolicy: vi.fn(),
}

function overview(overrides: Partial<ConnectionsOverview> = {}): ConnectionsOverview {
  return {
    version: 1,
    kind: "connections",
    route: { path: "/dashboard/connections", page: 1 },
    shell: {
      title: "Connections",
      description: "Phones, computers, CI tokens, and webhooks connected to this server.",
      active: "connections",
      releaseIdentity: "0.7.49",
      account: { id: "account-1", initial: "R", name: "Relo owner", email: "owner@example.test" },
      counts: { pending: 0, notifications: 0, deliveries: 0 },
    },
    summary: { services: 0, phones: 1, clients: 1 },
    pagination: { page: 1, pageSize: 25, total: 0, pageCount: 1, previousHref: null, nextHref: null },
    phones: [
      {
        id: "dev_123456789012",
        name: "Owner iPhone",
        model: "iPhone 17 Pro",
        appVersion: "0.9.12",
        osVersion: "27.0",
        notificationAuthorization: "authorized",
        liveActivityAuthorization: "denied",
        lastSeenAt: null,
      },
    ],
    computers: [
      {
        id: "cmp_123456789012",
        loginId: "key_123456789012",
        name: "Codex CLI",
        label: "Codex CLI",
        icon: "laptop",
        iconSource: "default",
        tools: [],
        openCards: 0,
        lastSeenAt: null,
        createdAt: null,
        expiresAt: null,
        prefix: "relo_abc",
        scopes: ["notifications:send", "activities:write"],
        encryption: "encrypts",
        hooks: [],
        liveActivityPolicy: null,
        effectiveLiveActivityPolicy: systemPresentationPolicy,
        liveActivityPolicySource: "system",
        maxActiveCards: null,
        report: null,
        reportedAt: null,
      },
    ],
    unlinkedHooks: [],
    ciTokens: [],
    services: [],
    ...overrides,
  }
}

const shop: ConnectionsOverview["services"][number] = {
  id: "svc_00000000-0000-4000-8000-000000000001",
  title: "Shop",
  prefix: "hook_ab",
  imageUrl: null,
  destinationUrl: "https://shop.example.test/orders",
  liveActivityPolicy: null,
  effectiveLiveActivityPolicy: systemPresentationPolicy,
  liveActivityPolicySource: "system",
  readableAllowed: false,
  scopes: ["hooks:notify", "hooks:cards", "hooks:works", "hooks:read"],
  lastUsedAt: null,
  createdAt: "2026-10-14T09:00:00.000Z",
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("Connections", () => {
  it("shows phones, computers, CI tokens and webhooks on one page, and no Hooks section", () => {
    render(<ConnectionsFeature bootstrap={overview()} service={api} />)
    expect(screen.getByRole("heading", { level: 1, name: "Connections" })).toBeTruthy()
    for (const name of ["Phones", "Computers", "CI tokens", "Webhooks"]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeTruthy()
    }
    expect(screen.getByText("No webhooks yet")).toBeTruthy()
    expect(screen.queryByRole("heading", { level: 2, name: "Hooks" })).toBeNull()
    const order = screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent?.replace(/\d+$/, ""))
    expect(order).toEqual(["Phones", "Computers", "CI tokens", "Webhooks"])
  })

  it("indexes its sections as Account does, each link landing on its section", () => {
    const sectionLinks = () =>
      within(screen.getByRole("navigation", { name: "Connections sections" })).getAllByRole("link").map((link) => {
        const target = document.getElementById(link.getAttribute("href")!.slice(1))
        return [link.textContent, target?.querySelector("h2")?.textContent?.replace(/\d+$/, "")]
      })
    render(<ConnectionsFeature bootstrap={overview()} service={api} />)
    expect(sectionLinks()).toEqual([["Phones", "Phones"], ["Computers", "Computers"], ["CI tokens", "CI tokens"], ["Webhooks", "Webhooks"]])
  })

  it("states phone readiness in words and keeps removal explicit", () => {
    render(<ConnectionsFeature bootstrap={overview()} service={api} />)
    expect(screen.getByText("Owner iPhone")).toBeTruthy()
    expect(screen.getByText(/Live Activities off/)).toBeTruthy()
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy()
    expect(api.revokePhone).not.toHaveBeenCalled()
  })

  it("shows each webhook's last use and marks a readable one in its row", () => {
    const lastUsedAt = new Date(Date.now() - 2 * 3600_000).toISOString()
    render(<ConnectionsFeature bootstrap={overview({ services: [shop, { ...shop, id: "svc_00000000-0000-4000-8000-000000000002",
      title: "Payroll", destinationUrl: null, readableAllowed: true, lastUsedAt }] })} service={api} />)
    const [shopRow, payrollRow] = ["Shop", "Payroll"].map((title) => screen.getByText(title).closest("summary")!)
    expect(shopRow.textContent).toContain("Never used · Opens https://shop.example.test/orders")
    expect(within(shopRow).queryByText("Readable")).toBeNull()
    expect(payrollRow.textContent).toContain("Last used 2 hours ago")
    expect(within(payrollRow).getByText("Readable")).toBeTruthy()
  })

  it("shows what a webhook may do and keeps at least one permission", () => {
    render(<ConnectionsFeature bootstrap={overview({ services: [{ ...shop, scopes: ["hooks:notify", "hooks:read"] }] })} service={api} />)
    const group = screen.getByRole("group", { name: "What it may do" })
    const box = (name: string) => within(group).getByRole("checkbox", { name: new RegExp(name) }) as HTMLInputElement
    expect([box("Send notifications"), box("Post Live Activity cards"), box("Report work"), box("Read its own items")]
      .map((input) => input.checked)).toEqual([true, false, false, true])
    expect((screen.getByRole("switch", { name: /May send readable content/ }) as HTMLInputElement).checked).toBe(false)
    expect(screen.getByRole("button", { name: "Save access" })).toHaveProperty("disabled", true)

    fireEvent.click(box("Read its own items"))
    expect(box("Send notifications").disabled).toBe(true)
    expect(box("Send notifications").getAttribute("aria-describedby")).toBeTruthy()
    expect(screen.getByText("A webhook keeps at least one permission. To stop it entirely, delete it.")).toBeTruthy()
    fireEvent.click(box("Report work"))
    expect(box("Send notifications").disabled).toBe(false)
  })

  it("saves only the changed access, and the row changes only after the server accepts it", async () => {
    let accept!: () => void
    vi.mocked(api.editService).mockImplementation((id, input) => new Promise((resolve) => {
      accept = () => resolve({ service: { id, title: shop.title, prefix: shop.prefix, imageUrl: null,
        destinationUrl: shop.destinationUrl, readableAllowed: input.readableAllowed ?? false, scopes: input.scopes ?? shop.scopes } })
    }))
    render(<ConnectionsFeature bootstrap={overview({ services: [shop] })} service={api} />)
    const row = screen.getByText("Shop").closest("summary")!
    fireEvent.click(screen.getByRole("switch", { name: /May send readable content/ }))
    fireEvent.click(screen.getByRole("button", { name: "Save access" }))
    expect(api.editService).toHaveBeenCalledWith(shop.id, {
      title: "Shop", imageUrl: null, destinationUrl: "https://shop.example.test/orders", readableAllowed: true,
    })
    expect(within(row).queryByText("Readable")).toBeNull()
    accept()
    expect(await within(row).findByText("Readable")).toBeTruthy()
    expect(await screen.findByText("Access saved.")).toBeTruthy()

    fireEvent.click(screen.getByRole("checkbox", { name: /Report work/ }))
    // The button still holds its "Saved" check for a moment; the form submits either way.
    fireEvent.click(screen.getByRole("button", { name: /Save access|Saved/ }))
    expect(api.editService).toHaveBeenLastCalledWith(shop.id, expect.objectContaining({
      scopes: ["hooks:notify", "hooks:cards", "hooks:read"],
    }))
    expect(vi.mocked(api.editService).mock.lastCall?.[1]).not.toHaveProperty("readableAllowed")
  })

  it("says in plain words when the access cannot be saved, and keeps the draft", async () => {
    vi.mocked(api.editService).mockRejectedValue(new Error("not_found"))
    render(<ConnectionsFeature bootstrap={overview({ services: [shop] })} service={api} />)
    fireEvent.click(screen.getByRole("switch", { name: /May send readable content/ }))
    fireEvent.click(screen.getByRole("button", { name: "Save access" }))
    expect(await screen.findByText("This webhook no longer exists. Reload the page to see your current webhooks.")).toBeTruthy()
    expect((screen.getByRole("switch", { name: /May send readable content/ }) as HTMLInputElement).checked).toBe(true)
    expect(within(screen.getByText("Shop").closest("summary")!).queryByText("Readable")).toBeNull()
  })

  it("creates a webhook and shows its endpoint and secret once in the one-time panel", async () => {
    vi.mocked(api.createService).mockResolvedValue({
      service: { id: "svc_00000000-0000-4000-8000-000000000003", title: "Billing", prefix: "hook_cd" },
      endpoint: "https://relo.example.test/hooks",
      secret: "hook_billing_secret",
    })
    render(<ConnectionsFeature bootstrap={overview()} service={api} />)
    fireEvent.click(screen.getByRole("button", { name: /New webhook/ }))
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Billing" } })
    fireEvent.click(screen.getByRole("button", { name: /Create webhook/ }))
    const panel = await screen.findByRole("region", { name: "One-time service secret" })
    expect(within(panel).getByLabelText("Endpoint")).toHaveProperty("value", "https://relo.example.test/hooks")
    expect(within(panel).getByRole("button", { name: "Copy secret" })).toBeTruthy()
    expect(panel.textContent).toContain("Authorization: Bearer hook_")
    expect(await screen.findByText("Billing")).toBeTruthy()
  })
})
