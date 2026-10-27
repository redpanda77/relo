import type { OwnerNotice } from "@relo/owner-client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { EventKind, NotchEvent } from "../../events"
import { EMPTY, type Presentation, type Row } from "../../presentation"
import { momentLead, peekDuration } from "../../visual/moments"
import { MAX_QUEUE, NEXT_GAP_MS, NOTICE_MS, PeekController, type PeekEnv } from "./controller"
import { cardDetail, cardShowsBar, detailLines, isPill, openKindOf, pillBadge, pillBar, pillLine } from "./logic"

function row(id: string, extra: Partial<Row> = {}): Row {
  return {
    id, title: id, status: null, project: null, source: null, tone: "working", stepsDone: null, stepsTotal: null, currentStep: null,
    startedAt: 0, questionId: null, notificationId: null, questionPending: false, unreadable: false, questionMissed: false,
    computerIcon: null, declaredAt: 0, roundOutcome: null, outline: null, currentIndex: null, currentFill: null, ...extra,
  }
}
const event = (kind: EventKind, id = "a", extra: Partial<Row> = {}): NotchEvent => ({ kind, row: row(id, extra) })
const present = (...rows: Row[]): Presentation => ({ ...EMPTY, sections: [{ kind: "running", rows }] })
const notice = (id: string): OwnerNotice => ({ id, title: `Notice ${id}`, summary: null, source: "script", createdAt: "2026-10-24T10:00:00.000Z", read: false })

