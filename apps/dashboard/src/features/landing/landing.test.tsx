import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, test } from "vitest"

import { DashboardApp } from "@/app/dashboard-app"
import { GITHUB_URL } from "@/features/auth/github"

afterEach(cleanup)

const bootstrap = {
  version: 1 as const,
  kind: "auth" as const,
  route: { path: "/" as const, nextPath: "/dashboard" },
  mode: "sign-in" as const,
  registration: "closed" as const,
  title: "Sign in to Relo",
  description: "Use the same account as your iPhone.",
}

describe("landing page", () => {
  test("a signed-out visitor sees the landing page, with sign-in and the source one click away", async () => {
    render(<DashboardApp bootstrap={{ ...bootstrap, view: "landing" }} />)
    expect(await screen.findByRole("heading", { level: 1, name: /Every agent\.\s*One place\./ }, { timeout: 5000 })).toBeInTheDocument()
    const signIn = screen.getAllByRole("link", { name: /Sign in/ })
    expect(signIn.length).toBeGreaterThan(0)
    for (const link of signIn) expect(link).toHaveAttribute("href", "/sign-in")
    // Creating an account is the call to action; the docs and the source stay one click away.
    for (const link of screen.getAllByRole("link", { name: /Create account/ })) expect(link).toHaveAttribute("href", "/sign-in?mode=sign-up")
    for (const link of screen.getAllByRole("link", { name: /^Docs$/ })) expect(link).toHaveAttribute("href", "/docs")
    expect(screen.getAllByRole("link", { name: /^Docs$/ }).length).toBeGreaterThan(1)
    const github = screen.getAllByRole("link", { name: /GitHub/ })
    expect(github.length).toBeGreaterThan(1)
    for (const link of github) expect(link.getAttribute("href")).toBe(GITHUB_URL)
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument()
    // No paste line: the call to action is Create account.
    expect(screen.queryByRole("button", { name: /Copy/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/install\.md/)).not.toBeInTheDocument()
  })

  test("the form view goes straight to sign-in, links to the source, and shows no server row", () => {
    render(<DashboardApp bootstrap={{ ...bootstrap, view: "form" }} />)
    expect(screen.getByLabelText("Password")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /View on GitHub/ })).toHaveAttribute("href", GITHUB_URL)
    expect(screen.getByRole("link", { name: "Relo home" })).toHaveAttribute("href", "/")
    expect(screen.queryByText("Your server")).not.toBeInTheDocument()
  })
})
