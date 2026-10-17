import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { AnswerControls, type AnswerLink } from "@/components/molecules/answer-controls"
import type { BrowserLinkState } from "@/lib/e2ee/browser-link"
import { timeLeft } from "@/lib/time-left"
import { AnswerError, createHttpAnswerService, type AnswerableQuestion, type AnswerService } from "@/services/answer-service"

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const BROWSER = "brw_00000000-0000-4000-8000-0000000000cc"
const signature = { e2eeKeyId: "k_AAAAAAAAAAAAAAAAAAAAAA", e2eeSignedAt: "2026-10-15T10:00:00.000Z", e2eeSignature: "sig" }

/** A browser link whose crypto is faked: it records what it was asked to sign. */
function fakeLink(state: BrowserLinkState = { status: "linked", browserId: BROWSER, identityKey: "key", linkedBy: "iPhone" },
  opened: { context: string; content: Record<string, unknown> } | null = null) {
  const listeners = new Set<() => void>()
  let current = state
  const link = {
    getState: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    signAnswer: vi.fn(async (target: { question?: string }) => ({
      browserId: BROWSER,
      signature: target.question ? { ...signature, e2eeQuestion: target.question, e2eeQuestionSignature: "qsig" } : signature,
    })),
    openQuestion: vi.fn(async () => opened),
    set(next: BrowserLinkState) {
      current = next
      listeners.forEach((listener) => listener())
    },
  }
  return link as unknown as AnswerLink & { signAnswer: ReturnType<typeof vi.fn>; openQuestion: ReturnType<typeof vi.fn>; set(next: BrowserLinkState): void }
}

function fakeService(submit?: AnswerService["submitAnswer"]) {
  return {
    loadQuestion: vi.fn(),
    submitAnswer: vi.fn(submit ?? (async (request) => ({ interactionId: request.interactionId, state: "approved", replayed: false, late: false, respondedAt: null }))),
  } satisfies AnswerService
}

const inFiveMinutes = () => new Date(Date.now() + 5 * 60_000).toISOString()

function approval(overrides: Partial<AnswerableQuestion> = {}): AnswerableQuestion {
  return {
    id: "int_00000000-0000-4000-8000-000000000001",
    notificationId: "ntf_00000000-0000-4000-8000-000000000002",
    kind: "approval",
    prompt: "Deploy 0.17 to production?",
    actions: [
      { action: "deny", label: "Hold" },
      { action: "approve", label: "Ship it" },
    ],
    expiresAt: inFiveMinutes(),
    source: "Claude Code",
    ...overrides,
  }
}

