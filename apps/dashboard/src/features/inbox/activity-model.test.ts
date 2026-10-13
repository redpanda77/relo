import { describe, expect, it } from "vitest"

import {
  agentSecondsToday,
  agentTimeLabel,
  cardFor,
  clockLabel,
  originLabel,
  runtimeLabel,
  daySummary,
  groupByDay,
  metaLine,
  nowMetrics,
  nowMix,
  nowSentence,
  quietFor,
  quietLabel,
  signalOf,
  todayActivity,
  stepStates,
} from "@/features/inbox/activity-model"
import type { NotificationSummary } from "@/features/inbox/types"

const context = {
  providerName: null, producerKind: null, computer: null, account: null, project: "Relo", providerThreadId: null,
  providerWorkItemId: null, threadName: "Releases", taskTitle: null, threadNameSource: null, taskTitleSource: null,
}
const now = new Date("2026-08-07T12:30:00Z").valueOf()

function summary(patch: Partial<NotificationSummary> = {}): NotificationSummary {
  return {
    id: "ntf_1", title: "Ship build", body: "", source: "Codex", requesterKind: "cli", kind: "live_activity",
    state: "active", createdAt: "2026-08-07T12:00:00Z", destination: { state: "not-set", href: null },
    targetDeviceNames: [], response: null, context, originThreadId: null, activity: null, ...patch,
  } as NotificationSummary
}

const activity = (patch: Record<string, unknown>) =>
  ({
    id: "act_1", state: "active", title: "Ship build", status: "Compiling", context, progress: null,
    createdAt: "2026-08-07T11:57:00Z", updatedAt: "2026-08-07T12:20:00Z", endedAt: null, updates: 6,
    steps: { done: 2, total: 4, current: "Build" }, outcome: null, ...patch,
  }) as NotificationSummary["activity"]

describe("activity card model", () => {
  it("projects a running card with steps and a meta line", () => {
    const card = cardFor(summary({ activity: activity({}) }), now)
    expect(card.outcome).toMatchObject({ kind: "running", label: "Running", tone: "cyan" })
    expect(stepStates(card)).toEqual(["done", "done", "current", "pending"])
    expect(metaLine(card)).toBe("2 of 4 steps · 6 updates")
    expect(card.topic).toBe("Releases")
    expect(card.type).toBe("Live Activity")
  })

  it("says Done / Stopped from the outcome and counts every step", () => {
    const done = cardFor(summary({ activity: activity({ state: "ended", outcome: "completed", steps: { done: 4, total: 4, current: null }, endedAt: "2026-08-07T12:30:00Z" }) }), now)
    expect(done.outcome.label).toBe("Done")
    expect(metaLine(done)).toBe("All 4 steps · 6 updates")
    const stopped = cardFor(summary({ activity: activity({ state: "ended", outcome: "failed" }) }), now)
    expect(stopped.outcome).toMatchObject({ label: "Stopped", tone: "red" })
    expect(stepStates(stopped)[2]).toBe("stopped")
  })

  it("turns a question into Needs you or its answer, and a card keeps the question as a strip", () => {
    const pending = { kind: "approval", prompt: "Fix 3 broken links?", state: "pending", respondedAt: null, expiresAt: "2026-08-07T13:00:00Z" }
    expect(cardFor(summary({ kind: "approval", question: pending }), now).outcome.label).toBe("Needs you")
    const declined = { ...pending, state: "denied", respondedAt: "2026-08-07T12:08:00Z" }
    expect(cardFor(summary({ kind: "approval", question: declined }), now).outcome.label).toBe("Declined")
    const onCard = cardFor(
      summary({ activity: activity({ state: "ended", outcome: "completed" }), question: { ...pending, state: "approved", respondedAt: "2026-08-07T12:08:00Z" } }),
      now
    )
    expect(onCard.outcome.label).toBe("Done")
    expect(onCard.decision).toMatchObject({ prompt: "Fix 3 broken links?", answer: "You approved", pending: false })
    expect(cardFor(summary({ kind: "approval", question: { ...pending, expiresAt: "2026-08-07T12:00:00Z" } }), now).outcome.label).toBe("No answer")
  })

  it("summarises the day and the HUD", () => {
    const cards = [
      cardFor(summary({ id: "a", activity: activity({}) }), now),
      cardFor(summary({ id: "b", activity: activity({ state: "ended", outcome: "completed" }) }), now),
      cardFor(summary({ id: "c", kind: "notification", state: "recorded" }), now),
    ]
    expect(daySummary(cards)).toBe("1 running · 1 done · 1 message")
    const groups = groupByDay(cards, new Date(now))
    expect(groups).toHaveLength(1)
    expect(groups[0]!.label).toBe("Today")
    expect(nowMetrics({ cards, running: 1, needsYou: 0, now: new Date(now) })).toEqual({ today: 3, done: 1, running: 1, needsYou: 0 })
    expect(nowSentence({ running: 0, needsYou: 0 })).toBe("All clear. Nothing needs you right now.")
    expect(nowSentence({ running: 1, needsYou: 0 })).toBe("One task is running. Its progress is on the ring.")
    expect(nowSentence({ running: 1, needsYou: 2 })).toBe("Requests are waiting for your answer below, and work is still running.")
  })

  it("maps outcomes to one meaning each and mixes today by meaning", () => {
    const ended = (patch: Record<string, unknown>, id: string) =>
      cardFor(summary({ id, activity: activity({ state: "ended", ...patch }) }), now)
    const cards = [
      ended({ outcome: "completed" }, "a"),
      ended({ outcome: "failed" }, "b"),
      ended({ outcome: null }, "c"),
      cardFor(summary({ id: "d", kind: "notification", state: "recorded" }), now),
      cardFor(summary({ id: "e", activity: activity({}) }), now),
    ]
    expect(cards.map(signalOf)).toEqual(["done", "failed", "attention", "message", "running"])
    expect(nowMix({ cards, running: 1, needsYou: 2, now: new Date(now) })).toEqual({
      done: 1, failed: 1, attention: 1, message: 1, running: 1, needsYou: 2,
    })
    const strip = todayActivity(cards, new Date(now))
    expect(strip.rows).toHaveLength(4)
    expect(strip.legend.map((entry) => entry.text)).toEqual(["1 done", "1 to review", "1 stopped", "1 message"])
  })

  it("calls a card quiet after 20 minutes without an update", () => {
    const card = cardFor(summary({ activity: activity({ updatedAt: "2026-08-07T12:05:00Z" }) }), now)
    expect(quietFor(card, now)).toBe(25 * 60_000)
    expect(quietLabel(25 * 60_000)).toBe("25M")
    expect(quietLabel(125 * 60_000)).toBe("2H 5M")
    expect(quietFor(cardFor(summary({ activity: activity({ updatedAt: "2026-08-07T12:20:00Z" }) }), now), now)).toBeNull()
  })
})

