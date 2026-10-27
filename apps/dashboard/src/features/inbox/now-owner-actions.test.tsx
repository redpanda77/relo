import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { nowSummarySchema, type NowSummary } from "@relo/notification-contracts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import fixtureText from "../../../../../packages/contracts/fixtures/owner-state-v1.json?raw"

const routes = vi.hoisted(() => ({ fetchDashboardRoute: vi.fn() }))
vi.mock("@/app/dashboard-route-loader", () => routes)

import { canEndWork, END_CONFIRM_MESSAGE, ENDED_LINE, EndWorkButton, endConfirmTitle } from "@/features/inbox/end-work"
import { InboxView } from "@/features/inbox/inbox-view"
import { LATE_ANSWER_NOTE, SINCE_ROWS, isMissedQuestion, nowBlocks } from "@/features/inbox/now-model"
import type { InboxOverview } from "@/features/inbox/types"
import type { InboxService } from "@/services/inbox-service"

const base: NowSummary = nowSummarySchema.parse(JSON.parse(fixtureText).nowSummary)
const NOTIFICATION = "ntf_00000000-0000-4000-8000-0000000000aa"
const QUESTION = "int_00000000-0000-4000-8000-0000000000bb"

function overviewOf(now: NowSummary, recentNotifications: unknown[] = []): InboxOverview {
  return {
    version: 1,
    kind: "inbox-overview",
    route: { path: "/dashboard", page: 1 },
    shell: { account: { id: "acc_now_actions", email: "owner@example.test", name: "Owner" } },
    summary: { pendingResponses: 0, pendingApprovals: 0, notifications: 0, deliveries: 0 },
    pendingResponses: [],
    approvalRequests: [],
    approvalPagination: { page: 1, pageSize: 25, total: 0, pageCount: 1, previousHref: null, nextHref: null },
    recentNotifications,
    now,
  } as unknown as InboxOverview
}

/** A listed notification as the overview carries it (only what the card model reads). */
const listed = (id: string, destination: unknown) => ({
  id, title: "Release", body: "", source: "Claude Code", requesterKind: "cli", kind: "message", state: "delivered",
  createdAt: "2026-10-15T10:00:00.000Z", destination, targetDeviceNames: [], response: null, originThreadId: null, activity: null,
  context: {
    providerName: null, producerKind: null, computer: null, account: null, project: null, providerThreadId: null,
    providerWorkItemId: null, threadName: null, taskTitle: null, threadNameSource: null, taskTitleSource: null,
  },
})

const service = () =>
  ({
    decideApproval: vi.fn(),
    reactivateActivity: vi.fn(),
    getSnapshot: vi.fn(),
    endWork: vi.fn().mockResolvedValue(undefined),
    dismissMissedQuestion: vi.fn().mockResolvedValue(undefined),
  }) as unknown as InboxService & { endWork: ReturnType<typeof vi.fn>; dismissMissedQuestion: ReturnType<typeof vi.fn> }

beforeEach(() => {
  window.localStorage.clear()
  routes.fetchDashboardRoute.mockReset()
  routes.fetchDashboardRoute.mockReturnValue(new Promise(() => {}))
})
afterEach(cleanup)

describe("End work on Now", () => {
  it("is offered for Quiet, Stopped responding, No signal, Paused and Your turn, never for moving work, a question or settled work", () => {
    const offered = ["stale", "stopped_responding", "no_signal", "paused", "waiting_on_you"] as const
    const refused = ["moving", "working_quietly", "needs_you", "failed", "done", "dropped", "left_unfinished"] as const
    for (const state of offered) expect(canEndWork(state), state).toBe(true)
    for (const state of refused) expect(canEndWork(state), state).toBe(false)
  })

  it("puts End on the your-turn card and the quiet row, never on moving work, confirms in the iPhone's words, then ends the card", async () => {
    const svc = service()
    const { container } = render(<InboxView overview={overviewOf(base)} service={svc} />)
    const turn = base.waitingOnYou[0]!
    const card = (name: string) => screen.getByRole("button", { name: `Open ${name}` }).closest<HTMLElement>(".card")!
    expect(within(card(turn.title)).getByRole("button", { name: /^End/u })).toBeTruthy()
    // Moving work never offers End.
    const moving = within(screen.getByRole("list", { name: "Running" })).getByRole("button", { name: `Open ${base.running[0]!.title}` }).closest<HTMLElement>(".card")!
    expect(within(moving).queryAllByRole("button", { name: /^End/u })).toHaveLength(0)
    // The quiet work sits in the Quiet line's row.
    fireEvent.click(container.querySelector(".parked-line")!)
    const quiet = screen.getByRole("button", { name: `Open ${base.quiet[0]!.title}` }).closest<HTMLElement>(".settled-line")!
    expect(within(quiet).getByRole("button", { name: `End ${base.quiet[0]!.title}` })).toBeTruthy()

    fireEvent.click(within(card(turn.title)).getByRole("button", { name: /^End/u }))
    const dialog = await screen.findByRole("alertdialog")
    expect(within(dialog).getByText(endConfirmTitle(turn.title))).toBeTruthy()
    expect(within(dialog).getByText(END_CONFIRM_MESSAGE)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole("button", { name: "End work" }))
    await waitFor(() => expect(svc.endWork).toHaveBeenCalledWith(turn.id))
  })

  it("says why it was refused when the work is moving again", async () => {
    const svc = service()
    svc.endWork.mockRejectedValue(new Error("work_running"))
    render(<InboxView overview={overviewOf(base)} service={svc} />)
    const turn = base.waitingOnYou[0]!
    const card = screen.getByRole("button", { name: `Open ${turn.title}` }).closest<HTMLElement>(".card")!
    fireEvent.click(within(card).getByRole("button", { name: /^End/u }))
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "End work" }))
    expect((await screen.findByRole("alert")).textContent).toBe("This work is moving again; it can't be ended now.")
  })
})

