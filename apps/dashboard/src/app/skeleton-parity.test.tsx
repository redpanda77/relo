import { cleanup, render } from "@testing-library/react"
import { nowSummarySchema, type NowSummary } from "@relo/notification-contracts"
import { afterEach, describe, expect, it, vi } from "vitest"

import fixtureText from "../../../../packages/contracts/fixtures/owner-state-v1.json?raw"

const routes = vi.hoisted(() => ({ fetchDashboardRoute: vi.fn(() => new Promise(() => {})) }))
vi.mock("@/app/dashboard-route-loader", () => routes)

// The server's first frame, rendered here beside React's page: the same key nodes, the same classes.
import { renderPageSkeleton } from "../../../server/src/web/dashboard-skeleton"
import { NowDeck } from "@/components/organisms/now-deck"
import { PageTitle, SplitPage } from "@/components/page"
import { orbMotion } from "@/lib/orb-theme"
import { nowCounts } from "@/features/inbox/now-model"
import { InboxView } from "@/features/inbox/inbox-view"
import type { InboxOverview } from "@/features/inbox/types"
import type { InboxService } from "@/services/inbox-service"

afterEach(cleanup)

// The canonical contract fixture (the phone and now-view.test.tsx pin the same file).
const summary: NowSummary = nowSummarySchema.parse(JSON.parse(fixtureText).nowSummary)

const KEY_NODES = [
  "main#main-content",
  ".split-page-grid",
  ".split-page-aside",
  ".now-deck",
  ".now-deck-head",
  "h1.page-title",
  ".now-deck-stage",
  ".orb-stage-painted",
  ".now-deck-centre",
  ".now-deck-centre-number > span",
  ".now-deck-instruments",
  ".now-deck-readouts",
  "[data-readout]",
  "[data-readout] > span:first-child",
  "[data-readout] > span:last-child",
  // Beside the work (1100px+) the deck column also carries its sentence.
  ".now-deck-more",
  ".now-deck-sentence",
]

const classesOf = (root: ParentNode, selector: string) =>
  [...root.querySelectorAll(selector)].map((node) =>
    [...node.classList].filter((name) => !name.startsWith("loading-") && name !== "outline-none" && name !== "breathe").sort().join(" ")
  )

const skeleton = (now: NowSummary) => {
  const server = document.createElement("div")
  server.innerHTML = renderPageSkeleton(
    { kind: "inbox-overview", shell: { title: "Now", active: "inbox" }, now },
    { now: new Date(2026, 9, 15, 12) }
  )!
  return server
}

describe("the server skeleton and React's Now", () => {
  it("carry the same deck: classes, the four readouts with the server's numbers, and the centre", () => {
    const server = skeleton(summary)
    const counts = nowCounts(summary)
    const { container } = render(
      <SplitPage
        aside={
          <NowDeck
            heading={<PageTitle title="Now" />}
            today={0}
            sessions={counts.sessionsWorking}
            waiting={counts.waitingOnYou}
            running={counts.running}
            needsYou={counts.needsYou}
            motion={orbMotion(summary, false)}
            arcs={[]}
            sentence="One sentence"
            layout="split"
          />
        }
      >
        <div />
      </SplitPage>
    )
    for (const selector of KEY_NODES) {
      const ours = classesOf(server, selector)
      expect(ours.length, selector).toBeGreaterThan(0)
      expect(ours, selector).toEqual(classesOf(container, selector))
    }
    expect(server.querySelector("h1.page-title")?.textContent).toBe(container.querySelector("h1.page-title")?.textContent)
    const readouts = (root: ParentNode) =>
      [...root.querySelectorAll("[data-readout]")].map((node) => [
        node.getAttribute("data-readout"),
        node.querySelector(".readout-value")?.textContent,
        node.hasAttribute("data-lit"),
      ])
    expect(readouts(server)).toEqual(readouts(container))
    expect(readouts(server).map(([label]) => label)).toEqual(["Sessions", "Waiting", "Running", "Needs you"])
    const centre = (root: ParentNode) => [root.querySelector("[data-hud-centre]")?.getAttribute("data-hud-centre"), root.querySelector(".hud-number")?.textContent]
    expect(centre(server)).toEqual(centre(container))
  })

  it("lay the body out as React's: the open sections in order, then Since you looked and its rows", () => {
    expect(summary.recent.length).toBeGreaterThan(0)
    const server = skeleton(summary)
    const overview = {
      version: 1,
      kind: "inbox-overview",
      route: { path: "/dashboard", page: 1 },
      shell: { account: { id: "acc_parity", email: "owner@example.test", name: "Owner" } },
      summary: { pendingResponses: 0, pendingApprovals: 0, notifications: 0, deliveries: 0 },
      pendingResponses: [],
      approvalRequests: [],
      approvalPagination: { page: 1, pageSize: 25, total: 0, pageCount: 1, previousHref: null, nextHref: null },
      recentNotifications: [],
      now: summary,
    } as unknown as InboxOverview
    const service = { decideApproval: vi.fn(), reactivateActivity: vi.fn(), getSnapshot: vi.fn() } as unknown as InboxService
    const { container } = render(<InboxView overview={overview} service={service} />)

    const ours = server.querySelector('.split-page-body > [data-now-slot="sinceYouLooked"]')!
    const theirs = container.querySelector('.split-page-body > [data-now-slot="sinceYouLooked"]')!
    expect(ours.className).toBe(theirs.className)
    // The block's own spacing, and the sentence's line box (text-sm) before its rows.
    const [ourSection, theirSection] = [ours.firstElementChild!, theirs.firstElementChild!]
    expect(ourSection.tagName).toBe(theirSection.tagName)
    expect(classesOf(ours, ":scope > section")).toEqual(classesOf(theirs, ":scope > section"))
    const [ourLine, theirLine] = [ourSection.firstElementChild!, theirSection.firstElementChild!]
    expect(ourLine.tagName).toBe(theirLine.tagName)
    expect(ourLine.classList.contains("text-sm")).toBe(true)
    expect(theirLine.classList.contains("text-sm")).toBe(true)
    // Then one frosted list, as many rows as React shows there (loading.css keeps one on a phone).
    const [ourList, theirList] = [ourSection.children[1]!, theirSection.children[1]!]
    expect(ourList.classList.contains("glass") && theirList.classList.contains("glass")).toBe(true)
    expect(ourList.querySelectorAll(".loading-work-row")).toHaveLength(Math.min(3, summary.recent.length))
    expect(theirList.children).toHaveLength(Math.min(3, summary.recent.length))
    // The open sections and Since you looked in React's order, each open one a section caption over its cards.
    const slots = (root: ParentNode) =>
      [...root.querySelectorAll(".split-page-body > .now-block")].map((node) => node.getAttribute("data-now-slot"))
    const open = new Set(["needsYou", "waitingOnYou", "running"])
    expect(slots(server)).toEqual(slots(container).filter((slot) => slot === "sinceYouLooked" || open.has(slot!)))
    for (const slot of open) {
      const our = server.querySelector(`[data-now-slot="${slot}"] > section`)
      const their = container.querySelector(`[data-now-slot="${slot}"] > section`)
      if (!their) continue
      expect(classesOf(our!.parentElement!, ":scope > section"), slot).toEqual(classesOf(their.parentElement!, ":scope > section"))
      expect(classesOf(our!, ":scope > .now-card-grid"), slot).toEqual(classesOf(their, ":scope > .now-card-grid"))
    }
  })
})
