import { describe, expect, it } from "vitest"
import { initialLocal } from "../../local/setup"
import { staggerDelay } from "./motion"
import { clearPayload, readyLine, samePayload, stagePayload, stepsTotal } from "./notchStage"
import { initialProgress, type Progress } from "./stages"

const at = (over: Partial<Progress>): Progress => ({ ...initialProgress(), ...over })

describe("the onboarding staged in the notch (O02)", () => {
  it("has nothing to show at Hello", () => {
    expect(stagePayload(initialProgress(), 1)).toBeNull()
  })

  it("plans one step per screen between Hello and Ready", () => {
    expect(stepsTotal({ place: "local" })).toBe(3)
    expect(stepsTotal({ place: "server" })).toBe(5)
  })

  it("is Your turn on a choice screen, counting the screens behind it", () => {
    expect(stagePayload(at({ stage: "sound" }), 5)).toMatchObject({ phase: "yourTurn", stepsDone: 0, stepsTotal: 3, title: "Setting up Relo", startedAt: 5 })
    expect(stagePayload(at({ stage: "where" }), 5)).toMatchObject({ phase: "yourTurn", stepsDone: 1 })
  })

  it("works while the server sign-in waits and while the local steps run", () => {
    expect(stagePayload(at({ stage: "server", place: "server", signIn: "waiting" }), 1)).toMatchObject({ phase: "working", stepsDone: 2 })
    expect(stagePayload(at({ stage: "server", place: "server" }), 1)).toMatchObject({ phase: "yourTurn" })
    expect(stagePayload(at({ stage: "local", local: { ...initialLocal(), running: true } }), 1)).toMatchObject({ phase: "working", stepsDone: 2 })
  })

  it("fails with the words of the failure", () => {
    const local = at({ stage: "local", local: { ...initialLocal(), failure: "Relo could not start." } })
    expect(stagePayload(local, 1)).toMatchObject({ phase: "failed", status: "Relo could not start." })
    const setup = at({ stage: "setup", place: "server", rows: [{ id: "a", name: "Codex", status: "failed", message: "No write access." }] })
    expect(stagePayload(setup, 1)).toMatchObject({ phase: "failed", status: "No write access." })
  })

  it("is Done at Ready, titled with what is ready", () => {
    const rows = [
      { id: "a", name: "Claude Code", status: "done" as const },
      { id: "b", name: "Codex", status: "done" as const },
      { id: "c", name: "Cursor", status: "skipped" as const },
    ]
    expect(stagePayload(at({ stage: "ready", place: "server", rows }), 1)).toMatchObject({ phase: "done", stepsDone: 5, stepsTotal: 5, title: "Ready to use with Claude Code and Codex" })
    expect(stagePayload(at({ stage: "ready" }), 1)?.title).toBe("Relo is ready")
  })

  it("names one, two and three agents the Mac's way", () => {
    const row = (name: string) => ({ id: name, name, status: "done" as const })
    expect(readyLine({ rows: [row("A")] })).toBe("Ready to use with A")
    expect(readyLine({ rows: [row("A"), row("B"), row("C")] })).toBe("Ready to use with A, B and C")
    // The relo command is plumbing, not an agent.
    expect(readyLine({ rows: [{ id: "relo", name: "The relo command", status: "done" }, row("A")] })).toBe("Ready to use with A")
    expect(readyLine({ rows: [{ id: "relo", name: "The relo command", status: "done" }] })).toBe("Relo is ready")
  })

  it("re-sends only real changes", () => {
    const a = stagePayload(at({ stage: "sound" }), 1)
    expect(samePayload(a, stagePayload(at({ stage: "sound" }), 99))).toBe(true)
    expect(samePayload(a, stagePayload(at({ stage: "where" }), 1))).toBe(false)
    expect(samePayload(null, null)).toBe(true)
    expect(samePayload(a, null)).toBe(false)
    expect(clearPayload().phase).toBe("clear")
  })
})

describe("the page turn's cascade", () => {
  it("staggers 80 ms apart, capped at six elements", () => {
    expect([0, 1, 2, 5, 6, 9].map(staggerDelay)).toEqual([0, 80, 160, 400, 400, 400])
  })
})
