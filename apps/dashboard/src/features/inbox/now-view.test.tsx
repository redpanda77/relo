import { act, cleanup, render, screen, within } from "@testing-library/react"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { nowSummarySchema, type NowSummary } from "@relo/notification-contracts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import fixtureText from "../../../../../packages/contracts/fixtures/owner-state-v1.json?raw"

const routes = vi.hoisted(() => ({ fetchDashboardRoute: vi.fn() }))
vi.mock("@/app/dashboard-route-loader", () => routes)

import { InboxView } from "@/features/inbox/inbox-view"
import type { InboxOverview } from "@/features/inbox/types"
import { readLastLooked, writeLastLooked } from "@/lib/last-looked"
import type { InboxService } from "@/services/inbox-service"

// The canonical contract fixture, imported (never copied): the phone pins the same file.
const summary: NowSummary = nowSummarySchema.parse(JSON.parse(fixtureText).nowSummary)
const accountId = "acc_now_view"

const overview = {
  version: 1,
  kind: "inbox-overview",
  route: { path: "/dashboard", page: 1 },
  shell: {
    account: { id: accountId, email: "owner@example.test", name: "Owner" },
  },
  summary: { pendingResponses: 0, pendingApprovals: 0, notifications: 0, deliveries: 0 },
  pendingResponses: [],
  approvalRequests: [],
  approvalPagination: { page: 1, pageSize: 25, total: 0, pageCount: 1, previousHref: null, nextHref: null },
  recentNotifications: [],
  now: summary,
} as unknown as InboxOverview

const service = {
  decideApproval: vi.fn(),
  reactivateActivity: vi.fn(),
  getSnapshot: vi.fn(),
} as unknown as InboxService

/** The Now blocks in document order, by their headings / fold summaries. */
function blockOrder(container: HTMLElement): string[] {
  const nodes = container.querySelectorAll("[data-now-block], section[aria-labelledby], details[data-fold]")
  const labels: string[] = []
  for (const node of nodes) {
    if (node.closest("details[data-fold]") && node.tagName !== "DETAILS") continue
    if (node.parentElement?.closest("details[data-fold='idle']")) continue
    if (node.getAttribute("data-now-block") === "since-you-looked") labels.push("Since you looked")
    else if (node.tagName === "DETAILS") labels.push(node.getAttribute("data-fold")!)
    else labels.push(node.querySelector("h2")?.textContent?.replace(/\d+$/, "") ?? "")
  }
  return labels.filter((label) => label && label !== "recent" && label !== "idle")
}

