import { describe, expect, it } from "vitest"
import { eventsBetween } from "./events"
import { EMPTY } from "./presentation"
import { ONBOARDING_ROW_ID, onboardingPresentation, parseStage, type OnboardingStage } from "./onboarding"
import { rowBar } from "./presentation"

const stage = (over: Partial<OnboardingStage> = {}): OnboardingStage => ({ phase: "working", stepsDone: 0, stepsTotal: 4, title: "Setting up Relo", status: null, startedAt: 0, ...over })

describe("the staged onboarding (OnboardingStage.swift, O02)", () => {
  it("reads the event’s payload, with a wrapper and other spellings; null clears", () => {
    expect(parseStage({ phase: "yourTurn", stepsDone: 1, stepsTotal: 5, title: "Setting up Relo" })).toEqual(stage({ phase: "yourTurn", stepsDone: 1, stepsTotal: 5 }))
    expect(parseStage({ stage: { phase: "your_turn", done: 2, total: 5 } })).toMatchObject({ phase: "yourTurn", stepsDone: 2, stepsTotal: 5, title: "Setting up Relo" })
    expect(parseStage({ phase: "failed", stepsDone: 9, stepsTotal: 4, status: "No agent" })).toMatchObject({ stepsDone: 4, status: "No agent" })
    expect(parseStage({ phase: "working", stepsDone: 0, stepsTotal: 3, title: "Setting up Relo", status: null, startedAt: 1234 })?.startedAt).toBe(1234)
    expect(parseStage({ phase: "clear", stepsDone: 0, stepsTotal: 0, title: "Setting up Relo", status: null, startedAt: 0 })).toBeNull()
    expect(parseStage(null)).toBeNull()
    expect(parseStage({ cleared: true })).toBeNull()
    expect(parseStage({ phase: "nonsense" })).toBeNull()
  })

  it("a working stage is one running card with a plan; a choice is Your turn; failed and done are recent", () => {
    const working = onboardingPresentation(stage({ stepsDone: 1 }), 1000)
    expect(working.sections.map((s) => s.kind)).toEqual(["running"])
    expect(working.focus).toMatchObject({ id: ONBOARDING_ROW_ID, tone: "working", stepsDone: 1, stepsTotal: 4, currentIndex: 2, unreadable: false, notificationId: null })
    expect(working.activeCount).toBe(1)
    expect(rowBar(working.focus!)).not.toBeNull()
    const turn = onboardingPresentation(stage({ phase: "yourTurn" }), 1000)
    expect(turn.sections.map((s) => s.kind)).toEqual(["waitingOnYou"])
    expect(turn.focus?.tone).toBe("yourTurn")
    const failed = onboardingPresentation(stage({ phase: "failed", status: "Could not start" }), 1000)
    expect(failed.sections.map((s) => s.kind)).toEqual(["recent"])
    expect(failed.focus).toMatchObject({ tone: "failed", status: "Could not start" })
    expect(failed.activeCount).toBe(0)
    const done = onboardingPresentation(stage({ phase: "done", stepsDone: 2, title: "Ready to use with Claude Code" }), 1000)
    expect(done.focus).toMatchObject({ tone: "done", stepsDone: 4, title: "Ready to use with Claude Code", currentIndex: null })
  })

  it("each transition is a moment the notch plays: started, your turn, finished, failed", () => {
    const start = onboardingPresentation(stage(), 1000)
    const turn = onboardingPresentation(stage({ phase: "yourTurn", stepsDone: 1 }), 1000)
    const done = onboardingPresentation(stage({ phase: "done" }), 1000)
    const failed = onboardingPresentation(stage({ phase: "failed", status: "x" }), 1000)
    expect(eventsBetween(EMPTY, start).map((e) => e.kind)).toContain("started")
    expect(eventsBetween(start, turn).map((e) => e.kind)).toContain("yourTurn")
    expect(eventsBetween(turn, done).map((e) => e.kind)).toContain("finished")
    expect(eventsBetween(turn, failed).map((e) => e.kind)).toContain("failed")
  })
})
