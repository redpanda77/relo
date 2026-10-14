import { describe, expect, it } from "vitest"
import { nowSummarySchema } from "@relo/notification-contracts"

import fixtureText from "../../../../../packages/contracts/fixtures/owner-state-v1.json?raw"
import { nowBlocks, nowRowView, sinceLine, sinceParts } from "@/features/inbox/now-model"

const summary = nowSummarySchema.parse(JSON.parse(fixtureText).nowSummary)

describe("now model", () => {
  it("blocks follow the spec order", () => {
    const order = ["sinceYouLooked", "needsYou", "fold", "running", "fold", "fold", "sessions", "allClear"]
    const kinds = nowBlocks(summary).map((block) => block.kind)
    let at = 0
    for (const kind of kinds) {
      const next = order.indexOf(kind, at)
      expect(next).toBeGreaterThanOrEqual(0)
      at = next + (kind === "fold" ? 0 : 1)
    }
    expect(kinds[0]).toBe("sinceYouLooked")
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

  it("quiet rows never say running", () => {
    for (const item of [...summary.quiet, ...summary.running.filter((i) => i.owner.state === "working_quietly")]) {
      expect(nowRowView(item, () => "5 min ago").line ?? "").not.toMatch(/running/i)
    }
  })

  it("folds equal the summary counts", () => {
    for (const block of nowBlocks(summary)) {
      if (block.kind === "fold") expect(block.count).toBe(summary.folds[block.fold])
    }
  })
})