beforeEach(() => {
  window.localStorage.clear()
  routes.fetchDashboardRoute.mockReset()
  routes.fetchDashboardRoute.mockReturnValue(new Promise(() => {}))
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe("Now from a NowSummary fixture", () => {
  it("renders the blocks in the spec order with fold counts from the server", () => {
    const { container } = render(<InboxView overview={overview} service={service} />)
    const order = blockOrder(container)
    const expected = ["Since you looked", "Needs you", "waitingOnYou", "Running", "quiet", "Sessions"]
    expect(order.filter((label) => expected.includes(label))).toEqual(expected)
    const waiting = container.querySelector("details[data-fold='waitingOnYou'] > summary")
    expect(waiting?.textContent).toBe(`Waiting on you (${summary.folds.waitingOnYou})`)
    expect(container.querySelector("details[data-fold='quiet'] > summary")?.textContent).toBe(`Quiet (${summary.folds.quiet})`)
    // Paused is zero in the fixture: no empty fold is shown.
    expect(container.querySelector("details[data-fold='paused']")).toBeNull()
    // Folds start closed.
    expect((container.querySelector("details[data-fold='waitingOnYou']") as HTMLDetailsElement).open).toBe(false)
  })

  it("puts each item only in the section the server put it in, and never shows a quiet item as running", () => {
    const { container } = render(<InboxView overview={overview} service={service} />)
    const running = container.querySelector<HTMLElement>("section[aria-labelledby='now-running'] ul[aria-label='Running']")!
    expect(within(running).getAllByRole("listitem")).toHaveLength(summary.running.length)
    for (const item of summary.quiet) {
      expect(within(running).queryByText(item.title)).toBeNull()
      const row = within(screen.getByRole("list", { name: "Quiet" })).getByRole("button", { name: `Open ${item.title}` })
      expect(row.textContent ?? "").not.toMatch(/running/i)
      expect(row.getAttribute("data-live")).toBeNull()
    }
    for (const item of summary.waitingOnYou) {
      expect(within(screen.getByRole("list", { name: "Waiting on you" })).getByRole("button", { name: `Open ${item.title}` })).toBeTruthy()
    }
    const needs = screen.getByRole("list", { name: "Needs you" })
    expect(within(needs).getAllByRole("listitem")).toHaveLength(summary.needsYou.length)
  })

  it("Sessions: server rows grouped by computer, idle folded, chips from the server phase", () => {
    render(<InboxView overview={overview} service={service} />)
    const section = screen.getAllByRole("heading", { name: /^Sessions/ }).find((node) => node.tagName === "H2")!.closest("section")!
    const working = summary.sessions.sessions.filter((row) => row.phase === "working").length
    expect(section.querySelector("h2")?.textContent).toBe(`Sessions${working}`)
    const idleRows = summary.sessions.sessions.filter((row) => row.fold === "idle")
    const idleFolds = section.querySelectorAll("details[data-fold='idle']")
    expect(idleFolds).toHaveLength(new Set(idleRows.map((row) => row.computer)).size)
    for (const fold of idleFolds) {
      expect((fold as HTMLDetailsElement).open).toBe(false)
      expect(fold.querySelector("summary")?.textContent).toMatch(/^Idle \(\d+\)$/)
      // An idle session is never shown as working.
      for (const chip of fold.querySelectorAll(".outcome-badge")) expect(chip.textContent).toBe("idle")
    }
    // Every row shown outside an idle fold carries its server phase; no idle row escapes the fold.
    const open = [...section.querySelectorAll("li[data-session-phase]")].filter((li) => !li.closest("details"))
    expect(open.map((li) => li.getAttribute("data-session-phase")).sort()).toEqual(
      summary.sessions.sessions.filter((row) => row.fold !== "idle").map((row) => row.phase ?? "unobserved").sort()
    )
    const waitingRow = section.querySelector("li[data-session-phase='waiting'] .outcome-badge")
    expect(waitingRow?.textContent).toMatch(/^(needs your input|your turn)$/)
    // An unobserved session (hooks off) says when it was last seen, never a phase.
    expect(within(section).getByText(/^last seen /)).toBeTruthy()
  })

  it("the HUD counts come from the server's summary (done = finished since you looked)", () => {
    const { container } = render(<InboxView overview={overview} service={service} />)
    const spoken = [...container.querySelectorAll("*")].find((node) => /\d+ today, \d+ done, \d+ running/.test(node.textContent ?? "") && node.children.length === 0)
    expect(spoken?.textContent).toContain(`${summary.sinceYouLooked.finished} done, ${summary.running.length} running, ${summary.needsYou.length} need you`)
  })

  it("no client re-derivation: two hours on the client clock change no section", () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const { container, rerender } = render(<InboxView overview={overview} service={service} />)
    const before = blockOrder(container)
    const folds = [...container.querySelectorAll("details[data-fold] > summary")].map((node) => node.textContent)
    vi.setSystemTime(Date.now() + 2 * 60 * 60_000)
    rerender(<InboxView overview={overview} service={service} />)
    expect(blockOrder(container)).toEqual(before)
    expect([...container.querySelectorAll("details[data-fold] > summary")].map((node) => node.textContent)).toEqual(folds)
  })
})

describe("Since you looked persistence", () => {
  it("round-trips the last look per account and ignores garbage", () => {
    expect(readLastLooked(accountId)).toBeNull()
    writeLastLooked(accountId, "2026-10-14T09:00:00.000Z")
    expect(readLastLooked(accountId)).toBe("2026-10-14T09:00:00.000Z")
    expect(readLastLooked("acc_other")).toBeNull()
    window.localStorage.setItem(`relo.now.lastLookedAt.${accountId}`, "not a date")
    expect(readLastLooked(accountId)).toBeNull()
  })

  it("blocked storage falls back to the server default without throwing", () => {
    const storage = vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new Error("blocked") })
    expect(() => writeLastLooked(accountId)).not.toThrow()
    expect(readLastLooked(accountId)).toBeNull()
    storage.mockRestore()
  })

  it("sends the stored last look as since, and records a new look when the tab hides", async () => {
    writeLastLooked(accountId, "2026-10-14T08:00:00.000Z")
    render(<InboxView overview={overview} service={service} />)
    const url = String(routes.fetchDashboardRoute.mock.calls[0]?.[0])
    expect(url).toContain("only=now")
    expect(new URL(url, "http://x").searchParams.get("since")).toBe("2026-10-14T08:00:00.000Z")
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")) })
    visibility.mockRestore()
    const stored = readLastLooked(accountId)
    expect(stored).not.toBe("2026-10-14T08:00:00.000Z")
    expect(Number.isFinite(new Date(stored!).valueOf())).toBe(true)
  })

  it("without a stored look, the request carries no since (the server's default window)", () => {
    render(<InboxView overview={overview} service={service} />)
    const url = String(routes.fetchDashboardRoute.mock.calls[0]?.[0])
    expect(new URL(url, "http://x").searchParams.has("since")).toBe(false)
  })
})

describe("no client timers decide Now", () => {
  const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")

  it("the Now and Sessions models read no clock and schedule nothing", () => {
    for (const file of ["./now-model.ts", "./sessions-model.ts", "./sessions-section.tsx"]) {
      const text = source(file)
      expect(text, file).not.toMatch(/Date\.now\(|new Date\(\)|setInterval|setTimeout|requestAnimationFrame|useTicker/)
      expect(text, file).not.toMatch(/QUIET_AFTER_MS|RECENT_WINDOW_MS|agentSessionPhase\(|quietFor\(|quietMs\(|groupSessions\(/)
    }
  })

  it("the only Now timers refetch the server's summary", () => {
    const text = source("./use-now-refresh.ts")
    const timers = text.match(/window\.set(Interval|Timeout)\([^\n]*/g) ?? []
    expect(timers).toHaveLength(2)
    expect(text).toMatch(/setInterval\(\(\) => void refresh\(\), REFRESH_MS\)/)
    // The one-shot timer fires at the server's refreshAt, measured against the server's own time.
    expect(text).toMatch(/new Date\(refreshAt\)\.valueOf\(\) - new Date\(serverTime\)\.valueOf\(\)/)
    expect(text).not.toMatch(/Date\.now\(/)
  })
})
