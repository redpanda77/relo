import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { NotchEvent } from "../events"
import { EMPTY, type Presentation, type Row, type Section, type SectionKind, type Tone } from "../presentation"
import { isPlaying, momentDuration, momentLead, MomentController, peekDuration } from "./moments"

function row(id: string, tone: Tone, extra: Partial<Row> = {}): Row {
  return {
    id,
    title: id,
    status: null,
    project: null,
    source: null,
    tone,
    stepsDone: null,
    stepsTotal: null,
    currentStep: null,
    startedAt: 0,
    questionId: null,
    notificationId: null,
    questionPending: false,
    unreadable: false,
    questionMissed: false,
    computerIcon: null,
    declaredAt: 0,
    roundOutcome: null,
    outline: null,
    currentIndex: null,
    currentFill: null,
    ...extra,
  }
}

function present(kind: SectionKind, rows: Row[]): Presentation {
  const sections: Section[] = [{ kind, rows }]
  return { ...EMPTY, sections, focus: rows[0] ?? null, activeCount: rows.length }
}

describe("moment tables (ReloOrbitWings.swift / ReloClosedActivity.swift)", () => {
  it("plays each moment for the Swift duration", () => {
    expect(momentDuration("started")).toBe(2.6)
    expect(momentDuration("step")).toBe(2.6)
    expect(momentDuration("needs")).toBe(2.2)
    expect(momentDuration("turn")).toBe(5.2)
    expect(momentDuration("done")).toBe(5.2)
    expect(momentDuration("failed")).toBe(5.2)
  })
  it("leads the card by the Swift lead and keeps it by the Swift duration", () => {
    expect([momentLead("question"), momentLead("yourTurn"), momentLead("failed"), momentLead("finished"), momentLead("progressed"), momentLead("started")]).toEqual([1.75, 2.25, 2.05, 2.35, 1.35, 1.75])
    expect([peekDuration("question"), peekDuration("failed"), peekDuration("yourTurn"), peekDuration("finished"), peekDuration("started"), peekDuration("progressed")]).toEqual([8, 6, 5, 3.5, 3, 3])
  })
  it("isPlaying honours reduce motion", () => {
    const m = { kind: "needs" as const, rowID: "a", bar: null, at: 1000 }
    expect(isPlaying(m, 1000 + 2199)).toBe(true)
    expect(isPlaying(m, 1000 + 2200)).toBe(false)
    expect(isPlaying(m, 1500, true)).toBe(false)
  })
})

describe("MomentController", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-10-14T10:00:00Z"))
  })
  afterEach(() => vi.useRealTimers())

  it("plays a question's moment for 2.2 s, publishes when it ends, and does not mark the baseline unseen", () => {
    const c = new MomentController()
    const seen = vi.fn()
    c.subscribe(seen)
    c.ingest(present("needsYou", [row("a", "needsYou", { questionPending: true, questionId: "q1" })]))
    expect(c.active()?.kind).toBe("needs")
    expect(c.unseen).toBe(false)
    expect(seen).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2199)
    expect(c.active()?.kind).toBe("needs")
    vi.advanceTimersByTime(30)
    expect(c.active()).toBeNull()
    expect(seen).toHaveBeenCalledTimes(2)
    expect(c.getSnapshot().moment).toBeNull()
  })

  it("plays each moment once: the same question again is not re-announced", () => {
    const c = new MomentController()
    const p = present("needsYou", [row("a", "needsYou", { questionPending: true, questionId: "q1" })])
    c.ingest(p)
    vi.advanceTimersByTime(3000)
    c.ingest({ ...p })
    expect(c.active()).toBeNull()
  })

  it("a new update after the baseline is unseen until marked seen; a finish plays 5.2 s", () => {
    const c = new MomentController()
    c.ingest(present("running", [row("a", "working", { stepsDone: 1, stepsTotal: 3 })]))
    vi.advanceTimersByTime(100)
    c.ingest(present("recent", [row("a", "done", { stepsDone: 3, stepsTotal: 3 })]))
    expect(c.active()?.kind).toBe("done")
    expect(c.unseen).toBe(true)
    c.markSeen()
    expect(c.unseen).toBe(false)
    vi.advanceTimersByTime(5199)
    expect(c.active()?.kind).toBe("done")
    vi.advanceTimersByTime(30)
    expect(c.active()).toBeNull()
  })

  it("a finished plan step plays the step moment, but never over another moment", () => {
    const c = new MomentController()
    c.ingest(present("running", [row("a", "working", { stepsDone: 1, stepsTotal: 3 })]))
    vi.advanceTimersByTime(100)
    c.ingest(present("running", [row("a", "working", { stepsDone: 2, stepsTotal: 3 })]))
    expect(c.active()?.kind).toBe("step")
    const first = c.active()
    vi.advanceTimersByTime(1000)
    c.ingest(present("running", [row("a", "working", { stepsDone: 3, stepsTotal: 3 })]))
    expect(c.active()).toBe(first)
    vi.advanceTimersByTime(1700)
    expect(c.active()).toBeNull()
  })

  it("quiet (alerts paused) plays nothing but still counts the update as unseen", () => {
    const c = new MomentController({ quiet: () => true })
    c.ingest(present("running", [row("a", "working")]))
    vi.advanceTimersByTime(10)
    c.ingest(present("recent", [row("a", "failed")]))
    expect(c.active()).toBeNull()
    expect(c.unseen).toBe(true)
  })

  it("hands the events of each batch, most important first, to the peek card", () => {
    const c = new MomentController()
    const got: NotchEvent[][] = []
    c.onEvents((e) => got.push(e))
    c.ingest(present("running", [row("a", "working"), row("b", "working")]))
    c.ingest(present("running", [row("a", "failed"), row("b", "done")]))
    expect(got.at(-1)?.map((e) => e.kind)).toEqual(["failed", "finished"])
    expect(c.active()?.kind).toBe("failed")
  })
})

describe("notices and the staged onboarding (ReloMoments)", () => {
  it("a notice makes the mark unseen until it is marked seen", () => {
    const c = new MomentController({ now: () => 0 })
    expect(c.unseen).toBe(false)
    c.noticed()
    expect(c.unseen).toBe(true)
    expect(c.getSnapshot().unseen).toBe(true)
    c.markSeen()
    expect(c.unseen).toBe(false)
  })
  it("rebase makes the next presentation the baseline: no moment for the swap back from the staged work", () => {
    const c = new MomentController({ now: () => 0 })
    c.ingest(present("running", [row("onboarding", "working")]))
    const server = present("recent", [row("a", "done")])
    c.rebase(server)
    expect(c.ingest(server)).toEqual([])
  })
  it("quiet: an update earns no moment but is still unseen", () => {
    const c = new MomentController({ now: () => 0, quiet: () => true })
    c.ingest(EMPTY)
    c.ingest(present("recent", [row("a", "failed")]))
    expect(c.active()).toBeNull()
    expect(c.unseen).toBe(true)
  })
})
