import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ciTokenError, compactScopes, expiry } from "@/features/connections/ci-tokens"
import { ConnectionsFeature } from "@/features/connections/connections-feature"
import { LOGIN_SCOPES, type ConnectionClient, type ConnectionsOverview } from "@/features/connections/types"
import { systemPresentationPolicy } from "@/features/presentation-policy/types"
import type { ConnectionsService, IssuedCiToken } from "@/services/connections-service"

function service(): ConnectionsService {
  return {
    createCiToken: vi.fn(),
    revokeCiToken: vi.fn().mockResolvedValue(undefined),
    createService: vi.fn(),
    editService: vi.fn(),
    rotateService: vi.fn(),
    deleteService: vi.fn(),
    revokePhone: vi.fn(),
    updateComputer: vi.fn(),
    revokeClient: vi.fn(),
    revokeHarnessCredential: vi.fn(),
    setClientCardLimit: vi.fn(),
    saveServiceLiveActivityPolicy: vi.fn(),
    resetServiceLiveActivityPolicy: vi.fn(),
    saveClientLiveActivityPolicy: vi.fn(),
    resetClientLiveActivityPolicy: vi.fn(),
  }
}

const DAY = 86_400_000
const inDays = (days: number) => new Date(Date.now() + days * DAY - 60_000).toISOString()

const login: ConnectionClient = {
  id: "key_00000000-0000-4000-8000-000000000001",
  kind: "login",
  label: "Studio Mac",
  prefix: "relo_ab",
  scopes: [...LOGIN_SCOPES],
  createdAt: null,
  expiresAt: null,
  lastUsedAt: null,
  liveActivityPolicy: null,
  effectiveLiveActivityPolicy: systemPresentationPolicy,
  liveActivityPolicySource: "system",
}

const deploy: ConnectionClient = {
  ...login,
  id: "key_00000000-0000-4000-8000-000000000002",
  kind: "ci-token",
  label: "Deploy pipeline",
  prefix: "relo_ci",
  scopes: ["activities:write", "interactions:create", "interactions:read"],
  expiresAt: inDays(30),
  lastUsedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
}

/** A login as the Connections payload shows its computer. */
function computerOf(client: ConnectionClient): ConnectionsOverview["computers"][number] {
  return {
    id: client.id.replace("key_", "cmp_"), loginId: client.id, name: client.label, label: client.label,
    icon: "laptop", iconSource: "default", tools: [], openCards: 0, lastSeenAt: client.lastUsedAt,
    createdAt: client.createdAt, expiresAt: client.expiresAt, prefix: client.prefix, scopes: client.scopes,
    encryption: "encrypts", hooks: [], liveActivityPolicy: client.liveActivityPolicy,
    effectiveLiveActivityPolicy: client.effectiveLiveActivityPolicy, liveActivityPolicySource: client.liveActivityPolicySource,
    maxActiveCards: null, report: null, reportedAt: null,
  }
}

function overview(clients: ConnectionClient[]): ConnectionsOverview {
  return {
    version: 1,
    kind: "connections",
    route: { path: "/dashboard/connections", page: 1 },
    shell: {
      title: "Connections",
      description: "",
      active: "connections",
      releaseIdentity: "test",
      account: { id: "account-1", initial: "R", name: "Relo owner", email: "owner@example.test" },
      counts: { pending: 0, notifications: 0, deliveries: 0 },
    },
    summary: { services: 0, phones: 0, clients: 1 },
    pagination: { page: 1, pageSize: 25, total: 0, pageCount: 1, previousHref: null, nextHref: null },
    phones: [],
    computers: clients.filter((client) => client.kind === "login").map(computerOf),
    unlinkedHooks: [],
    ciTokens: clients.filter((client) => client.kind === "ci-token"),
    services: [],
  }
}

function ciSection() {
  return screen.getByRole("heading", { level: 2, name: /CI tokens/ }).closest("section")!
}

