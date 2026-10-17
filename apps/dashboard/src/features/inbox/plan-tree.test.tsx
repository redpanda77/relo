import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { deepPlan, flatPlan, longPlan, manyRoundsPlan, nestedPlan, roundsPlan, sealedPlan, skippedPlan, stoppedPlan } from "@/features/inbox/plan-fixtures"
import type { PlanFixture } from "@/features/inbox/plan-fixtures"
import { PlanTree } from "@/features/inbox/plan-tree"

afterEach(cleanup)

function show(fixture: PlanFixture) {
  return render(<PlanTree headingId="plan-heading" entries={fixture.entries} rounds={fixture.rounds} standing={fixture.standing ?? "moving"} />)
}
const step = (id: string) => document.querySelector(`[data-plan-step="${id}"]`) as HTMLElement | null

describe("PlanTree", () => {
  it("reads the server's count when the card carries one, and counts locally only without it", () => {
    render(<PlanTree headingId="h" entries={flatPlan.entries} serverSteps={{ done: 0, total: 4, currentIndex: 1 }} />)
    expect(document.querySelector("[data-plan-count]")).toHaveTextContent("Step 1 of 4")
  })

  it("a flat plan is a plain list with the count in the header and no toggles", () => {
    show(flatPlan)
    expect(screen.getByRole("heading", { name: "Plan" })).toBeInTheDocument()
    expect(document.querySelector("[data-plan-count]")).toHaveTextContent("Step 3 of 5")
    expect(document.querySelectorAll("[data-plan-step]")).toHaveLength(5)
    expect(document.querySelector("[data-plan-round]")).toBeNull()
    expect(document.querySelector(".plan-toggle")).toBeNull()
    expect(step("s3")).toHaveAttribute("data-state", "current")
    expect(step("s3")!.querySelector("[data-mark]")).toHaveAttribute("data-mark", "current")
    expect(step("s1")!.querySelector("[data-mark]")).toHaveAttribute("data-mark", "done")
    expect(step("s4")!.querySelector("[data-mark]")).toHaveAttribute("data-mark", "open")
  })

  it("speaks each row: position, label, state and substep count", () => {
    show(nestedPlan)
    expect(step("s2")!.querySelector(".plan-body")).toHaveTextContent("Step 2 of 4. Patch token refresh. current, 1 of 3 substeps done")
    expect(step("s4")!.querySelector(".plan-body")).toHaveTextContent("Step 2 of 3, level 2. Fix the refresh race. current")
  })

  it("opens only the current step; another branch opens with its toggle (aria-expanded)", () => {
    show(nestedPlan)
    expect(step("s3")).not.toBeNull()
    expect(step("s7")).toBeNull()
    const toggle = within(step("s6")!).getByRole("button", { name: "Show substeps of Run the tests" })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    // The current step has no toggle: it is already open.
    expect(within(step("s2")!).queryByRole("button", { name: /substeps of Patch/u })).toBeNull()
    fireEvent.click(toggle)
    expect(step("s7")).not.toBeNull()
    expect(step("s8")).not.toBeNull()
    expect(within(step("s6")!).getByRole("button", { name: "Hide substeps of Run the tests" })).toHaveAttribute("aria-expanded", "true")
    // Its meta shows the count, and the rail belongs to the step, so it holds its children inside the same item.
    expect(step("s7")!.closest('[data-plan-step="s6"]')).toBe(step("s6"))
    fireEvent.click(within(step("s6")!).getByRole("button", { name: "Hide substeps of Run the tests" }))
    expect(step("s7")).toBeNull()
  })

  it("draws three levels, each indented by a nested list", () => {
    show(deepPlan)
    expect([step("a"), step("b"), step("c")].map((item) => item!.getAttribute("data-depth"))).toEqual(["0", "1", "2"])
    expect(step("c")!.parentElement!.parentElement).toBe(step("b"))
    expect(step("b")!.parentElement!.parentElement).toBe(step("a"))
  })

  it("rounds: closed rounds fold with their outcome and open on tap; the round in play is open", () => {
    show(roundsPlan)
    expect(document.querySelector("[data-plan-count]")).toHaveTextContent("Round 3 · Step 2 of 3")
    expect(screen.getByText("Login fixed: token refresh patched and tested")).toBeInTheDocument()
    expect(step("r3a")).not.toBeNull()
    expect(step("r1a")).toBeNull()
    const toggle = screen.getByRole("button", { name: "Show the steps of round 1" })
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    fireEvent.click(toggle)
    expect(step("r1a")).not.toBeNull()
    expect(screen.getByRole("button", { name: "Hide the steps of round 1" })).toHaveAttribute("aria-expanded", "true")
    fireEvent.click(screen.getByRole("button", { name: "Hide the steps of round 1" }))
    expect(step("r1a")).toBeNull()
    // The round in play has no chevron.
    expect(screen.queryByRole("button", { name: /steps of round 3/u })).toBeNull()
  })

  it("five rounds: the earlier ones are one row that opens them", () => {
    show(manyRoundsPlan)
    expect(document.querySelectorAll("[data-plan-round]")).toHaveLength(2)
    fireEvent.click(screen.getByRole("button", { name: /3 earlier rounds/u }))
    expect(document.querySelectorAll("[data-plan-round]")).toHaveLength(5)
  })

  it("a 30-step plan folds to a window and never truncates a long label", () => {
    show(longPlan)
    expect(document.querySelectorAll("[data-plan-step]").length).toBeLessThan(30)
    const toGo = screen.getByRole("button", { name: /3 steps to go, hidden/u })
    const full = longPlan.entries.find((entry) => entry.id === "p3")!.label!
    // The whole label is in the DOM (CSS wraps it to two lines); nothing is cut to a fixed width.
    expect(within(step("p3")!).getByText(full)).toBeInTheDocument()
    expect(full.length).toBeGreaterThan(80)
    fireEvent.click(toGo)
    expect(step("p9")).not.toBeNull()
    expect(screen.queryByRole("button", { name: /steps to go/u })).toBeNull()
  })

  it("a long label opens to its detail and times in a disclosure", () => {
    show(flatPlan)
    const label = within(step("s3")!).getByRole("button", { name: "Patch token refresh" })
    expect(label).toHaveAttribute("aria-expanded", "false")
    fireEvent.click(label)
    expect(label).toHaveAttribute("aria-expanded", "true")
    expect(within(step("s3")!).getByText("The refresh raced the logout; one lock now guards both.")).toBeInTheDocument()
    expect(within(step("s3")!).getByText(/^Started /u)).toBeInTheDocument()
  })

  it("skipped steps are one quiet row at the end that shows them on tap", () => {
    show(skippedPlan)
    expect(step("k2")).toBeNull()
    expect(document.querySelector("[data-plan-count]")).toHaveTextContent("Step 2 of 3")
    fireEvent.click(screen.getByRole("button", { name: /2 steps skipped, hidden/u }))
    expect(step("k2")!.querySelector("[data-mark]")).toHaveAttribute("data-mark", "skipped")
  })

  it("sealed labels this browser cannot open read as such, never Step n", () => {
    show(sealedPlan)
    expect(screen.getAllByText("Not readable in this browser")).toHaveLength(3)
    expect(screen.queryByText(/^Step \d+$/u)).toBeNull()
  })

  it("a stopped work says where it stopped and marks the current step stopped, the unreached ones open", () => {
    show(stoppedPlan)
    expect(document.querySelector("[data-plan-count]")).toHaveTextContent("Stopped at 1 of 4")
    expect(step("f2")!.querySelector("[data-mark]")).toHaveAttribute("data-mark", "stopped")
    expect(step("f3")!.querySelector("[data-mark]")).toHaveAttribute("data-mark", "open")
  })

  it("draws a run of unreadable steps as one row with the done mark", () => {
    render(<PlanTree entries={[{ id: "a", state: "done" }, { id: "b", state: "done" }, { id: "c", state: "current", label: "Build it" }, { id: "d", state: "open" }, { id: "e", state: "open" }]} />)
    expect(screen.getByText("2 done · names not readable in this browser")).toBeInTheDocument()
    expect(screen.getByText("2 to go · names not readable in this browser")).toBeInTheDocument()
    expect(document.querySelector('[data-plan-unreadable="done"] [data-mark]')).toHaveAttribute("data-mark", "done")
    expect(screen.queryByText("Not readable in this browser")).toBeNull()
  })

  it("never clamps a label: a very long one is whole in the DOM and is not a button", () => {
    const label = "word ".repeat(80).trim()
    render(<PlanTree entries={[{ id: "a", state: "current", label }]} />)
    expect(screen.getByText(label)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: label })).toBeNull()
  })
})
