// Ports apps/notch/ReloNotchKit/Tests/ReloNotchKitTests/NotchPresentationTests.swift: the notch shows the server's
// derivation. These pin that it reads the shared contract fixture (owner-state-v1.json, mirrored in apps/ios)
// without deciding anything.

import { fixtureSummary } from "./testing"
import { describe, expect, it } from "vitest"
import { rowBar, rowPlanLine, rowProgress, EMPTY, isEmpty, isMoving, isQuiet, isStopped, machinesOf, presentationOf, SEALED, toneOf, tallyOf, workingSessionsWithoutCards, type Presentation, type Tone } from "./presentation"
import { currentLeaf, itemsIn, makeOutline, roundHeading, startsFolded } from "./plan"
import { loadSnapshot, SNAPSHOT_NAMES } from "./fixtures"

const kinds = (p: Presentation) => p.sections.map((s) => s.kind)

describe("NotchPresentation", () => {
  it("focus is the server's Lock Screen focus", () => {
    const p = presentationOf(fixtureSummary())
    expect(p.focus?.id).toBe("act_00000000-0000-4000-8000-000000000001")
    expect(p.focus?.tone).toBe("needsYou")
    expect(p.focus?.title).toBe("Ship the release")
    expect(p.needsYouCount).toBe(1)
  })

  it("focus falls back to the first Lock Screen card and otherwise stays empty", () => {
    const now = fixtureSummary()
    now.lockScreen.focus = null
    expect(presentationOf(now).focus?.id).toBe(now.lockScreen.cards[0])
    now.lockScreen.cards = []
    expect(presentationOf(now).focus).toBeNull()
  })

  it("sections follow the server's Now sections and skip empty ones", () => {
    const p = presentationOf(fixtureSummary())
    expect(kinds(p)).toEqual(["needsYou", "waitingOnYou", "running", "recent", "quiet"])
    expect(p.activeCount).toBe(3)
    const running = p.sections.find((s) => s.kind === "running")!.rows[0]!
    expect(Math.abs(rowProgress(running)! - 1 / 3)).toBeLessThan(0.001)
    expect(running.currentStep).toBe("Run local gates")
    expect(p.sections.find((s) => s.kind === "recent")!.rows.map((r) => r.tone)).toEqual(["failed", "done"])
  })

  // The Mac draws the plan as the iPhone's detail does: rounds, nested steps and each step's own state from the
  // server, never a flat list ticked by a top-level count.
  it("the opened plan is the iPhone's outline of rounds and nested steps", () => {
    const now = fixtureSummary()
    const id = now.running[0]!.id
    now.running[0]!.plan = [
      { id: "s1", state: "done", label: "Propose the frame", round: 1 },
      { id: "s2", state: "open", label: "Implement", round: 2 },
      { id: "s3", state: "done", label: "Shared examples", parent: "s2", round: 2 },
      { id: "s4", state: "current", label: "Mac speech queue", parent: "s2", round: 2 },
      { id: "s5", state: "open", label: "Test and ship", round: 2 },
    ]
    now.running[0]!.rounds = [
      { n: 1, state: "closed", title: "Propose", outcome: "Draft ADR committed" },
      { n: 2, state: "open", title: "Build" },
    ]
    const row = presentationOf(now).sections.flatMap((s) => s.rows).find((r) => r.id === id)!
    const outline = row.outline!
    expect(outline.rounds.map(roundHeading)).toEqual(["Round 1 · Propose", "Round 2 · Build"])
    expect(outline.rounds[0]!.outcome).toBe("Draft ADR committed")
    expect(startsFolded(outline, outline.rounds[0]!)).toBe(true)
    const first = itemsIn(outline.rounds[1]!)[0]!
    if (first.kind !== "branch") throw new Error("no step")
    expect(first.node.state).toBe("current")
    expect(first.opened).toBe(true)
    expect(first.count).toEqual({ done: 1, total: 2 })
    expect(currentLeaf(outline)?.label).toBe("Mac speech queue")
    // A work without a plan has no outline.
    const plain = presentationOf(fixtureSummary()).sections.flatMap((s) => s.rows).find((r) => r.id === id)!
    expect(plain.outline).toBeNull()
    expect(makeOutline(undefined, undefined)).toBeNull()
  })

  it("moving work waiting on its own job reads Running", () => {
    expect(toneOf(fixtureSummary().running[0]!.owner.state)).toBe("working")
  })

  it("the badge vocabulary is one tone per state", () => {
    const tones: Tone[] = ["working", "needsYou", "yourTurn", "paused", "quiet", "done", "failed", "dropped", "leftUnfinished"]
    expect(new Set(tones).size).toBe(tones.length)
    expect(tones.filter(isMoving)).toEqual(["working"])
    expect(tones.filter(isStopped)).toEqual(["failed", "dropped", "leftUnfinished"])
  })

  it("the plan line follows rule U2", () => {
    const row = structuredClone(presentationOf(fixtureSummary()).sections.find((s) => s.kind === "running")!.rows[0]!)
    row.stepsDone = 2
    row.stepsTotal = 5
    row.currentStep = "Run the gates"
    row.tone = "working"
    expect(rowPlanLine(row)).toBe("Step 3 of 5 · Run the gates")
    row.tone = "paused"
    expect(rowPlanLine(row)).toBe("Paused at 2 of 5")
    row.tone = "failed"
    expect(rowPlanLine(row)).toBe("Stopped at 2 of 5")
    row.tone = "dropped"
    expect(rowPlanLine(row)).toBe("Stopped at 2 of 5")
    row.tone = "done"
    row.stepsDone = 5
    expect(rowPlanLine(row)).toBe("5 of 5 done")
    row.stepsTotal = 0
    expect(rowPlanLine(row)).toBeNull()
  })

  it("sealed placeholders read as private work and flag approval", () => {
    const now = fixtureSummary()
    now.running[0]!.title = SEALED.titlePlaceholder
    now.running[0]!.status = SEALED.statusPlaceholder
    const p = presentationOf(now)
    const row = p.sections.find((s) => s.kind === "running")!.rows[0]!
    expect(row.unreadable).toBe(true)
    expect(row.title).toBe("Private work")
    expect(row.status).toBeNull()
    expect(p.hasUnreadable).toBe(true)
  })

  it("quiet and paused work is folded after everything that moves", () => {
    const p = presentationOf(fixtureSummary())
    expect(p.sections.at(-1)?.kind).toBe("quiet")
    expect(isQuiet(p)).toBe(false)
    const quietOnly = fixtureSummary()
    quietOnly.needsYou = []
    quietOnly.waitingOnYou = []
    quietOnly.running = []
    quietOnly.recent = []
    expect(isQuiet(presentationOf(quietOnly))).toBe(true)
  })

  it("since you looked recaps the server's counts in order of what matters", () => {
    expect(presentationOf(fixtureSummary()).sinceYouLooked).toBe("1 needs you · 1 failed · 1 finished · 1 your turn")
    const now = fixtureSummary()
    now.sinceYouLooked = { ...now.sinceYouLooked, finished: 0, failed: 0, waitingOnYou: 0, needsYou: 0, stoppedWithoutFinishing: 0 }
    expect(presentationOf(now).sinceYouLooked).toBeNull()
  })

  it("the tally counts what the list shows in order of what matters", () => {
    const p = presentationOf(fixtureSummary())
    const tally = tallyOf(p)
    expect(tally.slice(0, 5).map((e) => e.kind)).toEqual(["needsYou", "yourTurn", "running", "failed", "finished"])
    expect(tally.slice(0, 5).map((e) => e.count)).toEqual([1, 1, 1, 1, 1])
    expect(tally.every((e) => e.count > 0)).toBe(true)
    // Every listed row is counted once (sessions are counted apart).
    expect(tally.filter((e) => e.kind !== "sessions").reduce((n, e) => n + e.count, 0)).toBe(p.sections.reduce((n, s) => n + s.rows.length, 0))
    // A working session that holds a card is counted by its card, not again as a session.
    expect(tally.find((e) => e.kind === "sessions")?.count ?? 0).toBe(workingSessionsWithoutCards(p))
    const both: Presentation = {
      ...p,
      sessions: [
        { id: "s1", title: "A", source: null, project: null, phase: "working", waitingFor: null, computer: null, computerIcon: null, lastSeenAt: 0, hasCard: true },
        { id: "s2", title: "B", source: null, project: null, phase: "working", waitingFor: null, computer: null, computerIcon: null, lastSeenAt: 0, hasCard: false },
      ],
    }
    expect(tallyOf(both).find((e) => e.kind === "sessions")?.count).toBe(1)
    expect(tallyOf(EMPTY)).toEqual([])
  })

  it("finished work sealed before this device is counted, not listed", () => {
    const now = fixtureSummary()
    now.recent[0]!.title = SEALED.unreadableTitle
    const p = presentationOf(now)
    expect(p.privateEarlier).toBe(1)
    expect(p.sections.find((s) => s.kind === "recent")!.rows.length).toBe(1)
    now.running[0]!.title = SEALED.unreadableTitle
    expect(presentationOf(now).sections.find((s) => s.kind === "running")!.rows[0]!.unreadable).toBe(true)
  })

  it("machines group live sessions by computer then harness", () => {
    const p = presentationOf(fixtureSummary())
    const sessions = p.sessions.filter((s) => s.phase !== "ended")
    const machines = machinesOf(p)
    expect(machines.reduce((n, m) => n + m.harnesses.reduce((k, h) => k + h.total, 0), 0)).toBe(sessions.length)
    expect(new Set(machines.map((m) => m.name)).size).toBe(machines.length)
  })

  it("unknown is not idle", () => {
    const base = presentationOf(fixtureSummary())
    const session = (id: string, source: string, phase: "idle" | null, computer: string) => ({
      id, title: id, source, project: null, phase, waitingFor: null, computer, computerIcon: null, lastSeenAt: 0, hasCard: false,
    })
    const p: Presentation = { ...base, sessions: [session("a", "claude-code", null, "Mac"), session("b", "claude-code", "idle", "Mac"), session("c", "codex", null, "Mac2")] }
    const machines = machinesOf(p)
    const mac = machines.find((m) => m.name === "Mac")!
    const harness = mac.harnesses[0]!
    expect(harness.idle).toBe(1)
    expect(harness.untracked).toBe(1)
    expect(harness.total).toBe(2)
    expect(mac.isIdle).toBe(false)
    const only = machines.find((m) => m.name === "Mac2")!
    expect(only.idle).toBe(0)
    expect(only.untracked).toBe(1)
    expect(only.isIdle).toBe(false)
    expect(machinesOf({ ...p, sessions: [p.sessions[1]!] })[0]?.isIdle).toBe(true)
  })

  it("no summary is empty", () => {
    expect(presentationOf(null)).toEqual(EMPTY)
    expect(isEmpty(EMPTY)).toBe(true)
  })

  // Beyond the Mac's cases: the plan bar the views draw and the snapshot fixtures.
  it("the plan bar lays out the server's counts", () => {
    const row = structuredClone(presentationOf(fixtureSummary()).sections.find((s) => s.kind === "running")!.rows[0]!)
    row.stepsDone = 1
    row.stepsTotal = 3
    row.currentIndex = 2
    row.currentFill = 0.5
    expect(rowBar(row)).toEqual([
      { state: "done", fill: 1 },
      { state: "current", fill: 0.5 },
      { state: "open", fill: 0 },
    ])
    row.stepsTotal = null
    expect(rowBar(row)).toBeNull()
  })

  it("every snapshot fixture parses against the contract and builds a presentation", () => {
    for (const name of SNAPSHOT_NAMES) {
      const snapshot = loadSnapshot(name)
      expect(snapshot, name).not.toBeNull()
      presentationOf(snapshot!.summary)
    }
    expect(isEmpty(presentationOf(loadSnapshot("empty")!.summary))).toBe(true)
    expect(presentationOf(loadSnapshot("question")!.summary).sections.find((s) => s.kind === "needsYou")!.rows.every((r) => r.questionPending)).toBe(true)
    expect(presentationOf(loadSnapshot("failed")!.summary).focus?.tone).toBe("failed")
    expect(loadSnapshot("nope")).toBeNull()
  })
})