describe("End work on the detail", () => {
  it("is a button that confirms, ends, and then says it moved to History", async () => {
    const end = vi.fn().mockResolvedValue(null)
    render(<EndWorkButton variant="detail" workId="act_x" goal="Ship the release" end={end} />)
    fireEvent.click(screen.getByRole("button", { name: "End work" }))
    const dialog = await screen.findByRole("alertdialog")
    expect(within(dialog).getByText('End "Ship the release"?')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole("button", { name: "End work" }))
    await waitFor(() => expect(end).toHaveBeenCalledWith("act_x"))
    expect((await screen.findByRole("status")).textContent).toBe(ENDED_LINE)
    expect(ENDED_LINE).toBe("Ended by you. It moved to History.")
  })
})

describe("Since you looked", () => {
  it("shows four rows, then Show n more and Show fewer", () => {
    expect(SINCE_ROWS).toBe(4)
    const recent = Array.from({ length: 6 }, (_, index) => ({ ...base.recent[index % base.recent.length]!, id: `act_00000000-0000-4000-8000-00000000010${index}` }))
    const now = { ...base, recent }
    const block = nowBlocks(now).find((entry) => entry.kind === "sinceYouLooked")
    expect(block?.kind === "sinceYouLooked" && [block.recent.length, block.more.length]).toEqual([4, 2])

    render(<InboxView overview={overviewOf(now)} service={service()} />)
    const list = () => screen.getByRole("list", { name: "Since you looked" })
    expect(within(list()).getAllByRole("listitem")).toHaveLength(4)
    fireEvent.click(screen.getByRole("button", { name: /Show 2 more/u }))
    expect(within(list()).getAllByRole("listitem")).toHaveLength(6)
    fireEvent.click(screen.getByRole("button", { name: /Show fewer/u }))
    expect(within(list()).getAllByRole("listitem")).toHaveLength(4)
  })
})

describe("Now shows live work only", () => {
  it("has no Today block, strip or agent time, and View history is the last thing", () => {
    const { container } = render(<InboxView overview={overviewOf(base)} service={service()} />)
    expect(screen.queryByText("Today")).toBeNull()
    expect(container.querySelector("[data-now-strip]")).toBeNull()
    expect(container.querySelector("[data-hud-agent-time]")).toBeNull()
    expect(container.querySelector(".now-deck-sentence")).toBeNull()
    const links = [...container.querySelectorAll("a")]
    expect(links.at(-1)?.textContent).toContain("View history")
  })

  it("Standing by keeps View history after it", () => {
    const empty = { ...base, needsYou: [], waitingOnYou: [], running: [], quiet: [], paused: [], folds: { waitingOnYou: 0, quiet: 0, paused: 0 } }
    const { container } = render(<InboxView overview={overviewOf(empty)} service={service()} />)
    expect(screen.getByText("Standing by")).toBeTruthy()
    expect([...container.querySelectorAll("a")].at(-1)?.textContent).toContain("View history")
  })
})

describe("the link mark", () => {
  it("marks the card whose notification carries a link, and only that one", () => {
    const linked = { ...base.running[0]!, notificationId: NOTIFICATION }
    const now = { ...base, running: [linked] }
    const notification = listed(NOTIFICATION, { state: "safe", href: "https://example.test/pr/1" })
    render(<InboxView overview={overviewOf(now, [notification])} service={service()} />)
    const card = within(screen.getByRole("list", { name: "Running" })).getByRole("button", { name: `Open ${linked.title}` }).closest<HTMLElement>(".card")!
    expect(within(card).getByLabelText("Has a link")).toBeTruthy()
    const other = screen.getByRole("button", { name: `Open ${base.waitingOnYou[0]!.title}` }).closest<HTMLElement>(".card")!
    expect(within(other).queryByLabelText("Has a link")).toBeNull()
  })

  it("is absent when the destination is not set", () => {
    const item = { ...base.running[0]!, notificationId: NOTIFICATION }
    const notification = listed(NOTIFICATION, { state: "not-set", href: null })
    render(<InboxView overview={overviewOf({ ...base, running: [item] }, [notification])} service={service()} />)
    expect(screen.queryByLabelText("Has a link")).toBeNull()
  })
})

describe("a missed question on Now", () => {
  const missed = {
    ...base.needsYou[0]!,
    title: "Deploy to staging?",
    question: { id: QUESTION, standing: "missed" as const, askedAt: "2026-10-15T14:02:00.000Z", openedAt: null },
  }

  it("is recognised by its standing", () => {
    expect(isMissedQuestion(missed)).toBe(true)
    expect(isMissedQuestion(base.needsYou[0]!)).toBe(false)
  })

  it("offers Dismiss and Answer late, and says what a late answer means", async () => {
    const svc = service()
    render(<InboxView overview={overviewOf({ ...base, needsYou: [missed] })} service={svc} />)
    const card = screen.getByRole("button", { name: `Open ${missed.title}` }).closest<HTMLElement>(".card")!
    expect(card.textContent).toContain(LATE_ANSWER_NOTE)
    expect(card.textContent).toMatch(/Asked \d/u)
    expect(within(card).getByRole("button", { name: "Answer late" })).toBeTruthy()
    fireEvent.click(within(card).getByRole("button", { name: "Dismiss" }))
    await waitFor(() => expect(svc.dismissMissedQuestion).toHaveBeenCalledWith(QUESTION))
  })
})