function issued(name: string, token = "relo_secret_token_value"): IssuedCiToken {
  return {
    token,
    credential: {
      id: "key_00000000-0000-4000-8000-000000000009",
      name,
      prefix: "relo_ne",
      scopes: ["activities:write"],
      createdAt: new Date().toISOString(),
      expiresAt: inDays(7),
      lastUsedAt: null,
    },
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("CI tokens on Connections", () => {
  it("lists CI tokens in their own section and keeps logins under Computers", () => {
    render(<ConnectionsFeature bootstrap={overview([login, deploy])} service={service()} />)
    const clients = screen.getByRole("heading", { level: 2, name: /Computers/ }).closest("section")!
    expect(within(clients).getByText("Studio Mac")).toBeTruthy()
    expect(within(clients).queryByText("Deploy pipeline")).toBeNull()
    const row = within(ciSection()).getByText("Deploy pipeline").closest("li")!
    expect(row.textContent).toContain("Ask questions, Read answers +1")
    expect(row.textContent).toContain("Last used 2 hours ago")
    expect(within(row).getByText("Expires in 30 days")).toBeTruthy()
    expect(within(ciSection()).getByText(/A CI token holds at most your login's scopes, always expires and cannot make another; set it as/)).toBeTruthy()
  })

  it("says when a token was never used and when it ends soon or has ended", () => {
    expect(expiry(inDays(30)).tone).toBe("neutral")
    expect(expiry(inDays(1))).toEqual({ text: "Expires in 1 day", tone: "yellow" })
    expect(expiry(inDays(7))).toEqual({ text: "Expires in 7 days", tone: "yellow" })
    expect(expiry(new Date(Date.now() - DAY).toISOString())).toEqual({ text: "Expired", tone: "neutral" })
    expect(compactScopes([...LOGIN_SCOPES])).toBe("Every permission")
    expect(compactScopes(["activities:write"])).toBe("Report work")
    render(<ConnectionsFeature bootstrap={overview([{ ...deploy, lastUsedAt: null }])} service={service()} />)
    expect(within(ciSection()).getByText("Deploy pipeline").closest("li")!.textContent).toContain("Never used")
  })

  it("shows an empty state when there are no CI tokens", () => {
    render(<ConnectionsFeature bootstrap={overview([login])} service={service()} />)
    expect(within(ciSection()).getByText("No CI tokens yet")).toBeTruthy()
  })

  it("revokes a token after confirmation and its row leaves", async () => {
    const api = service()
    render(<ConnectionsFeature bootstrap={overview([deploy])} service={api} />)
    fireEvent.click(within(ciSection()).getByRole("button", { name: "Revoke" }))
    const dialog = await screen.findByRole("alertdialog")
    expect(api.revokeCiToken).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }))
    await waitFor(() => expect(api.revokeCiToken).toHaveBeenCalledWith(deploy.id))
    // The row animates out: a loaded gate machine needs more than the default second.
    await waitFor(() => expect(within(ciSection()).queryByText("Deploy pipeline")).toBeNull(), { timeout: 5000 })
    expect(api.revokeClient).not.toHaveBeenCalled()
  })

  it("makes a token with every permission by default, shows it once and adds its row", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    const api = service()
    vi.mocked(api.createCiToken).mockResolvedValue(issued("Nightly build"))
    render(<ConnectionsFeature bootstrap={overview([deploy])} service={api} />)
    fireEvent.click(within(ciSection()).getByRole("button", { name: /New CI token/ }))
    const form = await screen.findByRole("form", { name: "New CI token" })
    const boxes = within(form).getAllByRole("checkbox") as HTMLInputElement[]
    expect(boxes).toHaveLength(LOGIN_SCOPES.length)
    expect(boxes.every((box) => box.checked)).toBe(true)
    expect((within(form).getByLabelText("Expires after") as HTMLSelectElement).value).toBe("30")
    expect([...(within(form).getByLabelText("Expires after") as HTMLSelectElement).options].map((option) => option.value))
      .toEqual(["7", "30", "60", "90"])
    expect(within(form).getByText(/A CI token holds at most your login's scopes/)).toBeTruthy()

    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Nightly build" } })
    fireEvent.click(within(form).getByRole("button", { name: /Create CI token/ }))
    await waitFor(() => expect(api.createCiToken).toHaveBeenCalledWith({ name: "Nightly build", expiresInDays: 30 }))

    const panel = await screen.findByRole("region", { name: /One-time CI token for Nightly build/ })
    expect(panel.textContent).toContain("RELO_TOKEN")
    expect(panel.textContent).not.toContain("relo_secret_token_value")
    const row = await within(ciSection()).findByText("Nightly build")
    expect(row.closest("li")!.textContent).toContain("Expires in 7 days")
    expect(row.closest("li")!.textContent).toContain("Never used")

    fireEvent.click(within(panel).getByRole("button", { name: "Copy token" }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("relo_secret_token_value"))
    expect(await within(panel).findByText("Token copied.")).toBeTruthy()

    fireEvent.click(within(panel).getByRole("button", { name: "Dismiss and clear" }))
    await waitFor(() => expect(screen.queryByRole("region", { name: /One-time CI token/ })).toBeNull())
    expect(document.body.textContent).not.toContain("relo_secret_token_value")
  })

  it("sends only the permissions the owner kept, and the lifetime chosen", async () => {
    const api = service()
    vi.mocked(api.createCiToken).mockResolvedValue(issued("Release job"))
    render(<ConnectionsFeature bootstrap={overview([])} service={api} />)
    fireEvent.click(within(ciSection()).getByRole("button", { name: /New CI token/ }))
    const form = await screen.findByRole("form", { name: "New CI token" })
    for (const box of within(form).getAllByRole("checkbox") as HTMLInputElement[]) {
      if (!["Report work", "Ask questions"].some((label) => box.closest("label")!.textContent!.includes(label))) fireEvent.click(box)
    }
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Release job" } })
    fireEvent.change(within(form).getByLabelText("Expires after"), { target: { value: "90" } })
    fireEvent.click(within(form).getByRole("button", { name: /Create CI token/ }))
    await waitFor(() => expect(api.createCiToken).toHaveBeenCalledWith({
      name: "Release job", scopes: ["interactions:create", "activities:write"], expiresInDays: 90,
    }))
  })

  it("keeps at least one permission", async () => {
    render(<ConnectionsFeature bootstrap={overview([])} service={service()} />)
    fireEvent.click(within(ciSection()).getByRole("button", { name: /New CI token/ }))
    const form = await screen.findByRole("form", { name: "New CI token" })
    const boxes = within(form).getAllByRole("checkbox") as HTMLInputElement[]
    for (const box of boxes.slice(1)) fireEvent.click(box)
    expect(boxes[0]!.disabled).toBe(true)
    expect(within(form).getByText("A CI token holds at least one permission.")).toBeTruthy()
  })

  it("says in plain words why a token was refused, and shows no secret", async () => {
    const api = service()
    vi.mocked(api.createCiToken).mockRejectedValue(new Error("name_taken"))
    render(<ConnectionsFeature bootstrap={overview([deploy])} service={api} />)
    fireEvent.click(within(ciSection()).getByRole("button", { name: /New CI token/ }))
    const form = await screen.findByRole("form", { name: "New CI token" })
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Deploy pipeline" } })
    fireEvent.click(within(form).getByRole("button", { name: /Create CI token/ }))
    expect(await within(form).findByText("A computer or CI token already has this name. Choose another.")).toBeTruthy()
    expect(screen.queryByRole("region", { name: /One-time CI token/ })).toBeNull()
    expect(within(ciSection()).getAllByText("Deploy pipeline")).toHaveLength(1)
  })

  it("maps every refusal to words", () => {
    expect(ciTokenError(new Error("limit_reached"))).toMatch(/Revoke one you no longer use/)
    expect(ciTokenError(new Error("scope_not_held"))).toMatch(/only permissions your login holds/)
    expect(ciTokenError(new Error("expiry_too_long"))).toBe("A CI token lives at most 90 days. Choose a shorter lifetime.")
    expect(ciTokenError(new Error("Request failed (500)."))).toMatch(/could not make the CI token/)
  })
})
