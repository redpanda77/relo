// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { nowSummarySchema } from "@relo/notification-contracts"
import { afterEach, describe, expect, it } from "vitest"

import planCardText from "../../../../../packages/contracts/test/fixtures/plan-card.json?raw"
import fixtureText from "../../../../../packages/contracts/fixtures/owner-state-v1.json?raw"
import { StepTrack } from "@/components/atoms/step-track"
import { nowCardView } from "@/features/inbox/now-model"

afterEach(cleanup)

// The shared fixture the server and the iPhone read: 4 steps, the first with 3 substeps (2 done), and a stale
// work-level count. Every surface says "0 of 4", draws 4 segments, and fills step 1 to 2/3.
const card = JSON.parse(planCardText) as {
  card: { plan: Record<string, unknown>; progress: null }
  expected: { caption: string; segments: Array<{ state: string; fill: number }> }
}
const base = nowSummarySchema.parse(JSON.parse(fixtureText).nowSummary).running[0]!

describe("plan 14 workstream 7: progress counts top-level steps", () => {
  it("the Now card meter and caption read the server's plan wire", () => {
    const item = { ...base, steps: { done: 2, total: 7, current: null }, progress: card.card.plan as never }
    const view = nowCardView(item, () => "now")
    expect(view.meter?.steps).toMatchObject({ done: 0, total: 4, currentIndex: 1 })
    expect(view.meter?.steps?.fill).toBeCloseTo(2 / 3)
    expect(view.facts.join(" ")).toContain(card.expected.caption)
    expect(view.facts.join(" ")).not.toMatch(/of 7|75%/)
  })

  it("draws one segment per top-level step and fills the current one", () => {
    const { container } = render(<StepTrack done={0} total={4} currentIndex={1} fill={2 / 3} />)
    const segments = [...container.querySelectorAll(".step-bar > span:not(.step-sweep)")]
    expect(segments).toHaveLength(4)
    expect(segments.map((segment) => segment.getAttribute("data-step"))).toEqual(["current", null, null, null])
    expect((segments[0] as HTMLElement).style.getPropertyValue("--seg-fill")).toMatch(/^66\.6+\d*%$/)
    expect(container.querySelector("[role=progressbar]")?.getAttribute("aria-label")).toBe("Step 1 of 4")
    expect(container.textContent).not.toMatch(/%/)
  })
})