function make(over: Partial<PeekEnv> = {}) {
  const flags = { quiet: false, enabled: true, reduceMotion: false, cursor: false }
  const ctl = new PeekController({
    quiet: () => flags.quiet, enabled: () => flags.enabled, reduceMotion: () => flags.reduceMotion, cursorOver: () => flags.cursor,
    now: () => Date.now(), ...over,
  })
  return { ctl, flags }
}
const ms = (seconds: number) => seconds * 1000

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("the update's card (ReloClosedActivity.show / collapse)", () => {
  it("waits for the wings' moment, opens, holds for its time, then collapses", () => {
    const { ctl } = make()
    const e = event("question")
    ctl.receive([e])
    expect(ctl.getSnapshot().expanded).toBeNull()
    vi.advanceTimersByTime(ms(momentLead("question")) - 1)
    expect(ctl.getSnapshot().expanded).toBeNull()
    vi.advanceTimersByTime(1)
    expect(ctl.getSnapshot().expanded?.event).toBe(e)
    vi.advanceTimersByTime(ms(peekDuration("question")) - 1)
    expect(ctl.getSnapshot().expanded).not.toBeNull()
    vi.advanceTimersByTime(1)
    expect(ctl.getSnapshot().expanded).toBeNull()
  })

  it.each<[EventKind, number, number]>([
    ["question", 1.75, 8],
    ["failed", 2.05, 6],
    ["yourTurn", 2.25, 5],
    ["finished", 2.35, 3.5],
    ["started", 1.75, 3],
    ["progressed", 1.35, 3],
  ])("%s: lead %ss, hold %ss", (kind, lead, hold) => {
    const { ctl } = make()
    ctl.receive([event(kind)])
    vi.advanceTimersByTime(ms(lead))
    expect(ctl.getSnapshot().expanded?.event.kind).toBe(kind)
    vi.advanceTimersByTime(ms(hold))
    expect(ctl.getSnapshot().expanded).toBeNull()
  })

  it("opens at once with Reduce Motion (no moment to wait for)", () => {
    const { ctl, flags } = make()
    flags.reduceMotion = true
    ctl.receive([event("question")])
    expect(ctl.getSnapshot().expanded).not.toBeNull()
  })

  it("hovering the card keeps it (polled every 300 ms) and it leaves once the pointer does", () => {
    const { ctl, flags } = make()
    ctl.receive([event("finished")])
    vi.advanceTimersByTime(ms(momentLead("finished")))
    flags.cursor = true
    vi.advanceTimersByTime(ms(peekDuration("finished")) + 3000)
    expect(ctl.getSnapshot().expanded).not.toBeNull()
    flags.cursor = false
    vi.advanceTimersByTime(300)
    expect(ctl.getSnapshot().expanded).toBeNull()
  })

  it("shows nothing while quiet (paused, full screen) or with peeks off", () => {
    const { ctl, flags } = make()
    flags.quiet = true
    ctl.receive([event("question")])
    vi.advanceTimersByTime(ms(20))
    expect(ctl.getSnapshot().expanded).toBeNull()
    flags.quiet = false
    flags.enabled = false
    ctl.receive([event("question", "b")])
    vi.advanceTimersByTime(ms(20))
    expect(ctl.getSnapshot().expanded).toBeNull()
  })

  it("a more important update replaces the shown one; a less important one waits, and 450 ms after it leaves comes next", () => {
    const { ctl } = make()
    ctl.receive([event("started", "a")])
    vi.advanceTimersByTime(ms(momentLead("started")))
    expect(ctl.getSnapshot().expanded?.event.row.id).toBe("a")
    ctl.receive([event("question", "b")])
    vi.advanceTimersByTime(ms(momentLead("question")))
    expect(ctl.getSnapshot().expanded?.event.row.id).toBe("b")
    // The replaced start waits in the queue? No: a replacement drops nothing but the same row; "a" was shown, not queued.
    ctl.receive([event("progressed", "c")])
    expect(ctl.getSnapshot().expanded?.event.row.id).toBe("b")
    vi.advanceTimersByTime(ms(peekDuration("question")))
    expect(ctl.getSnapshot().expanded).toBeNull()
    vi.advanceTimersByTime(NEXT_GAP_MS - 1)
    expect(ctl.getSnapshot().expanded).toBeNull()
    vi.advanceTimersByTime(1) // the next show waits for its own lead only when the wings played that row's moment
    vi.advanceTimersByTime(ms(momentLead("progressed")))
    expect(ctl.getSnapshot().expanded?.event.row.id).toBe("c")
  })

  it("queues at most four, one per card", () => {
    const { ctl, flags } = make()
    flags.reduceMotion = true
    ctl.receive([event("started", "a")])
    ctl.receive(Array.from({ length: 8 }, (_, i) => event("progressed", `r${i}`)))
    let shown = 0
    for (let i = 0; i < 12 && ctl.getSnapshot().expanded; i++) {
      shown += 1
      vi.advanceTimersByTime(ms(peekDuration("progressed")) + NEXT_GAP_MS)
    }
    expect(shown).toBe(1 + MAX_QUEUE)
  })

  it("closes when the card leaves Now (answered, dismissed)", () => {
    const { ctl, flags } = make()
    flags.reduceMotion = true
    ctl.receive([event("question", "a")])
    expect(ctl.getSnapshot().expanded).not.toBeNull()
    ctl.closeIfGone(present(row("a")))
    expect(ctl.getSnapshot().expanded).not.toBeNull()
    ctl.closeIfGone(present(row("other")))
    expect(ctl.getSnapshot().expanded).toBeNull()
  })
})

