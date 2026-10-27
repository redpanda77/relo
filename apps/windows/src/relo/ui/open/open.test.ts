import { describe, expect, it } from "vitest"
import { presentationOf, type Row } from "../../presentation"
import { fixtureSummary } from "../../testing"
import { makeOutline } from "../../plan"
import { ago, answerView, cap, cardFacts, foldCounts, liveCards, readableName, SUMMARY_VARIANTS, summaryShown } from "./logic"
import { marqueeMotion } from "./Marquee"
import { unskipped } from "./PlanDeck"
import { mayOpenOnHover, TimedFlag, type Timers } from "./sneak"
import { SPRINGS } from "./tokens"

const rows = (): Row[] => presentationOf(fixtureSummary()).sections.flatMap((s) => s.rows)

describe("fold and caps", () => {
  it("caps sections as the Mac does", () => {
    expect([cap("needsYou") > 1e9, cap("waitingOnYou"), cap("running"), cap("recent"), cap("quiet"), cap("paused")]).toEqual([true, 3, 4, 3, 3, 3])
  })
  it("lists live cards, needs-you as hero", () => {
    const p = presentationOf(fixtureSummary())
    const live = liveCards(p)
    expect(live.cards.every((c) => c.hero === (c.row.tone === "needsYou"))).toBe(true)
  })
  it("words the quiet line and its age", () => {
    const p = presentationOf(fixtureSummary())
    const sections = [{ kind: "quiet" as const, rows: rows().slice(0, 3) }, { kind: "paused" as const, rows: rows().slice(0, 1) }]
    expect(foldCounts(sections)).toBe("3 quiet · 1 paused")
    expect(p).toBeTruthy()
    const now = Date.now()
    expect([ago(now, now), ago(now - 18 * 60_000, now), ago(now - 2 * 3600_000, now), ago(now - 3 * 86400_000, now)]).toEqual(["just now", "18 min ago", "2 h ago", "3 d ago"])
  })
})

describe("summary variants", () => {
  const tally = [1, 2, 3, 4, 5, 6].map((n) => ({ kind: `k${n}`, tone: "working", count: n, label: "x" })) as never
  it("shrinks from words to a short list with a +n", () => {
    expect(SUMMARY_VARIANTS.map((v) => v.words)).toEqual(["all", "urgent", "none", "none", "none"])
    const last = summaryShown(tally, SUMMARY_VARIANTS[4]!)
    expect(last.shown).toHaveLength(2)
    expect(last.rest).toBe(3 + 4 + 5 + 6)
    expect(summaryShown(tally, SUMMARY_VARIANTS[0]!).shown.every((s) => s.worded)).toBe(true)
  })
})

describe("card facts", () => {
  const base = (over: Partial<Row>): Row => ({ ...rows()[0]!, ...over })
  it("shows the bar only for moving, planned, unquestioned work", () => {
    const moving = base({ tone: "working", stepsDone: 1, stepsTotal: 3, questionPending: false, currentStep: "Run" })
    expect(cardFacts(moving, undefined, true)).toMatchObject({ showsBar: true, planCaption: "Step 2 of 3 · Run", badge: "Running", footer: "facts" })
    expect(cardFacts(base({ ...moving, stepsDone: 3 }), undefined, true)).toMatchObject({ showsBar: false, planCaption: "3 of 3 done" })
  })
  it("a missed question says Missed and offers Dismiss; a pending one answers", () => {
    const missed = base({ questionMissed: true, questionPending: false, questionId: "q1" })
    expect(cardFacts(missed, undefined, false)).toMatchObject({ badge: "Missed", footer: "dismiss", planCaption: null })
    const pending = base({ questionPending: true, questionMissed: false, questionId: "q1", status: "x" })
    expect(cardFacts(pending, { kind: "approval", prompt: "Deploy?" }, false)).toMatchObject({ footer: "answer", bodyText: "Deploy?" })
  })
  it("answer bar states", () => {
    const spec = { kind: "approval" as const }
    expect(answerView(spec, undefined, true).kind).toBe("offline")
    expect(answerView(spec, { state: "sending" }, false).kind).toBe("sending")
    expect(answerView(spec, { state: "accepted" }, false).kind).toBe("sent")
    expect(answerView(undefined, undefined, false).kind).toBe("wait")
    expect(answerView({ kind: "text" }, undefined, false).kind).toBe("text")
    expect(answerView(spec, { state: "failed", message: "no" }, false)).toEqual({ kind: "buttons", failure: "no" })
  })
  it("hides ids that are not names", () => {
    expect(readableName("c-abcdefghij12")).toBeNull()
    expect(readableName("Relo")).toBe("Relo")
  })
})

describe("plan deck", () => {
  it("unskipped turns skipped steps into open ones", () => {
    const outline = makeOutline([{ id: "a", label: "A", state: "skipped" }, { id: "b", label: "B", state: "done" }] as never, undefined)!
    expect(unskipped(outline).rounds[0]!.nodes.map((n) => n.state)).toEqual(["pending", "complete"])
  })
})

describe("springs and marquee", () => {
  it("ReloMotion tokens", () => {
    expect(SPRINGS.snappy.stiffness).toBeCloseTo((2 * Math.PI / 0.28) ** 2, 4)
    expect(SPRINGS.press.damping).toBeCloseTo(2 * Math.sqrt(SPRINGS.press.stiffness), 6)
  })
  it("marquee scrolls only when the text is wider than its room, 30 pt/s", () => {
    expect(marqueeMotion(100, 200)).toBeNull()
    expect(marqueeMotion(300, 200)).toEqual({ distance: 310, duration: 10 })
  })
})

describe("sneak peek", () => {
  const fake = () => {
    let fn: (() => void) | null = null
    let ms = 0
    const timers: Timers = { set: (f, t) => ((fn = f), (ms = t), 1), clear: () => (fn = null) }
    return { timers, fire: () => fn?.(), ms: () => ms }
  }
  it("shows for 1.5 s then hides, restarting on a new peek", () => {
    const f = fake()
    const flag = new TimedFlag(1500, f.timers)
    flag.show("music")
    expect(flag.get().show).toBe(true)
    expect(f.ms()).toBe(1500)
    f.fire()
    expect(flag.get().show).toBe(false)
  })
  it("a sneak peek blocks hover-open", () => {
    expect(mayOpenOnHover({ open: false, sneakPeekShowing: true, openOnHover: true })).toBe(false)
    expect(mayOpenOnHover({ open: false, sneakPeekShowing: false, openOnHover: true })).toBe(true)
    expect(mayOpenOnHover({ open: true, sneakPeekShowing: false, openOnHover: true })).toBe(false)
  })
})
