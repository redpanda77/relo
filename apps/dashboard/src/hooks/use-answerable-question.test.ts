import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { AnswerableQuestion, AnswerService } from "@/services/answer-service"

let hint: () => void = () => {}
vi.mock("@/features/inbox/use-now-live", () => ({ connectNowLive: (refetch: () => void) => { hint = refetch; return () => {} } }))
vi.mock("@/lib/e2ee/browser-link", () => ({ currentBrowserLink: () => null }))

const { isOpenQuestion, useAnswerableQuestion } = await import("@/hooks/use-answerable-question")

afterEach(cleanup)

const question = (state: string) =>
  ({ interactionId: "int_1", notificationId: "ntf_1", kind: "approval", prompt: "Deploy?", actions: [], expiresAt: null, state }) as unknown as AnswerableQuestion

describe("useAnswerableQuestion", () => {
  it("reads the question again on the server's change hint, so one answered elsewhere is no longer open", async () => {
    const loadQuestion = vi.fn().mockResolvedValueOnce(question("pending")).mockResolvedValueOnce(question("approved"))
    const service = { loadQuestion, submitAnswer: vi.fn() } as unknown as AnswerService
    const { result } = renderHook(() => useAnswerableQuestion("int_1", service))
    await act(async () => {})
    expect(result.current && isOpenQuestion(result.current)).toBe(true)
    await act(async () => hint())
    expect(loadQuestion).toHaveBeenCalledTimes(2)
    expect(result.current && isOpenQuestion(result.current)).toBe(false)
  })
})
