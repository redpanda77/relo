import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { AccountPage } from "@/features/account/account-page"
import {
  accountDashboardBootstrapSchema,
  type AccountDashboardBootstrap,
} from "@/features/account/types"
import {
  createHttpAccountService,
  type AccountService,
} from "@/services/account-service"

const initial: AccountDashboardBootstrap = {
  version: 1,
  kind: "account",
  route: { path: "/dashboard/account" },
  shell: {
    title: "Account",
    description: "Review the owner identity and authentication posture.",
    active: "account",
    releaseIdentity: "test-release",
    account: {
      id: "acc_public",
      initial: "K",
      name: "Relo Owner",
      email: "owner@example.test",
    },
  },
  account: {
    id: "acc_public",
    name: "Relo Owner",
    email: "owner@example.test",
    serverOrigin: "https://relo.example",
    authentication: "Better Auth email/password session",
    liveActivityPolicy: {
      colorStrategy: "project",
      accentColor: "#5ED8B7",
    },
    liveActivityPolicySource: "system",
  },
  users: [{
    id: "owner-user", name: "Relo Owner", email: "owner@example.test",
    role: "owner", disabled: false, sessions: 1, devices: 1,
  }],
  server: null,
}

const adminView: AccountDashboardBootstrap = {
  ...initial,
  server: {
    registrationMode: "approval",
    maxQuestionSeconds: 604_800,
    privateCallbacks: "admin",
    accounts: [
      { id: "owner-user", name: "Relo Owner", email: "owner@example.test", status: "active",
        admin: true, createdAt: "2026-10-01T00:00:00.000Z", devices: 1, sessions: 1 },
      { id: "guest-user", name: "Guest", email: "guest@example.test", status: "pending",
        admin: false, createdAt: "2026-10-12T00:00:00.000Z", devices: 0, sessions: 0 },
    ],
  },
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function service(): AccountService {
  // Behaves like the server: a restored account that was never approved is still waiting.
  const accounts = (adminView.server?.accounts ?? []).map((account) => ({
    ...account, approved: account.status !== "pending",
  }))
  const serverState = () => ({
    registrationMode: "approval" as const,
    maxQuestionSeconds: 604_800,
    privateCallbacks: "admin" as const,
    accounts: accounts.map(({ approved, ...account }) => { void approved; return account }),
  })
  return {
    setRegistrationMode: vi.fn().mockResolvedValue(undefined),
    setMaxQuestionSeconds: vi.fn().mockResolvedValue(undefined),
    setPrivateCallbacks: vi.fn().mockResolvedValue(undefined),
    createServerAccount: vi.fn().mockResolvedValue({ id: "created-user" }),
    changeServerAccountAccess: vi.fn().mockImplementation(async (id: string, action: string) => {
      const account = accounts.find((item) => item.id === id)!
      if (action === "approve") { account.approved = true; if (account.status !== "disabled") account.status = "active" }
      if (action === "disable") account.status = "disabled"
      if (action === "enable") account.status = account.approved ? "active" : "pending"
    }),
    deleteServerAccount: vi.fn().mockResolvedValue(undefined),
    loadServer: vi.fn().mockImplementation(async () => serverState()),
    createUser: vi.fn().mockResolvedValue(undefined),
    resetUserPassword: vi.fn().mockResolvedValue(undefined),
    setUserEnabled: vi.fn().mockResolvedValue(undefined),
    revokeUserSessions: vi.fn().mockResolvedValue(undefined),
    changePassword: vi.fn().mockResolvedValue(undefined),
    deleteAccount: vi.fn().mockResolvedValue(undefined),
    saveLiveActivityPolicy: vi.fn().mockImplementation(async (policy) => ({
      policy,
      source: "account" as const,
    })),
    resetLiveActivityPolicy: vi.fn().mockResolvedValue({
      policy: initial.account.liveActivityPolicy,
      source: "system" as const,
    }),
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("Account feature contracts", () => {
  it("copies a login command bound to the canonical server origin", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    render(<AccountPage initial={initial} service={service()} />)

    expect(screen.getByLabelText("Install and sign in")).toHaveValue(
      'curl -fsSL https://relo.example/install.sh | sh && ~/.local/bin/relo auth login --api-url "https://relo.example"'
    )
    fireEvent.click(screen.getByRole("button", { name: "Copy command" }))

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        'curl -fsSL https://relo.example/install.sh | sh && ~/.local/bin/relo auth login --api-url "https://relo.example"'
      )
    )
    expect(await screen.findByText("Login command copied.")).toBeVisible()
  })

  it("selects the login command when clipboard access is unavailable", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("blocked")) },
    })
    render(<AccountPage initial={initial} service={service()} />)
    const command = screen.getByLabelText("Install and sign in")

    fireEvent.click(screen.getByRole("button", { name: "Copy command" }))

    expect(
      await screen.findByText(
        "Automatic clipboard access is unavailable. The command is selected for manual copy."
      )
    ).toBeVisible()
    expect(command).toHaveFocus()
    expect(command).toHaveProperty("selectionStart", 0)
    expect(command).toHaveProperty(
      "selectionEnd",
      'curl -fsSL https://relo.example/install.sh | sh && ~/.local/bin/relo auth login --api-url "https://relo.example"'.length
    )
  })

  it("validates account bootstrap strings as data", () => {
    const hostile = structuredClone(initial) as AccountDashboardBootstrap & {
      credential?: string
    }
    hostile.shell.description = '</script><img src=x onerror="alert(1)">'
    hostile.credential = "must-not-cross-the-boundary"
    const parsed = accountDashboardBootstrapSchema.parse(hostile)
    expect(parsed.shell.description).toContain("<img")
    expect(parsed).not.toHaveProperty("credential")
  })

  it("preserves password field order, boolean semantics, and pending success state", async () => {
    const pending = deferred()
    const accountService = service()
    accountService.changePassword = vi.fn(() => pending.promise)
    const { container } = render(
      <AccountPage initial={initial} service={accountService} />
    )
    const form = container.querySelector<HTMLFormElement>("#password-form")!
    const fields = Array.from(form.elements)
      .filter(
        (field): field is HTMLInputElement => field instanceof HTMLInputElement
      )
      .map((field) => field.name)
    expect(fields).toEqual([
      "currentPassword",
      "newPassword",
      "revokeOtherSessions",
    ])
    fireEvent.change(within(form).getByLabelText("Current password"), {
      target: { value: "current-password" },
    })
    fireEvent.change(within(form).getByLabelText("New password"), {
      target: { value: "new-password" },
    })
    fireEvent.click(
      within(form).getByRole("checkbox", { name: "Sign out other sessions" })
    )
    fireEvent.submit(form)

    expect(accountService.changePassword).toHaveBeenCalledWith({
      currentPassword: "current-password",
      newPassword: "new-password",
      revokeOtherSessions: false,
    })
    expect(
      screen.getByRole("button", { name: "Changing password…" })
    ).toBeDisabled()
    expect(form).toHaveAttribute("aria-busy", "true")

    pending.resolve()
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Password changed successfully."
    )
    expect(within(form).getByLabelText("Current password")).toHaveValue("")
    expect(
      within(form).getByRole("checkbox", { name: "Sign out other sessions" })
    ).toBeChecked()
  })

  it("requires an AlertDialog decision and exposes deletion failure and success", async () => {
    const accountService = service()
    accountService.deleteAccount = vi
      .fn()
      .mockRejectedValueOnce(new Error("invalid_password"))
      .mockResolvedValueOnce(undefined)
    const onDeleted = vi.fn()
    const { container } = render(
      <AccountPage
        initial={initial}
        service={accountService}
        onDeleted={onDeleted}
      />
    )
    const form = container.querySelector<HTMLFormElement>(
      "#delete-account-form"
    )!
    const password = within(form).getByLabelText("Current password")
    fireEvent.change(password, { target: { value: "invalid-password" } })
    fireEvent.change(within(form).getByLabelText("Type DELETE"), {
      target: { value: "DELETE" },
    })
    fireEvent.submit(form)

    expect(accountService.deleteAccount).not.toHaveBeenCalled()
    const firstDialog = await screen.findByRole("alertdialog")
    expect(firstDialog).toHaveTextContent(
      "Existing encrypted backups remain until their configured rotation removes them."
    )
    fireEvent.click(
      within(firstDialog).getByRole("button", { name: "Delete account" })
    )
    expect(accountService.deleteAccount).toHaveBeenCalledWith({
      password: "invalid-password",
      confirmation: "DELETE",
    })
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "invalid_password"
    )
    expect(onDeleted).not.toHaveBeenCalled()

    fireEvent.change(password, { target: { value: "valid-password" } })
    fireEvent.submit(form)
    const secondDialog = await screen.findByRole("alertdialog")
    fireEvent.click(
      within(secondDialog).getByRole("button", { name: "Delete account" })
    )
    await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce())
  })

  it("posts the unchanged account mutation contracts", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true })))
    const accountService = createHttpAccountService()
    await accountService.changePassword({
      currentPassword: "current-password",
      newPassword: "new-password",
      revokeOtherSessions: true,
    })
    await accountService.deleteAccount({
      password: "new-password",
      confirmation: "DELETE",
    })

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/auth/change-password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        currentPassword: "current-password",
        newPassword: "new-password",
        revokeOtherSessions: true,
      }),
    })
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/account/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        password: "new-password",
        confirmation: "DELETE",
      }),
    })
  })

  it("shows server administration only to the server admin", () => {
    render(<AccountPage initial={initial} service={service()} />)
    expect(screen.queryByText("Server accounts")).toBeNull()
  })

  it("lets the admin approve, revoke and delete accounts and change registration", async () => {
    const api = service()
    render(<AccountPage initial={accountDashboardBootstrapSchema.parse(adminView)} service={api} />)
    const list = screen.getByRole("list", { name: "Accounts on this server" })
    const guest = within(list).getByText("Guest").closest("li")!
    expect(within(guest).getByText("Waiting for approval")).toBeTruthy()
    expect(within(list).getByText("Relo Owner").closest("li")!.querySelector("button")).toBeNull()

    fireEvent.click(within(guest).getByRole("button", { name: "Approve" }))
    await waitFor(() => expect(api.changeServerAccountAccess).toHaveBeenCalledWith("guest-user", "approve"))
    await screen.findByText("Guest can now sign in.")
    fireEvent.click(within(guest).getByRole("button", { name: "Revoke access" }))
    await waitFor(() => expect(api.changeServerAccountAccess).toHaveBeenCalledWith("guest-user", "disable"))
    await within(guest).findByText("Access off")

    fireEvent.click(within(guest).getByRole("button", { name: "Restore access" }))
    await screen.findByText("Guest's access is back on.")
    expect(within(guest).queryByText("Access off")).toBeNull()

    fireEvent.change(screen.getByLabelText("Longest a question can wait"), { target: { value: "86400" } })
    await waitFor(() => expect(api.setMaxQuestionSeconds).toHaveBeenCalledWith(86_400))
    await screen.findByText("Questions can now wait up to 1 day.")
    fireEvent.change(screen.getByLabelText("Answer callbacks to your private network"), { target: { value: "everyone" } })
    await waitFor(() => expect(api.setPrivateCallbacks).toHaveBeenCalledWith("everyone"))

    fireEvent.click(screen.getByRole("radio", { name: /Open/ }))
    await waitFor(() => expect(api.setRegistrationMode).toHaveBeenCalledWith("open"))

    fireEvent.click(within(guest).getByRole("button", { name: "Delete" }))
    fireEvent.click(await screen.findByRole("button", { name: "Delete account" , hidden: false }))
    await waitFor(() => expect(api.deleteServerAccount).toHaveBeenCalledWith("guest-user"))
    await waitFor(() => expect(within(list).queryByText("Guest")).toBeNull())
  })

  it("keeps a restored account waiting when it was never approved", async () => {
    const api = service()
    render(<AccountPage initial={accountDashboardBootstrapSchema.parse(adminView)} service={api} />)
    const guest = within(screen.getByRole("list", { name: "Accounts on this server" })).getByText("Guest").closest("li")!
    fireEvent.click(within(guest).getByRole("button", { name: "Decline" }))
    await within(guest).findByText("Access off")
    fireEvent.click(within(guest).getByRole("button", { name: "Restore access" }))
    await screen.findByText("Guest's access is back on; they still need your approval.")
    expect(within(guest).getByText("Waiting for approval")).toBeTruthy()
  })
})
