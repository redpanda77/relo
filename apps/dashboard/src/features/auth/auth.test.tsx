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
          kind: "auth",
          route: { path: "/", nextPath: "/dashboard/testing" },
          mode: "sign-in",
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

  test("shows the owner name field only for first-account creation", () => {
    render(
      <AuthPage
        bootstrap={{
          version: 1,
          kind: "auth",
          route: { path: "/", nextPath: "/dashboard" },
          mode: "sign-up",
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
})
