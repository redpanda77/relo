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
      preset: "automatic",
      theme: "system",
      symbol: "automatic",
      colorStrategy: "thread",
      accentColor: "#5ED8B7",
    },
    liveActivityPolicySource: "system",
  },
  users: [{
    id: "owner-user", name: "Relo Owner", email: "owner@example.test",
    role: "owner", disabled: false, sessions: 1, devices: 1,
  }],
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function service(): AccountService {
  return {
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

    expect(screen.getByLabelText("Login command")).toHaveValue(
      'relo auth login --api-url "https://relo.example" --json'
    )
    fireEvent.click(screen.getByRole("button", { name: "Copy command" }))

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        'relo auth login --api-url "https://relo.example" --json'
      )
    )
    expect(await screen.findByText("Login command copied.")).toBeVisible()
  })

  it("selects the login command when clipboard access is unavailable", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("blocked")) },
    })
    render(<AccountPage initial={initial} service={service()} />)
    const command = screen.getByLabelText("Login command")

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
      'relo auth login --api-url "https://relo.example" --json'.length
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
})
