// Ports apps/notch/ReloNotchKit/Tests/ReloNotchKitTests/NotchEventsTests.swift: the notch expands for the same
// changes a Live Activity update shows; these pin which ones.

import type { NowItem } from "@relo/notification-contracts"
import { describe, expect, it } from "vitest"
import { eventsBetween } from "./events"
import { presentationOf } from "./presentation"
import { fixtureSummary } from "./testing"

const pendingQuestion = (id: string): NonNullable<NowItem["question"]> => ({ id, standing: "pending", askedAt: "2026-10-14T09:58:00.000Z", openedAt: null })

describe("NotchEvents", () => {
  it("the first summary only announces questions already waiting", () => {
    const now = fixtureSummary()
    expect(eventsBetween(null, presentationOf(now))).toEqual([])
    now.needsYou[0]!.question = pendingQuestion("int_00000000-0000-4000-8000-000000000001")
    expect(eventsBetween(null, presentationOf(now)).map((e) => e.kind)).toEqual(["question"])
  })

  it("an unchanged summary announces nothing", () => {
    const now = presentationOf(fixtureSummary())
    expect(eventsBetween(now, now)).toEqual([])
  })

  it("new work starts and finished or failed work is announced", () => {
    const before = fixtureSummary()
    const after = structuredClone(before)
    const started = structuredClone(before.running[0]!)
    started.id = "act_00000000-0000-4000-8000-0000000000ff"
    after.running.push(started)
    const finished = structuredClone(before.running[0]!)
    finished.owner.state = "done"
    after.running.shift()
    after.recent.unshift(finished)
    const events = eventsBetween(presentationOf(before), presentationOf(after))
    expect(events.map((e) => e.kind)).toEqual(["finished", "started"])
    expect(events[0]!.row.id).toBe(before.running[0]!.id)
  })

  it("a new question leads even on a work already shown", () => {
    const before = fixtureSummary()
    before.needsYou[0]!.question = pendingQuestion("int_00000000-0000-4000-8000-000000000001")
    const after = structuredClone(before)
    after.needsYou[0]!.question = pendingQuestion("int_00000000-0000-4000-8000-000000000002")
    after.recent[0]!.owner.state = "failed"
    const events = eventsBetween(presentationOf(before), presentationOf(after))
    expect(events.map((e) => e.kind)).toEqual(["question"])
  })

  it("progress and status changes update in place", () => {
    const before = fixtureSummary()
    const after = structuredClone(before)
    after.running[0]!.status = "Halfway"
    after.running[0]!.steps!.done = 2
    expect(eventsBetween(presentationOf(before), presentationOf(after))).toEqual([])
  })

  it("work that moves again after a pause starts", () => {
    const before = fixtureSummary()
    const paused = before.running.shift()!
    paused.owner.state = "paused"
    before.paused = [paused]
    const after = fixtureSummary()
    expect(eventsBetween(presentationOf(before), presentationOf(after)).map((e) => e.kind)).toEqual(["started"])
  })
})