describe("AnswerControls", () => {
  it("shows the sender's labels (outline, then primary), the prompt and the time left", () => {
    render(<AnswerControls question={approval()} link={fakeLink()} service={fakeService()} />)
    expect(screen.getByText("Deploy 0.17 to production?")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Hold" })).toHaveAttribute("data-variant", "outline")
    expect(screen.getByRole("button", { name: "Ship it" })).toHaveAttribute("data-variant", "default")
    expect(screen.getByText(/^[45]:\d\d left$/u)).toBeInTheDocument()
  })

  it("an approval says plainly what it allows, then signs and sends once confirmed", async () => {
    const link = fakeLink()
    const service = fakeService()
    const onAnswered = vi.fn()
    render(<AnswerControls question={approval()} link={link} service={service} onAnswered={onAnswered} />)
    fireEvent.click(screen.getByRole("button", { name: "Ship it" }))
    expect(screen.getByText("This lets Claude Code proceed.")).toBeInTheDocument()
    expect(link.signAnswer).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Ship it" }))
    await waitFor(() => expect(onAnswered).toHaveBeenCalledWith(expect.objectContaining({ state: "approved" })))
    expect(link.signAnswer).toHaveBeenCalledWith({
      interactionId: "int_00000000-0000-4000-8000-000000000001",
      notificationId: "ntf_00000000-0000-4000-8000-000000000002",
      action: "approve",
    })
    expect(service.submitAnswer).toHaveBeenCalledWith(expect.objectContaining({ browserId: BROWSER, action: "approve", signature }))
    expect(screen.getByRole("status")).toHaveTextContent("Answered here: Ship it.")
  })

  it("a negative answer is sent at once; Back cancels a pending approval", async () => {
    const service = fakeService(async (request) => ({ interactionId: request.interactionId, state: "denied", replayed: false, late: false, respondedAt: null }))
    render(<AnswerControls question={approval()} link={fakeLink()} service={service} />)
    fireEvent.click(screen.getByRole("button", { name: "Ship it" }))
    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    expect(screen.queryByText("This lets Claude Code proceed.")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Hold" }))
    await waitFor(() => expect(service.submitAnswer).toHaveBeenCalledWith(expect.objectContaining({ action: "deny" })))
  })

  it("a choice sends the picked option; no option is styled as the preferred one", async () => {
    const service = fakeService()
    const link = fakeLink()
    render(
      <AnswerControls
        question={approval({ kind: "question", actions: [{ action: "choose", label: "Ship", optionId: "ship" }, { action: "choose", label: "Wait", optionId: "wait" }] })}
        link={link}
        service={service}
      />
    )
    expect(screen.getByRole("button", { name: "Wait" })).toHaveAttribute("data-variant", "outline")
    fireEvent.click(screen.getByRole("button", { name: "Wait" }))
    await waitFor(() => expect(service.submitAnswer).toHaveBeenCalledWith(expect.objectContaining({ action: "choose", optionId: "wait" })))
    expect(link.signAnswer).toHaveBeenCalledWith(expect.objectContaining({ action: "choose", optionId: "wait" }))
  })

  it("an unlinked browser offers the link flow instead of buttons", () => {
    render(<AnswerControls question={approval()} link={fakeLink({ status: "unlinked", browserId: BROWSER, identityKey: "key" })} service={fakeService()} />)
    expect(screen.getByRole("link", { name: "Link this browser from your iPhone to answer here" })).toHaveAttribute("href", "/dashboard/account#devices")
    expect(screen.queryByRole("button", { name: "Ship it" })).not.toBeInTheDocument()
  })

  it("a sealed question shows the opened prompt and binds the answer to the envelope it opened", async () => {
    const link = fakeLink(undefined, { context: "ntf:question-1", content: { summary: "Drop the staging database?" } })
    const service = fakeService(async (request) => ({ interactionId: request.interactionId, state: "no", replayed: false, late: false, respondedAt: null }))
    render(
      <AnswerControls
        question={approval({ kind: "question", encrypted: true, prompt: "Open Relo on your iPhone to read this question.",
          actions: [{ action: "no", label: "No" }, { action: "yes", label: "Yes" }] })}
        link={link}
        service={service}
      />
    )
    expect(await screen.findByText("Drop the staging database?")).toBeInTheDocument()
    expect(screen.queryByText(/Open Relo on your iPhone/u)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "No" }))
    await waitFor(() => expect(service.submitAnswer).toHaveBeenCalled())
    expect(link.openQuestion).toHaveBeenCalledWith("ntf_00000000-0000-4000-8000-000000000002")
    expect(link.signAnswer).toHaveBeenCalledWith(expect.objectContaining({ action: "no", question: "ntf:question-1" }))
  })

  it("a sealed question this browser cannot open cannot be answered here", async () => {
    render(<AnswerControls question={approval({ encrypted: true })} link={fakeLink(undefined, null)} service={fakeService()} />)
    expect(await screen.findByText("This browser can't read this question. Answer it on your iPhone.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Hold" })).not.toBeInTheDocument()
  })

  it("a question sealed only to the phones says so at once: no buttons, nothing opened or signed", async () => {
    const link = fakeLink(undefined, { context: "ntf:question-1", content: { summary: "Should not open" } })
    const service = fakeService()
    render(<AnswerControls question={approval({ encrypted: true, readableHere: false })} link={link} service={service} />)
    expect(screen.getByText("This question was sealed to your iPhone only. Answer it on your iPhone.")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Hold" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Ship it" })).not.toBeInTheDocument()
    expect(link.openQuestion).not.toHaveBeenCalled()
    expect(link.signAnswer).not.toHaveBeenCalled()
  })

  it("loaded by another phone's copy (a Now item's id), it signs and answers the copy the computer waits on", async () => {
    const nowCopy = "int_00000000-0000-4000-8000-0000000000ee"
    const asked = approval()
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ question: { ...asked, kind: "approval" } }), { status: 200 }))
    const loaded = await createHttpAnswerService(fetcher as unknown as typeof fetch).loadQuestion(nowCopy, undefined, BROWSER)
    expect(fetcher).toHaveBeenCalledWith(`/api/dashboard/questions/${nowCopy}`,
      expect.objectContaining({ headers: expect.objectContaining({ "x-relo-browser": BROWSER }) }))
    const link = fakeLink()
    const service = fakeService()
    render(<AnswerControls question={loaded} link={link} service={service} />)
    fireEvent.click(screen.getByRole("button", { name: "Hold" }))
    await waitFor(() => expect(service.submitAnswer).toHaveBeenCalled())
    expect(link.signAnswer).toHaveBeenCalledWith(expect.objectContaining({ interactionId: asked.id, notificationId: asked.notificationId }))
    expect(service.submitAnswer).toHaveBeenCalledWith(expect.objectContaining({ interactionId: asked.id, notificationId: asked.notificationId }))
  })

  it("a refusal is said in plain words; a retry after a network failure resends the same signed answer", async () => {
    let calls = 0
    const service = fakeService(async () => {
      calls += 1
      if (calls === 1) throw new TypeError("Failed to fetch")
      throw new AnswerError("interaction_not_pending", 409, "approved")
    })
    const link = fakeLink()
    render(<AnswerControls question={approval()} link={link} service={service} />)
    fireEvent.click(screen.getByRole("button", { name: "Hold" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("The answer did not go through. Try again.")
    fireEvent.click(screen.getByRole("button", { name: "Hold" }))
    expect(await screen.findByText("This question was already answered or closed.")).toBeInTheDocument()
    expect(link.signAnswer).toHaveBeenCalledTimes(1)
    const [first, second] = service.submitAnswer.mock.calls.map(([request]) => request)
    expect(second!.idempotencyKey).toBe(first!.idempotencyKey)
  })

  it("an expired question takes no answer here", () => {
    render(<AnswerControls question={approval({ expiresAt: new Date(Date.now() - 1000).toISOString() })} link={fakeLink()} service={fakeService()} />)
    expect(screen.getByText("Expired")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Ship it" })).not.toBeInTheDocument()
  })

  it("follows the link's state live", () => {
    const link = fakeLink({ status: "unlinked", browserId: BROWSER, identityKey: "key" })
    render(<AnswerControls question={approval()} link={link} service={fakeService()} />)
    act(() => link.set({ status: "linked", browserId: BROWSER, identityKey: "key", linkedBy: "iPhone" }))
    expect(screen.getByRole("button", { name: "Ship it" })).toBeInTheDocument()
  })
})

describe("timeLeft", () => {
  it("counts down in minutes and seconds, hours past an hour", () => {
    const now = Date.parse("2026-10-15T10:00:00.000Z")
    expect(timeLeft("2026-10-15T10:04:05.000Z", now)).toBe("4:05 left")
    expect(timeLeft("2026-10-15T11:20:00.000Z", now)).toBe("1 h 20 min left")
    expect(timeLeft("2026-10-15T09:59:00.000Z", now)).toBeNull()
    expect(timeLeft(null, now)).toBe("")
  })
})
