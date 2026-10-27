import { cleanup, render, screen } from "@testing-library/react"
import { ScrollTrigger } from "gsap/ScrollTrigger"
import { afterAll, afterEach, describe, expect, test, vi } from "vitest"

import { DashboardApp } from "@/app/dashboard-app"
import { GITHUB_URL } from "@/features/auth/github"

afterEach(cleanup)
// ScrollTrigger keeps a 250 ms sync interval running; one that fired after jsdom was torn down failed the release gate.
afterAll(() => ScrollTrigger.disable(false, true))

const bootstrap = {
  version: 1 as const,
  kind: "auth" as const,
  route: { path: "/" as const, nextPath: "/dashboard" },
  mode: "sign-in" as const,
  registration: "closed" as const,
  title: "Sign in to Relo",
  description: "Sign in with your Relo account.",
  macApp: true,
  windowsApp: false,
}

describe("landing page", () => {
  test("a signed-out visitor sees the landing page, with sign-in and the source one click away", async () => {
    render(<DashboardApp bootstrap={{ ...bootstrap, view: "landing" }} />)
    expect(await screen.findByRole("heading", { level: 1, name: /Every agent\.\s*One place\./ }, { timeout: 5000 })).toBeInTheDocument()
    const signIn = screen.getAllByRole("link", { name: /Sign in/ })
    expect(signIn.length).toBeGreaterThan(0)
    for (const link of signIn) expect(link).toHaveAttribute("href", "/sign-in")
    // Getting Relo is the call to action, twice: the Mac app, and Get started (the chooser). Sign in stays in the top bar.
    const download = screen.getAllByRole("link", { name: /Download for Mac/ })
    expect(download.length).toBeGreaterThan(1)
    for (const link of download) expect(link).toHaveAttribute("href", "/mac/relo-mac.dmg")
    const server = screen.getAllByRole("link", { name: /Run your own server/ })
    expect(server.length).toBeGreaterThan(1)
    for (const link of server) expect(link).toHaveAttribute("href", "/docs/get-started")
    expect(screen.getAllByText(/macOS 14 or later · Apple silicon/).length).toBeGreaterThan(1)
    expect(screen.getAllByText(/iPhone app: build it yourself from the source/).length).toBeGreaterThan(1)
    // Every server shows this landing: its Sign in (top bar) is that server's; no "already have a server" line.
    expect(screen.queryByText(/Already have a server/)).not.toBeInTheDocument()
    for (const link of screen.getAllByRole("link", { name: /^Docs$/ })) expect(link).toHaveAttribute("href", "/docs")
    expect(screen.getAllByRole("link", { name: /^Docs$/ }).length).toBeGreaterThan(1)
    const github = screen.getAllByRole("link", { name: /GitHub/ })
    expect(github.length).toBeGreaterThan(1)
    for (const link of github) expect(link.getAttribute("href")).toBe(GITHUB_URL)
    expect(screen.queryByLabelText("Password")).not.toBeInTheDocument()
    // No paste line: the call to action is the download.
    expect(screen.queryByRole("button", { name: /Copy/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/install\.md/)).not.toBeInTheDocument()
  })

  test("a server that carries Relo for Windows offers its installer, beside the Mac app when it has both", async () => {
    render(<DashboardApp bootstrap={{ ...bootstrap, view: "landing", macApp: false, windowsApp: true }} />)
    await screen.findByRole("heading", { level: 1, name: /Every agent\.\s*One place\./ }, { timeout: 5000 })
    const download = screen.getAllByRole("link", { name: /Download for Windows/ })
    expect(download.length).toBeGreaterThan(1)
    for (const link of download) expect(link).toHaveAttribute("href", "/windows/relo-setup.exe")
    expect(screen.queryByRole("link", { name: /Download for Mac/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/Apple silicon/)).not.toBeInTheDocument()
    expect(screen.getAllByText(/Windows 10 or later/).length).toBeGreaterThan(1)
  })

  test("a server with both apps offers both downloads", async () => {
    render(<DashboardApp bootstrap={{ ...bootstrap, view: "landing", macApp: true, windowsApp: true }} />)
    await screen.findByRole("heading", { level: 1, name: /Every agent\.\s*One place\./ }, { timeout: 5000 })
    expect(screen.getAllByRole("link", { name: /Download for Mac/ })[0]).toHaveAttribute("href", "/mac/relo-mac.dmg")
    expect(screen.getAllByRole("link", { name: /Download for Windows/ })[0]).toHaveAttribute("href", "/windows/relo-setup.exe")
    // A Mac (jsdom's user agent is not Windows): the Mac download leads, filled; Windows is the quieter second.
    const first = screen.getAllByRole("link", { name: /Download for (Mac|Windows)/ })[0]!
    expect(first).toHaveTextContent("Download for Mac")
    expect(first).toHaveClass("capsule-cta")
    expect(screen.getAllByText(/^macOS 14 or later/).length).toBeGreaterThan(0)
  })

  test("a Windows visitor gets the Windows download first", async () => {
    vi.stubGlobal("navigator", { ...navigator, userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" })
    try {
      render(<DashboardApp bootstrap={{ ...bootstrap, view: "landing", macApp: true, windowsApp: true }} />)
      await screen.findByRole("heading", { level: 1, name: /Every agent\.\s*One place\./ }, { timeout: 5000 })
      const first = screen.getAllByRole("link", { name: /Download for (Mac|Windows)/ })[0]!
      expect(first).toHaveTextContent("Download for Windows")
      expect(first).toHaveClass("capsule-cta")
      expect(screen.getAllByRole("link", { name: /Download for Mac/ })[0]).toHaveClass("ghost-cta")
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test("a server without the Mac app offers Get started, never a download", async () => {
    render(<DashboardApp bootstrap={{ ...bootstrap, view: "landing", macApp: false }} />)
    await screen.findByRole("heading", { level: 1, name: /Every agent\.\s*One place\./ }, { timeout: 5000 })
    const started = screen.getAllByRole("link", { name: /Get started/ })
    expect(started.length).toBeGreaterThan(1)
    for (const link of started) expect(link).toHaveAttribute("href", "/docs/get-started")
    expect(screen.queryByRole("link", { name: /Download for Mac/ })).not.toBeInTheDocument()
    expect(screen.queryByRole("link", { name: /Run your own server/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/Apple silicon/)).not.toBeInTheDocument()
  })

  test("the launch film sits right under the hero only when the server sets one", async () => {
    const { unmount } = render(<DashboardApp bootstrap={{ ...bootstrap, view: "landing", film: { base: "https://media.example.test/film" } }} />)
    const film = await screen.findByRole("region", { name: "Relo in 40 seconds" }, { timeout: 5000 })
    expect(film.previousElementSibling).toHaveAttribute("data-landing-hero")
    const sources = [...film.querySelectorAll("source")].map((source) => source.getAttribute("src"))
    expect(sources[0]).toBe("https://media.example.test/film/relo-launch-av1.mp4")
    expect(sources).toContain("https://media.example.test/film/relo-launch-h264.mp4")
    expect(screen.getByRole("button", { name: "Turn the sound on" })).toBeInTheDocument()
    unmount()
    render(<DashboardApp bootstrap={{ ...bootstrap, view: "landing" }} />)
    await screen.findByRole("heading", { level: 1, name: /Every agent\.\s*One place\./ }, { timeout: 5000 })
    expect(screen.queryByRole("region", { name: "Relo in 40 seconds" })).not.toBeInTheDocument()
  })

  test("the form view goes straight to sign-in, links to the source, and shows no server row", () => {
    render(<DashboardApp bootstrap={{ ...bootstrap, view: "form" }} />)
    expect(screen.getByLabelText("Password")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: /View on GitHub/ })).toHaveAttribute("href", GITHUB_URL)
    expect(screen.getByRole("link", { name: "Relo home" })).toHaveAttribute("href", "/")
    expect(screen.queryByText("Your server")).not.toBeInTheDocument()
  })
})