describe("origin, runtime and agent time", () => {
  it("joins computer and account, hiding what is absent", () => {
    expect(originLabel({ computer: "MacBook", account: "work" })).toBe("MacBook · work")
    expect(originLabel({ computer: "MacBook", account: null })).toBe("MacBook")
    expect(originLabel({ computer: null, account: "work" })).toBe("work")
    expect(originLabel({ computer: null, account: null })).toBeNull()
    const card = cardFor(summary({ activity: activity({ context: { ...context, computer: "MacBook", account: "work" } }) }), now)
    expect(card.origin).toBe("MacBook · work")
    expect(cardFor(summary({ activity: activity({}) }), now).origin).toBeNull()
  })

  it("formats clocks as mm:ss and h:mm:ss", () => {
    expect(clockLabel(0)).toBe("00:00")
    expect(clockLabel(760)).toBe("12:40")
    expect(clockLabel(3599)).toBe("59:59")
    expect(clockLabel(4330)).toBe("1:12:10")
  })

  it("says running while active and ran once finished", () => {
    const running = cardFor(summary({ activity: activity({}) }), now)
    expect(runtimeLabel(running, now)).toBe("running 33:00")
    const finished = cardFor(summary({ activity: activity({ state: "ended", outcome: "completed", endedAt: "2026-08-07T12:01:12Z" }) }), now)
    expect(runtimeLabel(finished, now)).toBe("ran 04:12")
    expect(runtimeLabel({ ...finished, endedAt: null }, now)).toBeNull()
    expect(runtimeLabel({ ...running, startedAt: null }, now)).toBeNull()
  })

  it("sums today's agent time, counting running cards up to now", () => {
    const at = new Date("2026-08-07T12:30:00Z")
    const finished = cardFor(summary({ activity: activity({ state: "ended", outcome: "completed", createdAt: "2026-08-07T10:00:00Z", endedAt: "2026-08-07T11:00:00Z" }) }), now)
    const running = cardFor(summary({ activity: activity({ createdAt: "2026-08-07T12:00:00Z" }) }), now)
    const yesterday = cardFor(summary({ activity: activity({ state: "ended", outcome: "completed", createdAt: "2026-08-01T10:00:00Z", endedAt: "2026-08-01T12:00:00Z" }) }), now)
    const message = cardFor(summary({ kind: "notification", activity: null }), now)
    expect(agentSecondsToday([finished, running, yesterday, message], at)).toBe(3600 + 1800)
    expect(agentTimeLabel(15_120)).toBe("4h 12m")
    expect(agentTimeLabel(720)).toBe("12m")
    expect(agentTimeLabel(5)).toBe("0m")
  })

  it("hides a sealed card's placeholders and names its handles without showing them", () => {
    const sealedContext = {
      ...context, project: "p-abcdefghijklmnop", threadName: "t-abcdefghijklmnop",
      computer: "c-abcdefghijklmnop", account: "a-abcdefghijklmnop",
    }
    const card = cardFor(summary({
      encrypted: true, title: "Encrypted card", context: sealedContext,
      activity: activity({ encrypted: true, title: "Encrypted card", status: "Updating…", context: sealedContext,
        steps: { done: 1, total: 3, current: "Step 2" } }),
      question: { kind: "approval", prompt: "Open Relo on your iPhone to read this question.", state: "pending",
        respondedAt: null, expiresAt: null, encrypted: true },
    }), now)
    expect(card.encrypted).toBe(true)
    expect(card.title).toBe("End-to-end encrypted · open on iPhone to read")
    expect(card.summary).toBeNull()
    expect(card.steps).toEqual({ done: 1, total: 3, current: null })
    expect(card.project?.name).toBe("Encrypted project")
    expect(card.topic).toBe("Encrypted topic")
    expect(card.origin).toBe("Encrypted computer · Encrypted account")
    expect(card.decision).toMatchObject({ encrypted: true, prompt: "End-to-end encrypted · open on iPhone to read", pending: true })
    expect(card.outcome.kind).toBe("running")

    const readable = cardFor(summary({ activity: activity({}) }), now)
    expect(readable.encrypted).toBe(false)
    expect(readable.title).toBe("Ship build")
  })
})
