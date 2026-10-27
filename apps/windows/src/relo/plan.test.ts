// The plan line, bar and outline (apps/ios PlanProgress / PlanBar / PlanOutline), and the answer buttons.

import type { PlanDigestStep } from "@relo/notification-contracts"
import { describe, expect, it } from "vitest"
import { answerButtons } from "./answers"
import { durationLabel, foldText, itemsIn, makeOutline, planBar, planLine, roundSlots, WINDOW_LIMIT } from "./plan"

describe("plan line", () => {
  it("words the plan by how the work stands", () => {
    expect(planLine(2, 5, "Run the gates", "moving")).toBe("Step 3 of 5 · Run the gates")
    expect(planLine(2, 5, null, "moving")).toBe("2 of 5")
    expect(planLine(2, 5, "  ", "moving")).toBe("2 of 5")
    expect(planLine(5, 5, "x", "moving")).toBe("5 of 5 done")
    expect(planLine(2, 5, "x", "paused")).toBe("Paused at 2 of 5")
    expect(planLine(2, 5, "x", "stopped")).toBe("Stopped at 2 of 5")
    expect(planLine(0, 0, "x", "moving")).toBeNull()
  })
})

describe("plan bar", () => {
  it("shows done steps around the current one and never invents a position", () => {
    expect(planBar(2, 5, 4, 0.25).map((s) => s.state)).toEqual(["done", "done", "open", "current", "open"])
    expect(planBar(1, 3, null, null).map((s) => s.state)).toEqual(["done", "open", "open"])
    expect(planBar(3, 3, 2, 0.5).every((s) => s.state === "done")).toBe(true)
    expect(planBar(0, 0, null, null)).toEqual([])
  })
})

describe("outline", () => {
  const steps = (n: number): PlanDigestStep[] =>
    Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, state: i < 4 ? "done" : i === 4 ? "current" : "open", label: `Step label ${i + 1}` }))

  it("windows a long plan around the current step", () => {
    const outline = makeOutline(steps(WINDOW_LIMIT + 5), undefined)!
    const items = itemsIn(outline.rounds[0]!)
    expect(items[0]!.kind).toBe("fold")
    expect(items[0]!.kind === "fold" && foldText(items[0]!)).toBe("2 done")
    expect(items.at(-1)!.kind).toBe("fold")
    const open = new Set(["r1:done", "r1:toGo"])
    expect(itemsIn(outline.rounds[0]!, { expandedFolds: open }).every((i) => i.kind === "branch")).toBe(true)
  })

  it("hides skipped steps behind one fold and a sealed label reads unreadable", () => {
    const outline = makeOutline(
      [
        { id: "s1", state: "done", label: null },
        { id: "s2", state: "skipped", label: "Dropped idea" },
        { id: "s3", state: "open", label: "Step 3" },
      ],
      undefined,
    )!
    const nodes = outline.rounds[0]!.nodes
    expect(nodes[0]!.readable).toBe(false)
    expect(nodes[2]!.readable).toBe(false)
    const items = itemsIn(outline.rounds[0]!)
    expect(items.map((i) => i.kind)).toEqual(["branch", "branch", "fold"])
  })

  it("folds earlier rounds past three", () => {
    const plan: PlanDigestStep[] = [1, 2, 3, 4].map((round) => ({ id: `s${round}`, state: "done", label: `Do ${round}`, round }))
    const outline = makeOutline(plan, [1, 2, 3, 4].map((n) => ({ n, state: n === 4 ? "open" : "closed" })))!
    expect(roundSlots(outline, false).map((s) => s.kind)).toEqual(["earlier", "round", "round"])
    expect(roundSlots(outline, true).length).toBe(4)
  })

  it("labels durations", () => {
    expect(durationLabel(30)).toBeNull()
    expect(durationLabel(240)).toBe("4 min")
    expect(durationLabel(3900)).toBe("1 h 5 min")
    expect(durationLabel(7200)).toBe("2 h")
  })
})

describe("answers", () => {
  it("approval, yes/no and choice give their buttons; text gives none", () => {
    expect(answerButtons({ kind: "approval" }).map((b) => [b.label, b.action])).toEqual([["Approve", "approve"], ["Deny", "deny"]])
    expect(answerButtons({ kind: "yesNo" }).map((b) => b.action)).toEqual(["yes", "no"])
    const choice = answerButtons({ kind: "choice", options: ["a", "b", "c", "d", "e"].map((id) => ({ id, label: id.toUpperCase() })) })
    expect(choice.length).toBe(4)
    expect(choice[0]).toEqual({ label: "A", action: "choose", optionId: "a", prominent: false })
    expect(answerButtons({ kind: "text" })).toEqual([])
    expect(answerButtons(undefined)).toEqual([])
  })
})
