import { describe, expect, it } from "vitest"

import { openPlanText } from "@/lib/e2ee/open-plan-text"
import type { PlanFixture } from "@/features/inbox/plan-fixtures"
import {
  doneFixture, flatPlan, longPlan, manyRoundsPlan, nestedPlan, deepPlan, roundsPlan, sealedPlan, skippedPlan, stoppedPlan, windowedPlan,
} from "@/features/inbox/plan-fixtures"
import {
  durationLabel, itemsIn, rowsOf, makeOutline, planHeader, progressOf, roundSlots, startsFolded, unskipped,
  type PlanBranch, type PlanItem,
} from "@/features/inbox/plan-outline"

const ids = (items: PlanItem[]) => items.map((item) => (item.kind === "fold" ? `[${item.text}]` : item.id))
const branch = (item: PlanItem | undefined) => item as PlanBranch

function outlineOf(fixture: PlanFixture) {
  return makeOutline(fixture.entries, fixture.rounds)
}

describe("plan outline", () => {
  it("a flat single-round plan has no round sections and no nesting", () => {
    const outline = outlineOf(flatPlan)
    expect(outline.isFlat).toBe(true)
    expect(outline.hasRoundSections).toBe(false)
    expect(ids(itemsIn(outline.currentRound!))).toEqual(["s1", "s2", "s3", "s4", "s5"])
    expect(progressOf(flatPlan.entries, flatPlan.rounds, "moving")).toMatchObject({ done: 2, total: 5, currentId: "s3" })
    expect(planHeader(progressOf(flatPlan.entries, undefined, "moving"))).toBe("Step 3 of 5")
  })

  it("opens only the current step; other branches show a count and stay folded (U7)", () => {
    const outline = outlineOf(nestedPlan)
    const items = itemsIn(outline.currentRound!)
    expect(ids(items)).toEqual(["s1", "s2", "s6", "s9"])
    const current = branch(items[1])
    expect(current.opened).toBe(true)
    expect(ids(current.children)).toEqual(["s3", "s4", "s5"])
    expect(current.count).toEqual({ done: 1, total: 3 })
    const other = branch(items[2])
    expect(other.opened).toBe(false)
    expect(other.children).toEqual([])
    expect(other.count).toEqual({ done: 0, total: 2 })
    // The owner opens it: the rail belongs to the branch, so it runs through the opened children.
    const owned = branch(itemsIn(outline.currentRound!, { steps: new Set(["s6"]) })[2])
    expect(ids(owned.children)).toEqual(["s7", "s8"])
    expect(owned.opened).toBe(true)
  })

  it("the progress count is the contracts' engine: top-level steps only (U1), with the sub count", () => {
    const progress = progressOf(nestedPlan.entries, undefined, "moving")
    expect(progress).toMatchObject({ done: 1, total: 4, currentId: "s2", sub: { done: 1, total: 3 } })
    expect(planHeader(progress)).toBe("Step 2 of 4")
  })

  it("nests to three levels and keeps the current branch open down to the leaf", () => {
    const outline = outlineOf(deepPlan)
    const top = branch(itemsIn(outline.currentRound!)[0])
    expect(outline.isFlat).toBe(false)
    const mid = branch(top.children[0])
    const leaf = branch(mid.children[0])
    expect([top.node.depth, mid.node.depth, leaf.node.depth]).toEqual([0, 1, 2])
    expect(leaf.node.state).toBe("current")
    expect(ids(mid.children)).toEqual(["c", "d"])
  })

  it("with three rounds only the round in play is open; closed ones fold with their outcome", () => {
    const outline = outlineOf(roundsPlan)
    expect(outline.hasRoundSections).toBe(true)
    expect(outline.currentRound?.n).toBe(3)
    expect(outline.rounds.map((round) => startsFolded(outline, round))).toEqual([true, true, false])
    expect(outline.rounds[0]!.outcome).toBe("Login fixed: token refresh patched and tested")
    expect(roundSlots(outline, false).map((slot) => slot.kind)).toEqual(["round", "round", "round"])
    const progress = progressOf(roundsPlan.entries, roundsPlan.rounds, "moving")
    expect(planHeader(progress)).toBe("Round 3 · Step 2 of 3")
    expect(ids(itemsIn(outline.currentRound!))).toEqual(["r3a", "r3b", "r3e"])
  })

  it("more than three rounds fold the earlier ones into one row until opened", () => {
    const outline = outlineOf(manyRoundsPlan)
    expect(roundSlots(outline, false)).toMatchObject([{ kind: "earlier", count: 3 }, { kind: "round" }, { kind: "round" }])
    expect(roundSlots(outline, true).map((slot) => slot.kind)).toEqual(["round", "round", "round", "round", "round"])
  })

  it("a delivered round reads as such in the header; a finished work says done", () => {
    const delivered = { ...roundsPlan.rounds![2]!, state: "closed" as const, outcome: "Offline works" }
    const rounds = [roundsPlan.rounds![0]!, roundsPlan.rounds![1]!, delivered]
    const entries = roundsPlan.entries.map((entry) => ({ ...entry, state: entry.round === 3 ? ("done" as const) : entry.state }))
    expect(planHeader(progressOf(entries, rounds, "moving"))).toBe("Round 3 delivered")
    expect(planHeader(progressOf(doneFixture.entries, undefined, "done"), "done")).toBe("3 of 3 done")
    expect(planHeader(progressOf(flatPlan.entries, undefined, "moving"), "paused")).toBe("Paused at 2 of 5")
  })

  it("30 steps (10 phases of 2 substeps) fold to a window around the current phase, labels whole", () => {
    const outline = outlineOf(longPlan)
    expect(outline.rounds[0]!.nodes).toHaveLength(30)
    const items = itemsIn(outline.currentRound!)
    // 10 top-level phases: focus 3 -> from the start, 3 to go after the window.
    expect(ids(items)).toEqual(["p0", "p1", "p2", "p3", "p4", "p5", "p6", "[3 to go]"])
    const current = branch(items[3])
    expect(current.opened).toBe(true)
    expect(current.count).toEqual({ done: 1, total: 2 })
    expect(current.node.label.length).toBeGreaterThan(80)
    expect(current.node.label).toBe(longPlan.entries.find((entry) => entry.id === "p3")!.label)
    const opened = itemsIn(outline.currentRound!, { folds: new Set(["r1:toGo"]) })
    expect(ids(opened).at(-1)).toBe("p9")
  })

  it("windows more than 7 steps: done fold, two before, the current, three after, to-go fold", () => {
    const outline = outlineOf(windowedPlan)
    expect(ids(itemsIn(outline.currentRound!))).toEqual(["[4 done]", "w4", "w5", "w6", "w7", "w8", "w9", "[2 to go]"])
    const all = itemsIn(outline.currentRound!, { folds: new Set(["r1:done", "r1:toGo"]) })
    expect(all).toHaveLength(12)
  })

  it("hides skipped steps behind one quiet row at the end, shown on tap; they are not counted (U8)", () => {
    const outline = outlineOf(skippedPlan)
    expect(ids(itemsIn(outline.currentRound!))).toEqual(["k1", "k3", "k5", "[2 skipped]"])
    expect(ids(itemsIn(outline.currentRound!, { folds: new Set(["r1:skipped"]) }))).toEqual(["k1", "k3", "k5", "k2", "k4"])
    expect(progressOf(skippedPlan.entries, undefined, "moving")).toMatchObject({ done: 1, total: 3 })
  })

  it("a stopped work counts its unreached steps as not done, and shows them open rather than skipped", () => {
    const progress = progressOf(stoppedPlan.entries, undefined, "stopped")
    expect(planHeader(progress, "stopped")).toBe("Stopped at 1 of 4")
    const outline = makeOutline(unskipped(stoppedPlan.entries))
    expect(outline.rounds[0]!.nodes.map((node) => node.state)).toEqual(["done", "current", "open", "open"])
  })

  it("a sealed label this browser cannot open is unreadable, never a placeholder", () => {
    const outline = outlineOf(sealedPlan)
    const nodes = outline.rounds[0]!.nodes
    expect(nodes.map((node) => node.readable)).toEqual([false, false, false])
    expect(nodes.map((node) => node.label)).toEqual(["", "", ""])
  })

  it("opens sealed text by step id (v2 phases), round titles and outcomes by r<n>", () => {
    const plan: Array<Record<string, unknown>> = [{ id: "a", state: "done" }, { id: "b", state: "current", label: "Step 2" }, { id: "c", state: "open", round: 2 }]
    const rounds: Array<Record<string, unknown>> = [{ n: 1, state: "closed" }, { n: 2, state: "open" }]
    openPlanText(
      {
        phases: [
          { id: "r1", title: "Ship it", outcome: "Shipped", steps: [{ id: "b", label: "Run it", detail: "all suites" }, { id: "a", label: "Step 1" }] },
          { id: "r2", steps: [{ id: "c", label: "Cover offline" }] },
        ],
      },
      plan,
      rounds
    )
    // Matched by id, not by position: "a" has only a placeholder, so it stays unreadable.
    expect(plan[0]!.label).toBeUndefined()
    expect(plan[1]).toMatchObject({ label: "Step 2" })
    expect(plan[2]!.label).toBe("Cover offline")
    expect(rounds[0]).toMatchObject({ title: "Ship it", outcome: "Shipped" })
    const outline = makeOutline(plan as never, rounds as never)
    expect(outline.rounds[0]!.nodes.map((node) => node.readable)).toEqual([false, false])
  })

  it("v1 text pairs labels by position only when the counts agree", () => {
    const agree = [{ id: "a", state: "done" }, { id: "b", state: "open" }]
    openPlanText({ steps: ["Build", "Ship"] }, agree, undefined)
    expect(agree.map((item) => (item as { label?: string }).label)).toEqual(["Build", "Ship"])
    const differ = [{ id: "a", state: "done" }]
    openPlanText({ steps: ["Build", "Ship"] }, differ, undefined)
    expect((differ[0] as { label?: string }).label).toBeUndefined()
  })

  it("durations read like the phone's", () => {
    expect([30, 240, 3900, 7200, 90000].map(durationLabel)).toEqual([null, "4 min", "1 h 5 min", "2 h", "1 d 1 h"])
  })

  it("folds runs of unreadable steps into one quiet row; a single one, a child-bearing one or a current one stays", () => {
    const u = (id: string, state: "done" | "open" | "current", extra = {}) => ({ id, state, ...extra })
    const entries = [u("a", "done"), u("b", "done"), u("c", "done", { label: "Readable" }), u("e", "current"), u("f", "open"), u("g", "open"), u("h", "open"), u("i", "open", { parent: "h" })]
    const rows = rowsOf(itemsIn(makeOutline(entries).currentRound!))
    expect(rows.map((row) => (row.kind === "unreadable" ? row.text : row.kind === "branch" ? row.id : row.text))).toEqual([
      "2 done · names not readable in this browser", "c", "e", "2 to go · names not readable in this browser", "h",
    ])
  })
})