describe("notices (ReloNoticePill)", () => {
  it("shows one for 4.5 s, then the next 450 ms later; keeps the last three", () => {
    const { ctl } = make()
    ctl.receiveNotices([notice("1"), notice("2"), notice("3"), notice("4")])
    expect(ctl.getSnapshot().notice?.notice.id).toBe("2")
    vi.advanceTimersByTime(NOTICE_MS - 1)
    expect(ctl.getSnapshot().notice?.notice.id).toBe("2")
    vi.advanceTimersByTime(1)
    expect(ctl.getSnapshot().notice).toBeNull()
    vi.advanceTimersByTime(NEXT_GAP_MS)
    expect(ctl.getSnapshot().notice?.notice.id).toBe("3")
    vi.advanceTimersByTime(NOTICE_MS + NEXT_GAP_MS)
    expect(ctl.getSnapshot().notice?.notice.id).toBe("4")
  })

  it("hovering keeps it; quiet or peeks off show none", () => {
    const { ctl, flags } = make()
    ctl.receiveNotices([notice("1")])
    flags.cursor = true
    vi.advanceTimersByTime(NOTICE_MS + 2000)
    expect(ctl.getSnapshot().notice).not.toBeNull()
    flags.cursor = false
    vi.advanceTimersByTime(300)
    expect(ctl.getSnapshot().notice).toBeNull()
    flags.quiet = true
    ctl.receiveNotices([notice("2")])
    expect(ctl.getSnapshot().notice).toBeNull()
  })

  it("an update outranks a notice: the notice goes, the card comes", () => {
    const { ctl, flags } = make()
    flags.reduceMotion = true
    ctl.receiveNotices([notice("1")])
    expect(ctl.getSnapshot().notice).not.toBeNull()
    ctl.receive([event("question")])
    expect(ctl.getSnapshot().notice).toBeNull()
    expect(ctl.getSnapshot().expanded).not.toBeNull()
  })

  it("never shows over an update that is up", () => {
    const { ctl, flags } = make()
    flags.reduceMotion = true
    ctl.receive([event("question")])
    ctl.receiveNotices([notice("1")])
    expect(ctl.getSnapshot().notice).toBeNull()
    vi.advanceTimersByTime(ms(peekDuration("question")) + NEXT_GAP_MS)
    expect(ctl.getSnapshot().notice?.notice.id).toBe("1")
  })
})

describe("what the card says (logic)", () => {
  it("maps updates to their look", () => {
    expect(openKindOf(event("question"), row("a"))).toBe("needs")
    expect(openKindOf(event("yourTurn"), row("a"))).toBe("turn")
    expect(openKindOf(event("progressed"), row("a"))).toBe("running")
    expect(openKindOf(event("progressed"), row("a", { questionPending: true }))).toBe("needs")
    expect(isPill(event("finished"))).toBe(true)
    expect(isPill(event("started"))).toBe(true)
    expect(isPill(event("question"))).toBe(false)
  })

  it("a start says where it begins, a finish what it delivered", () => {
    const started = event("started", "a", { currentStep: "Run the tests", stepsDone: 1, stepsTotal: 4, status: "Working" })
    expect(pillLine(started, started.row)).toBe("Step 2 of 4 · Run the tests")
    const stepless = event("started", "a", { status: "Working" })
    expect(pillLine(stepless, stepless.row)).toBe("Working")
    const finished = event("finished", "a", { roundOutcome: "Fixed and tested", status: "Done" })
    expect(pillLine(finished, finished.row)).toBe("Fixed and tested")
    expect(pillBadge("started", "Running")).toBe("Started")
    expect(pillBadge("done", "Done")).toBe("Done")
    expect(pillBar("done", row("a"))).toEqual([{ state: "done", fill: 1 }])
  })

  it("the card's line and bar", () => {
    const asking = row("a", { questionPending: true, status: "Waiting" })
    expect(cardDetail(asking, { kind: "approval", prompt: "Run rm -rf build?" }, "Needs you")).toBe("Run rm -rf build?")
    expect(cardDetail(asking, undefined, "Needs you")).toBe("Waiting")
    expect(cardDetail(row("a", { unreadable: true }), undefined, "Running")).toBe("Waiting for approval on your iPhone")
    expect(detailLines("needs", asking)).toBe(2)
    expect(detailLines("running", row("a"))).toBe(1)
    const planned = row("a", { stepsDone: 1, stepsTotal: 3 })
    expect(cardShowsBar("running", planned)).toBe(true)
    expect(cardShowsBar("running", { ...planned, stepsDone: 3 })).toBe(false)
    expect(cardShowsBar("needs", planned)).toBe(false)
  })
})
