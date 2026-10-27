import { describe, expect, it } from "vitest"

import {
  typeLabel,
  cardFor,
  originLabel,
  nowMix,
  signalOf,
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
  it("projects a running card", () => {
    const card = cardFor(summary({ activity: activity({}) }), now)
    expect(card.outcome).toMatchObject({ kind: "running", label: "Running", tone: "cyan" })
    expect(card.topic).toBe("Releases")
    expect(card.type).toBe("Live Activity")
  })

  it("says Done / Stopped from the outcome, in History's words", () => {
    const done = cardFor(summary({ activity: activity({ state: "ended", outcome: "completed", steps: { done: 4, total: 4, current: null }, endedAt: "2026-08-07T12:30:00Z" }) }), now)
    expect(done.outcome.label).toBe("Done")
    const stopped = cardFor(summary({ activity: activity({ state: "ended", outcome: "failed" }) }), now)
    // History's words, as on the iPhone: failed work stopped.
    expect(stopped.outcome).toMatchObject({ label: "Stopped", tone: "red" })
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

  it("labels a choice question and names the option picked", () => {
    expect(typeLabel("notification", "choice")).toBe("Choice")
    const chosen = { kind: "choice", prompt: "Which release?", state: "replied", respondedAt: "2026-08-07T12:08:00Z",
      expiresAt: "2026-08-07T13:00:00Z", chosenLabel: "Roll back" }
    const card = cardFor(summary({ activity: activity({ state: "ended", outcome: "completed" }), question: chosen }), now)
    expect(card.decision).toMatchObject({ prompt: "Which release?", answer: "You chose Roll back", pending: false })
  })

  it("maps outcomes to one meaning each and mixes today by meaning for the orb", () => {
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

  it("hides a sealed card's placeholders and leaves out the names it cannot read", () => {
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
    // Names this browser has not learned tell the owner nothing: identity leaves them out.
    expect(card.project).toBeNull()
    expect(card.topic).toBeNull()
    expect(card.origin).toBeNull()
    expect(card.decision).toMatchObject({ encrypted: true, prompt: "End-to-end encrypted · open on iPhone to read", pending: true })
    expect(card.outcome.kind).toBe("running")

    const readable = cardFor(summary({ activity: activity({}) }), now)
    expect(readable.encrypted).toBe(false)
    expect(readable.title).toBe("Ship build")
  })
})
