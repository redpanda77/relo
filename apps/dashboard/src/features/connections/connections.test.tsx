import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { ClientsPage } from "@/features/connections/clients-page"
import { ConnectionsPageFrame } from "@/features/connections/components"
import { PhonesPage } from "@/features/connections/phones-page"
import type {
  ConnectionsClients,
  ConnectionsPairing,
  ConnectionsPhones,
} from "@/features/connections/types"
import { systemPresentationPolicy } from "@/features/presentation-policy/types"
import type { ConnectionsService } from "@/services/connections-service"

const shell = {
  title: "Connections",
  description: "Connect senders, clients, and phones.",
  active: "connections-pairing" as const,
  releaseIdentity: "0.7.23",
  account: {
    id: "account-1",
    initial: "R",
    name: "Relo owner",
    email: "owner@example.test",
  },
  counts: { pending: 0, notifications: 0, deliveries: 0 },
}

const pagination = {
  page: 1,
  pageSize: 25 as const,
  total: 1,
  pageCount: 1,
  previousHref: null,
  nextHref: null,
}

const api: ConnectionsService = {
  createService: vi.fn(),
  editService: vi.fn(),
  rotateService: vi.fn(),
  deleteService: vi.fn(),
  revokePhone: vi.fn(),
  revokeClient: vi.fn(),
  saveServiceLiveActivityPolicy: vi.fn(),
  resetServiceLiveActivityPolicy: vi.fn(),
  saveClientLiveActivityPolicy: vi.fn(),
  resetClientLiveActivityPolicy: vi.fn(),
}

describe("Connections", () => {
  it("presents every connection type as one current navigation system", () => {
    const initial: ConnectionsPairing = {
      version: 1,
      kind: "connections-pairing",
      route: { path: "/dashboard/connections/pairing", page: 1 },
      shell,
      summary: { services: 2, phones: 1, clients: 3 },
      pagination,
      grants: [],
    }

    render(
      <ConnectionsPageFrame bootstrap={initial}>
        <p>Pairing content</p>
      </ConnectionsPageFrame>
    )

    expect(
      screen.getByRole("navigation", { name: "Connections views" })
    ).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /Pair iPhone/ })).toHaveAttribute(
      "aria-current",
      "page"
    )
    expect(screen.getByRole("link", { name: /Services/ })).toHaveAttribute(
      "href",
      "/dashboard/connections/services"
    )
    expect(screen.getByRole("link", { name: /Phones/ })).toHaveTextContent("1")
    expect(screen.getByRole("link", { name: /CLI clients/ })).toHaveTextContent(
      "3"
    )
  })

  it("shows phone readiness as semantic text and keeps revoke explicit", () => {
    const initial: ConnectionsPhones = {
      version: 1,
      kind: "connections-phones",
      route: { path: "/dashboard/connections/phones", page: 1 },
      shell: { ...shell, active: "connections-phones" },
      summary: { services: 2, phones: 1, clients: 3 },
      pagination,
      phones: [
        {
          id: "phone-1",
          name: "Personal iPhone",
          model: "iPhone",
          appVersion: "0.9.7",
          osVersion: "26.0",
          notificationAuthorization: "authorized",
          liveActivityAuthorization: "authorized",
          lastSeenAt: "2026-08-16T09:00:00.000Z",
        },
      ],
    }

    render(<PhonesPage initial={initial} api={api} />)

    expect(
      screen.getByRole("heading", { name: "Personal iPhone" })
    ).toBeInTheDocument()
    expect(screen.getByText("Notifications authorized")).toBeInTheDocument()
    expect(screen.getByText("Live Activity authorized")).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Revoke phone" })
    ).toBeInTheDocument()
  })

  it("keeps client scopes visible while advanced controls stay disclosed", () => {
    const initial: ConnectionsClients = {
      version: 1,
      kind: "connections-clients",
      route: { path: "/dashboard/connections/clients", page: 1 },
      shell: { ...shell, active: "connections-clients" },
      summary: { services: 2, phones: 1, clients: 1 },
      pagination,
      clients: [
        {
          id: "client-1",
          label: "Workstation",
          prefix: "rlo_test",
          scopes: ["notifications:send", "activities:write"],
          createdAt: "2026-08-16T09:00:00.000Z",
          expiresAt: "2026-09-16T09:00:00.000Z",
          lastUsedAt: "2026-08-16T09:30:00.000Z",
          liveActivityPolicy: null,
          effectiveLiveActivityPolicy: systemPresentationPolicy,
          liveActivityPolicySource: "account",
        },
      ],
    }

    render(<ClientsPage initial={initial} api={api} />)

    expect(
      screen.getByRole("heading", { name: "Workstation" })
    ).toBeInTheDocument()
    expect(screen.getByText("notifications:send")).toBeInTheDocument()
    expect(screen.getByText("activities:write")).toBeInTheDocument()
    expect(screen.getByText("Manage client")).toBeInTheDocument()
  })
})
