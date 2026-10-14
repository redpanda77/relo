import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, test, vi } from "vitest"

import { AuthPage } from "@/features/auth/auth-page"

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("AuthPage", () => {
  test("preserves sign-in field names and sends a remembered session", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}", { status: 200 }))
    const onAuthenticated = vi.fn()
    render(
      <AuthPage
        bootstrap={{
          version: 1,
          kind: "auth", view: "form",
          route: { path: "/", nextPath: "/dashboard/testing" },
          mode: "sign-in",
          registration: "closed",
          title: "Sign in to Relo",
          description: "Use the same private Relo server account as your iPhone.",
        }}
        onAuthenticated={onAuthenticated}
      />
    )
    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "owner@example.test" },
    })
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "correct-horse" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      email: "owner@example.test",
      password: "correct-horse",
      rememberMe: true,
    })
    expect(onAuthenticated).toHaveBeenCalledWith("/dashboard/testing")
  })

  test("asks for the authenticator code after the password when the account has two-step sign-in", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ twoFactorRedirect: true, twoFactorMethods: ["totp"] }), { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
    const onAuthenticated = vi.fn()
    render(
      <AuthPage
        bootstrap={{
          version: 1, kind: "auth", view: "form", route: { path: "/", nextPath: "/dashboard" }, mode: "sign-in",
          registration: "closed", title: "Sign in to Relo", description: "Sign in.",
        }}
        onAuthenticated={onAuthenticated}
      />
    )
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "owner@example.test" } })
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse" } })
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }))
    expect(await screen.findByText("Two-step sign-in")).toBeTruthy()
    expect(onAuthenticated).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "123 456" } })
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    expect(await screen.findByText(/did not work/)).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Use a backup code instead" }))
    fireEvent.change(screen.getByLabelText("Backup code"), { target: { value: "abcde-fghij" } })
    fireEvent.click(screen.getByLabelText(/Don't ask again/))
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith("/dashboard"))
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/auth/two-factor/verify-totp")
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ code: "123456", trustDevice: false })
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/auth/two-factor/verify-backup-code")
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({ code: "abcde-fghij", trustDevice: true })
  })

  test("shows the owner name field only for first-account creation", () => {
    render(
      <AuthPage
        bootstrap={{
          version: 1,
          kind: "auth", view: "form",
          route: { path: "/", nextPath: "/dashboard" },
          mode: "sign-up",
          registration: "closed",
          title: "Create the owner account",
          description: "This first account claims the private owner.",
        }}
      />
    )
    expect(screen.getByLabelText("Name")).toHaveAttribute("name", "name")
    expect(screen.getByLabelText("Email")).toHaveAttribute("name", "email")
    expect(screen.getByLabelText("Password")).toHaveAttribute(
      "name",
      "password"
    )
  })

  test("offers registration only when the admin allows it", () => {
    const base = {
      version: 1 as const, kind: "auth" as const, view: "form" as const,
      route: { path: "/" as const, nextPath: "/dashboard" },
      mode: "sign-in" as const, title: "Sign in to Relo", description: "Use your account.",
    }
    const { unmount } = render(<AuthPage bootstrap={{ ...base, registration: "closed" }} />)
    expect(screen.queryByRole("button", { name: /Create an account/ })).toBeNull()
    unmount()
    render(<AuthPage bootstrap={{ ...base, registration: "open" }} />)
    fireEvent.click(screen.getByRole("button", { name: /Create an account/ }))
    expect(screen.getByLabelText("Name")).toBeTruthy()
    expect(screen.getByText("Create your account")).toBeTruthy()
  })

  test("tells a new person to wait for approval instead of signing them in", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "approval_pending" }), { status: 202 })
    )
    const onAuthenticated = vi.fn()
    render(
      <AuthPage
        bootstrap={{
          version: 1, kind: "auth", view: "form", route: { path: "/", nextPath: "/dashboard" },
          mode: "sign-in", registration: "approval", title: "Sign in to Relo", description: "Use your account.",
        }}
        onAuthenticated={onAuthenticated}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: /Create an account/ }))
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Guest" } })
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "guest@example.test" } })
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "guest-password" } })
    fireEvent.click(screen.getByRole("button", { name: "Create account" }))
    expect(await screen.findByText("Waiting for approval")).toBeTruthy()
    expect(onAuthenticated).not.toHaveBeenCalled()
  })

  test("explains a sign-in refused by the admin", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "account_disabled" }), { status: 403 })
    )
    render(
      <AuthPage
        bootstrap={{
          version: 1, kind: "auth", view: "form", route: { path: "/", nextPath: "/dashboard" },
          mode: "sign-in", registration: "closed", title: "Sign in to Relo", description: "Use your account.",
        }}
      />
    )
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "guest@example.test" } })
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "guest-password" } })
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }))
    expect(await screen.findByText("The server admin has turned off access for this account.")).toBeTruthy()
  })
})
