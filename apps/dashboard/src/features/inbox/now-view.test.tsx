import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { nowSummarySchema, type NowSummary } from "@relo/notification-contracts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import fixtureText from "../../../../../packages/contracts/fixtures/owner-state-v1.json?raw"

const routes = vi.hoisted(() => ({ fetchDashboardRoute: vi.fn() }))
vi.mock("@/app/dashboard-route-loader", () => routes)

import { InboxView } from "@/features/inbox/inbox-view"
import { NowItemList } from "@/features/inbox/now-cards"
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

/** The Now blocks in document order, by their headings and the one parked line. */
function blockOrder(container: HTMLElement): string[] {
  const nodes = container.querySelectorAll("section[aria-labelledby], [data-fold='parked']")
  const labels: string[] = []
  for (const node of nodes) {
    if (node.getAttribute("data-fold") === "parked") labels.push("parked")
    else labels.push(node.querySelector("h2")?.textContent?.replace(/\d+$/, "") ?? "")
  }
  return labels.filter(Boolean)
}

beforeEach(() => {
  window.localStorage.clear()
  routes.fetchDashboardRoute.mockReset()
  routes.fetchDashboardRoute.mockReturnValue(new Promise(() => {}))
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe("Now from a NowSummary fixture", () => {
  it("renders the blocks in the iPhone's order: Your turn open, Quiet and Paused as one folded line with the server's counts", () => {
    const { container } = render(<InboxView overview={overview} service={service} />)
    const order = blockOrder(container)
    const expected = ["Needs you", "Your turn", "Running", "Since you looked", "parked", "Sessions"]
    expect(order.filter((label) => expected.includes(label))).toEqual(expected)
    // Your turn is an open section with its cards, never a fold.
    const waiting = container.querySelector("section[aria-labelledby='now-your-turn']")!
    expect(waiting.querySelector("h2")?.textContent).toBe(`Your turn${summary.waitingOnYou.length}`)
    expect(within(waiting as HTMLElement).getAllByRole("listitem")).toHaveLength(summary.waitingOnYou.length)
    // One line: Quiet with the server's count; Paused is zero in the fixture, so it is not named.
    const line = container.querySelector(".parked-line")!
    expect(line.textContent).toBe(`Quiet ${summary.folds.quiet}Show \u203a`)
    expect(container.querySelectorAll("[data-fold='parked']")).toHaveLength(1)
    // The line starts closed: no rows.
    expect(line.getAttribute("aria-expanded")).toBe("false")
    expect(screen.queryByRole("list", { name: "Quiet" })).toBeNull()
  })

  it("cards read as the iPhone's work card: origin, title, meter, and the state in sentence case", () => {
    render(<InboxView overview={overview} service={service} />)
    const running = within(screen.getByRole("list", { name: "Running" }))
    const item = summary.running[0]!
    // The footer (state, steps, computer) sits beside the open target, so the whole card is the unit.
    const card = running.getByRole("button", { name: `Open ${item.title}` }).closest<HTMLElement>(".card")!
    expect(card.querySelector("[data-part='project']")?.textContent).toBe(item.project)
    expect(card.querySelector("[data-part='state']")?.textContent).toBe("Running")
    expect(within(card).getByRole("progressbar")).toHaveAttribute("aria-valuenow", String(item.steps!.done))
    expect(card.textContent).toContain(`Step ${item.steps!.done + 1} of ${item.steps!.total} · ${item.steps!.current}`)
    const waiting = within(screen.getByRole("list", { name: "Your turn" })).getByRole("button", { name: `Open ${summary.waitingOnYou[0]!.title}` }).closest<HTMLElement>(".card")!
    expect(waiting.querySelector("[data-part='state']")?.textContent).toBe("Your turn")
    // Settled work is a compact row: the failed one carries its red icon and opens a panel, never a state chip.
    const since = within(screen.getByRole("list", { name: "Since you looked" }))
    const failed = since.getByRole("button", { name: new RegExp(summary.recent[0]!.title, "u") })
    expect(failed.querySelector(".settled-icon")?.getAttribute("data-kind")).toBe("failed")
    expect(failed.getAttribute("aria-expanded")).toBe("false")
    expect(document.body.textContent).not.toMatch(/STOPPED WITHOUT FINISHING|\bDONE\b|\bFAILED\b/)
  })

  it("puts each item only in the section the server put it in, and never shows a quiet item as running", () => {
    const { container } = render(<InboxView overview={overview} service={service} />)
    const running = container.querySelector<HTMLElement>("section[aria-labelledby='now-running'] ul[aria-label='Running']")!
    expect(within(running).getAllByRole("listitem")).toHaveLength(summary.running.length)
    for (const item of summary.quiet) {
      expect(within(running).queryByText(item.title)).toBeNull()
      fireEvent.click(container.querySelector(".parked-line")!)
      const row = within(screen.getByRole("list", { name: "Quiet" })).getByRole("button", { name: `Open ${item.title}` })
      expect(row.textContent ?? "").not.toMatch(/running/i)
      expect(row.querySelector(".settled-icon")?.getAttribute("data-kind")).toBe("quiet")
    }
    for (const item of summary.waitingOnYou) {
      expect(within(screen.getByRole("list", { name: "Your turn" })).getByRole("button", { name: `Open ${item.title}` })).toBeTruthy()
    }
    const needs = screen.getByRole("list", { name: "Needs you" })
    expect(within(needs).getAllByRole("listitem")).toHaveLength(summary.needsYou.length)
  })

  it("Sessions: a card per machine, idle behind \"N idle\", phase chips from the server's phase, the caption counts every non-idle session", () => {
    render(<InboxView overview={overview} service={service} />)
    const section = screen.getAllByRole("heading", { name: /^Sessions/ }).find((node) => node.tagName === "H2")!.closest("section")!
    const active = summary.sessions.sessions.filter((row) => row.fold !== "idle").length
    expect(section.querySelector("h2")?.textContent).toBe(`Sessions${active}`)
    const idleRows = summary.sessions.sessions.filter((row) => row.fold === "idle")
    const groups = [...section.querySelectorAll("[role='group']")]
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual(
      [...new Set(summary.sessions.sessions.map((row) => row.computer ?? "Unknown computer"))]
    )
    // A machine with nothing but idle sessions is one dimmed line that opens its idle rows.
    const idleMachine = groups.find((group) => group.hasAttribute("data-idle-only"))!
    const toggle = within(idleMachine as HTMLElement).getByRole("button", { expanded: false })
    expect(toggle.textContent).toContain(`${idleRows.length} idle`)
    expect(idleMachine.querySelectorAll("li[data-session-phase]")).toHaveLength(0)
    fireEvent.click(toggle)
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    for (const standing of idleMachine.querySelectorAll("[data-session-standing]")) expect(standing.textContent).toMatch(/^Idle/)
    // Every row outside an idle machine carries its server phase; no idle row escapes.
    const open = [...section.querySelectorAll("li[data-session-phase]")].filter((li) => !li.closest("[data-idle-only]"))
    expect(open.map((li) => li.getAttribute("data-session-phase")).sort()).toEqual(
      summary.sessions.sessions.filter((row) => row.fold !== "idle").map((row) => row.phase ?? "unobserved").sort()
    )
    const waitingRow = section.querySelector("li[data-session-phase='waiting'] [data-session-standing]")
    expect(waitingRow?.textContent).toMatch(/^(Needs you|Your turn)/)
    // Its linked work opens from the row.
    expect(within(section).getByRole("button", { name: new RegExp(`Open ${summary.waitingOnYou[0]!.title}`, "u") })).toBeTruthy()
    // An unobserved session (hooks off) says when it was last seen, never a phase.
    expect([...section.querySelectorAll("[data-session-standing]")].some((node) => /^Last seen /.test(node.textContent ?? ""))).toBe(true)
  })

  it("a failed row opens its panel in place: the status, Open and Close (Close only collapses)", () => {
    render(<InboxView overview={overview} service={service} />)
    const failedItem = summary.recent.find((item) => item.owner.state === "failed")!
    const row = within(screen.getByRole("list", { name: "Since you looked" })).getByRole("button", { name: new RegExp(failedItem.title, "u") })
    expect(screen.queryByRole("group", { name: /failed$/u })).toBeNull()
    fireEvent.click(row)
    const panel = screen.getByRole("group", { name: `${failedItem.title} failed` })
    expect(panel.textContent).toContain(failedItem.status ?? "It failed.")
    expect(within(panel).getByRole("button", { name: "Open" })).toBeTruthy()
    fireEvent.click(within(panel).getByRole("button", { name: "Close" }))
    expect(screen.queryByRole("group", { name: `${failedItem.title} failed` })).toBeNull()
  })

  it("the deck's gauge tags are the server's: needs you, your turn, running, every live session", () => {
    const { container } = render(<InboxView overview={overview} service={service} />)
    const labels = [...container.querySelectorAll("[data-readout]")].map((node) => node.getAttribute("data-readout"))
    expect(labels).toEqual(["Needs you", "Your turn", "Running", "Sessions"])
    const live = summary.sessions.sessions.filter((row) => row.fold !== "idle" && row.phase !== "ended").length
    expect([...container.querySelectorAll("[data-readout]")].map((node) => node.querySelector(".readout-value")?.textContent)).toEqual([
      String(summary.needsYou.length), String(summary.waitingOnYou.length), String(summary.running.length), String(live),
    ])
    // The centre holds the top-priority state, never alternating; there is no Today count.
    expect(container.querySelector("[data-hud-centre]")?.getAttribute("data-hud-centre")).toBe("Needs you")
    expect(container.querySelector("[data-hud-centre='Today']")).toBeNull()
    const working = summary.sessions.sessions.filter((row) => row.phase === "working").length
    const spoken = [...container.querySelectorAll("[role='status']")].find((node) => /sessions? working/.test(node.textContent ?? ""))
    expect(spoken?.textContent).toContain(
      `${working} ${working === 1 ? "session" : "sessions"} working, ${summary.waitingOnYou.length} waiting on you, ${summary.running.length} running, ${summary.needsYou.length} need you`
    )
  })

  it("no client re-derivation: two hours on the client clock change no section", () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const { container, rerender } = render(<InboxView overview={overview} service={service} />)
    const before = blockOrder(container)
    const folds = [...container.querySelectorAll(".parked-line")].map((node) => node.textContent)
    vi.setSystemTime(Date.now() + 2 * 60 * 60_000)
    rerender(<InboxView overview={overview} service={service} />)
    expect(blockOrder(container)).toEqual(before)
    expect([...container.querySelectorAll(".parked-line")].map((node) => node.textContent)).toEqual(folds)
  })
})

describe("Now lists follow the server's refreshes", () => {
  it("adds and removes items as the summary changes, keeping each card's state hooks", () => {
    const items = [...summary.running, ...summary.waitingOnYou]
    const onOpen = vi.fn()
    const { rerender } = render(<NowItemList label="Running" items={items} onOpen={onOpen} />)
    const list = screen.getByRole("list", { name: "Running" })
    expect(within(list).getAllByRole("listitem")).toHaveLength(items.length)
    // A refresh drops the first item: it leaves at once (no animation frames in a test).
    rerender(<NowItemList label="Running" items={items.slice(1)} onOpen={onOpen} />)
    expect(within(list).getAllByRole("listitem")).toHaveLength(items.length - 1)
    expect(within(list).queryByRole("button", { name: `Open ${items[0]!.title}` })).toBeNull()
    // And brings it back: the card returns with the server's owner state.
    rerender(<NowItemList label="Running" items={items} onOpen={onOpen} />)
    const card = within(list).getByRole("button", { name: `Open ${items[0]!.title}` })
    expect(card.getAttribute("data-owner-state")).toBe(items[0]!.owner.state)
    card.click()
    expect(onOpen).toHaveBeenCalledWith(items[0])
  })
})

describe("Now moves with the server's refreshes", () => {
  it("first paint fires nothing; a refresh that brings needs you rings the card and jumps the deck", async () => {
    const next = structuredClone(summary)
    const item = next.running.shift()!
    item.owner = { ...item.owner, state: "needs_you", needsYou: "question" }
    item.title = "Approve the migration"
    next.needsYou = [item, ...next.needsYou]
    let resolve: (value: unknown) => void = () => {}
    routes.fetchDashboardRoute.mockReturnValueOnce(new Promise((done) => { resolve = done }))
    const { container } = render(<InboxView overview={overview} service={service} />)
    // First paint: no ring anywhere, the sync dot shows the refetch in flight.
    expect(container.querySelector("[data-announce]")).toBeNull()
    expect(container.querySelector("[data-sync]")?.getAttribute("data-sync")).toBe("syncing")
    await act(async () => { resolve({ kind: "dashboard", bootstrap: { now: next } }) })
    const needs = screen.getByRole("list", { name: "Needs you" })
    const card = within(needs).getByRole("button", { name: `Open ${item.title}` })
    expect(card.closest("li")?.getAttribute("data-announce")).toBe("true")
    expect(card.getAttribute("data-owner-state")).toBe("needs_you")
    expect(container.querySelector("[data-hud-centre]")?.getAttribute("data-hud-centre")).toBe("Needs you")
    expect(container.querySelector("[data-sync]")?.getAttribute("data-sync")).not.toBe("syncing")
    // Needs you is rendered in one place.
    expect(container.querySelectorAll("section[aria-labelledby='now-needs-you']")).toHaveLength(1)
  })

  it("the parked line keeps the server's counts", () => {
    const { container, rerender } = render(<InboxView overview={overview} service={service} />)
    expect(container.querySelector(".parked-line")!.textContent).toBe(`Quiet ${summary.folds.quiet}Show \u203a`)
    rerender(<InboxView overview={{ ...overview, now: { ...summary, folds: { ...summary.folds, quiet: summary.folds.quiet + 1, paused: 2 } } } as InboxOverview} service={service} />)
    expect(container.querySelector(".parked-line")!.textContent).toBe(`Quiet ${summary.folds.quiet + 1} \u00b7 Paused 2Show \u203a`)
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

  it("the live channel's timers only schedule a refetch or a reconnect, and read no clock", () => {
    const text = source("./use-now-live.ts")
    expect(text).not.toMatch(/Date\.now\(|new Date\(|performance\.now\(|setInterval|requestAnimationFrame/)
    const timers = text.match(/window\.setTimeout\([^\n]*/g) ?? []
    expect(timers).toHaveLength(3)
    // A hint carries no state: the handler only schedules the server read.
    expect(text).toMatch(/addEventListener\("changed", onHint\)/)
    expect(text).not.toMatch(/JSON\.parse|\.data\b/)
  })

  it("a live hint refetches the server's Now within a second", async () => {
    const sources: { emit(): void }[] = []
    vi.stubGlobal("EventSource", class {
      private listener: (() => void) | undefined
      onopen = null
      onerror = null
      constructor() { sources.push({ emit: () => this.listener?.() }) }
      addEventListener(_type: string, listener: () => void) { this.listener = listener }
      close() {}
    })
    vi.useFakeTimers()
    try {
      render(<InboxView overview={overview} service={service} />)
      expect(routes.fetchDashboardRoute).toHaveBeenCalledTimes(1)
      expect(sources).toHaveLength(1)
      await act(async () => { sources[0]!.emit(); vi.advanceTimersByTime(750) })
      expect(routes.fetchDashboardRoute).toHaveBeenCalledTimes(2)
      expect(String(routes.fetchDashboardRoute.mock.calls[1]?.[0])).toContain("only=now")
    } finally {
      vi.useRealTimers()
      vi.unstubAllGlobals()
    }
  })
})

describe("the core's motion on Now", () => {
  it("follows the server's summary: moving work moves it, nothing moving is calm, and no comet flies on first paint", () => {
    const { container, unmount } = render(<InboxView overview={overview} service={service} />)
    const stage = container.querySelector("[data-orb-motion]")!
    expect(stage.getAttribute("data-orb-motion")).toBe("moving")
    expect(stage.getAttribute("data-orb-comets")).toBe("0")
    unmount()
    const still = structuredClone(summary)
    const stale = still.running.shift()!
    stale.owner = { ...stale.owner, state: "stale" }
    still.quiet.push(stale)
    still.sessions.sessions = still.sessions.sessions.filter((row) => row.phase !== "working")
    const quiet = render(<InboxView overview={{ ...overview, now: still } as InboxOverview} service={service} />)
    expect(quiet.container.querySelector("[data-orb-motion]")?.getAttribute("data-orb-motion")).toBe("quiet")
    // Nothing needs the owner: the centre holds the next state (your turn), still the one centre.
    still.needsYou = []
    still.quiet = []
    quiet.unmount()
    const calm = render(<InboxView overview={{ ...overview, now: still } as InboxOverview} service={service} />)
    expect(calm.container.querySelector("[data-orb-motion]")?.getAttribute("data-orb-motion")).toBe("calm")
    expect(calm.container.querySelector("[data-hud-centre]")?.getAttribute("data-hud-centre")).toBe("Your turn")
  })
})
