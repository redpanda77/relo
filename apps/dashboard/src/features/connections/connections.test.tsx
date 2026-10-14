import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ConnectionsFeature } from "@/features/connections/connections-feature"
import type { ConnectionsOverview } from "@/features/connections/types"
import { systemPresentationPolicy } from "@/features/presentation-policy/types"
import type { ConnectionsService } from "@/services/connections-service"

const api: ConnectionsService = {
  createService: vi.fn(),
  editService: vi.fn(),
  rotateService: vi.fn(),
  deleteService: vi.fn(),
  revokePhone: vi.fn(),
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
      description: "Phones, CLI clients, and webhooks connected to this server.",
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
    clients: [
      {
        id: "key_123456789012",
        label: "Codex CLI",
        prefix: "relo_abc",
        scopes: ["notifications:send", "activities:write"],
        createdAt: null,
        expiresAt: null,
        lastUsedAt: null,
        liveActivityPolicy: null,
        effectiveLiveActivityPolicy: systemPresentationPolicy,
        liveActivityPolicySource: "system",
      },
    ],
    harnessCredentials: [],
    services: [],
    ...overrides,
  }
}

afterEach(cleanup)

describe("Connections", () => {
  it("shows phones, CLI clients, and webhooks on one page", () => {
    render(<ConnectionsFeature bootstrap={overview()} service={api} />)
    expect(screen.getByRole("heading", { level: 1, name: "Connections" })).toBeTruthy()
    for (const name of ["Phones", "CLI clients", "Webhooks"]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeTruthy()
    }
    expect(screen.getByText("No webhooks yet")).toBeTruthy()
  })

  it("lists hooks credentials only when there are some, and revokes one", async () => {
    render(<ConnectionsFeature bootstrap={overview()} service={api} />)
    expect(screen.queryByRole("heading", { level: 2, name: "Hooks" })).toBeNull()
    cleanup()
    render(<ConnectionsFeature bootstrap={overview({ harnessCredentials: [{ id: "hck_00000000-0000-4000-8000-000000000001",
      name: "Studio Mac hooks", prefix: "relo_abc", createdAt: "2026-10-14T09:00:00.000Z", lastUsedAt: null }] })} service={api} />)
    expect(screen.getByRole("heading", { level: 2, name: "Hooks" })).toBeTruthy()
    expect(screen.getByText("Studio Mac hooks")).toBeTruthy()
    expect(api.revokeHarnessCredential).not.toHaveBeenCalled()
  })

  it("states phone readiness in words and keeps removal explicit", () => {
    render(<ConnectionsFeature bootstrap={overview()} service={api} />)
    expect(screen.getByText("Owner iPhone")).toBeTruthy()
    expect(screen.getByText("Live Activities off")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy()
    expect(api.revokePhone).not.toHaveBeenCalled()
  })

  it("keeps client scopes and controls behind Manage", () => {
    render(<ConnectionsFeature bootstrap={overview()} service={api} />)
    expect(screen.getByText("Codex CLI")).toBeTruthy()
    const manage = screen.getByText("Manage").closest("details")
    expect(manage?.hasAttribute("open")).toBe(false)
    expect(manage?.textContent).toContain("notifications:send")
  })

  it("lets the owner cap how many cards one client keeps open", async () => {
    render(<ConnectionsFeature bootstrap={overview()} service={api} />)
    const select = screen.getByLabelText("Most open cards") as HTMLSelectElement
    expect(select.value).toBe("")
    fireEvent.change(select, { target: { value: "2" } })
    await waitFor(() => expect(api.setClientCardLimit).toHaveBeenCalledWith(expect.any(String), 2))
    expect(await screen.findByText("At most 2 open cards.")).toBeTruthy()
  })
})
