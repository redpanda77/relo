import { describe, expect, it } from "vitest"

import { deliveryHeadline, deliveryStages } from "@/features/test-lab/delivery-chain"
import type { TestRun } from "@/features/test-lab/types"

function run(evidence: Partial<TestRun["evidence"]>, state = "ended"): TestRun {
  return {
    state,
    evidence: {
      provider: { state: "accepted", durableCommands: 1, apnsJobs: 1 },
      phone: { expected: 1, confirmed: 0 },
      activityKit: { state: null, summary: null },
      response: { kind: "approval", state: "denied", action: "deny", respondedAt: "2026-10-06T14:40:20Z" },
      ...evidence,
    },
  } as TestRun
}

describe("delivery chain", () => {
  it("an answer from the iPhone proves it received the request, even without a receipt", () => {
    const stages = deliveryStages(run({}))
    expect(stages.find((stage) => stage.id === "iphone")).toMatchObject({ state: "done", summary: "Received" })
    expect(stages.some((stage) => stage.summary === "Not reached")).toBe(false)
    expect(deliveryHeadline(run({})).text).toBe("Ended")
  })

  it("the Live Activity step reports the phone's proof that it showed the card", () => {
    const shown = run({ activityKit: { state: "received", summary: "Shown on the iPhone" } })
    expect(deliveryStages(shown).find((stage) => stage.id === "live-activity")).toMatchObject({
      state: "done", summary: "Shown on the iPhone" })
    expect(deliveryStages(run({})).find((stage) => stage.id === "live-activity")?.summary).toBe("No sign it was shown")
  })

  it("an ended run with no report and no answer still stops at the iPhone", () => {
    const silent = run({ response: { kind: "approval", state: "expired", action: null, respondedAt: null } })
    expect(deliveryStages(silent).find((stage) => stage.id === "iphone")?.state).toBe("failed")
    expect(deliveryHeadline(silent).text).toBe("Stopped at iPhone")
  })
})
