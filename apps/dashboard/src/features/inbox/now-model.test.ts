import { describe, expect, it } from "vitest"
import { nowSummarySchema } from "@relo/notification-contracts"

import fixtureText from "../../../../../packages/contracts/fixtures/owner-state-v1.json?raw"
import { isSealedItem, nowBlocks, nowCardView, sinceLine, sinceParts, withoutUnreadable } from "@/features/inbox/now-model"

const summary = nowSummarySchema.parse(JSON.parse(fixtureText).nowSummary)

describe("now model", () => {
  it("blocks follow the spec order", () => {
    const order = ["needsYou", "waitingOnYou", "running", "sinceYouLooked", "fold", "fold", "sessions", "allClear"]
    const kinds = nowBlocks(summary).map((block) => block.kind)
    let at = 0
    for (const kind of kinds) {
      const next = order.indexOf(kind, at)
      expect(next).toBeGreaterThanOrEqual(0)
      at = next + (kind === "fold" ? 0 : 1)
    }
    expect(kinds.indexOf("sinceYouLooked")).toBeGreaterThan(kinds.indexOf("running"))
  })

  it("since line copy", () => {
    expect(sinceParts({ since: summary.serverTime, finished: 3, failed: 1, waitingOnYou: 0, stoppedWithoutFinishing: 1, needsYou: 0 }))
      .toEqual(["3 finished", "1 failed", "1 stopped without finishing"])
    const serverTime = "2026-10-14T12:00:00Z"
    const empty = { finished: 0, failed: 0, waitingOnYou: 0, stoppedWithoutFinishing: 0, needsYou: 0 }
    expect(sinceLine({ serverTime, sinceYouLooked: { since: "2026-10-14T04:00:00Z", ...empty } }).text).toBe("Nothing new in the last 8 hours.")
    expect(sinceLine({ serverTime, sinceYouLooked: { since: "2026-10-14T04:00:00Z", ...empty, finished: 2 } }).text)
      .toBe("In the last 8 hours: 2 finished")
    expect(sinceLine({ serverTime, sinceYouLooked: { since: "2026-10-14T10:00:00Z", ...empty } }).muted).toBe(true)
  })

  it("waiting on you is an open section, never a fold", () => {
    const blocks = nowBlocks(summary)
    expect(blocks.find((block) => block.kind === "waitingOnYou")).toMatchObject({ items: summary.waitingOnYou })
    expect(blocks.some((block) => block.kind === "fold" && (block.fold as string) === "waitingOnYou")).toBe(false)
  })

  it("quiet cards never say running, and only moving work ticks a running timer", () => {
    const quietly = { ...summary.running[0]!, owner: { ...summary.running[0]!.owner, state: "working_quietly" as const } }
    for (const item of [...summary.quiet, quietly]) {
      const view = nowCardView(item, () => "5 min ago")
      expect([view.state?.label, ...view.facts].join(" · ")).not.toMatch(/running/i)
      expect(view.runningSince).toBeNull()
      expect(view.live).toBe(false)
    }
    const moving = nowCardView(summary.running[0]!, () => "5 min ago")
    expect(moving.state?.label).toBe("Running")
    expect(moving.runningSince).toBe(summary.running[0]!.startedAt)
    expect(moving.meter?.live).toBe(true)
  })

  it("a dimmed card says why, in the server's reason", () => {
    const item = summary.quiet[0]!
    const dimmed = { ...item, owner: { ...item.owner, absence: { reason: "session_ended" as const, since: item.owner.evidenceAt } } }
    expect(nowCardView(dimmed, () => "5 min ago").facts[0]).toBe("Session ended")
    expect(nowCardView(item, () => "5 min ago").facts).not.toContain("Session ended")
  })

  it("labels are sentence case from the one outcome table", () => {
    const [failed, done] = summary.recent
    expect(nowCardView(failed!, String).state?.label).toBe("Failed")
    expect(nowCardView(done!, String).state?.label).toBe("Done")
    const unfinished = { ...done!, owner: { ...done!.owner, state: "left_unfinished" as const } }
    expect(nowCardView(unfinished, String).state?.label).toBe("Left unfinished")
    expect(nowCardView(summary.waitingOnYou[0]!, String).state).toMatchObject({ label: "Your turn", tone: "yellow" })
    // A needs-you card carries its reason as the mono chip instead of a state word.
    const needs = nowCardView(summary.needsYou[0]!, String)
    expect(needs.chip).toBe("QUESTION")
    expect(needs.state).toBeNull()
    expect(needs.tone).toBe("orange")
  })

  it("a sealed card shows no placeholder text", () => {
    const sealed = { ...summary.running[0]!, title: "Encrypted card", status: "Updating…", steps: { done: 1, total: 3, current: "Encrypted" } }
    expect(isSealedItem(sealed)).toBe(true)
    const view = nowCardView(sealed, String)
    expect(view.encrypted).toBe(true)
    expect(view.summary).toBeNull()
    expect(view.meter?.steps?.current).toBeNull()
    expect(view.facts.join(" ")).not.toContain("Encrypted")
  })

  it("folds equal the summary counts", () => {
    for (const block of nowBlocks(summary)) {
      if (block.kind === "fold") expect(block.count).toBe(summary.folds[block.fold])
    }
  })

  it("a linked browser leaves out what it cannot open, never what needs the owner, and counts match", () => {
    expect(withoutUnreadable(summary)).toBe(summary)
    const seal = <T extends { title: string }>(item: T) => ({ ...item, title: "Encrypted card" })
    const sealed = {
      ...summary,
      needsYou: summary.needsYou.map(seal),
      running: summary.running.map(seal),
      recent: summary.recent.map(seal),
      quiet: summary.quiet.map(seal),
    }
    const shown = withoutUnreadable(sealed)
    expect(shown.needsYou).toHaveLength(summary.needsYou.length)
    expect(shown.running).toEqual([])
    expect(shown.recent).toEqual([])
    expect(shown.folds.quiet).toBe(summary.folds.quiet - summary.quiet.length)
    expect(shown.sinceYouLooked.finished + shown.sinceYouLooked.failed + shown.sinceYouLooked.stoppedWithoutFinishing).toBe(
      sealed.sinceYouLooked.finished + sealed.sinceYouLooked.failed + sealed.sinceYouLooked.stoppedWithoutFinishing - summary.recent.length
    )
  })
})
