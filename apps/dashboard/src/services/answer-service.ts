import type { AnswerAction, AnswerSignature } from "@/lib/e2ee/answer"

/**
 * Answering questions from a linked browser (docs/ENCRYPTION-PROTOCOL.md, "Answering from a
 * linked browser"). The browser signs; the server admits the answer for a browser a trusted phone
 * linked and relays it to the waiting computer like a phone's; the computer decides whether it counts.
 */

/**
 * One question as this browser answers it (`GET /api/dashboard/questions/:id`). Any copy's id loads
 * it (a question on a card has a copy per phone; Now names the newest): the server answers with the
 * copy the asking computer waits on, whose ids the browser signs, so the computer accepts the answer.
 */
export type AnswerableQuestion = {
  /** `int_…`: the copy the producer waits on (may differ from the id it was loaded by). */
  id: string
  /** `ntf_…`: the question's notification, part of the signed input. */
  notificationId: string
  kind: "approval" | "question"
  /** The question line; the server's placeholder until a sealed question is opened. */
  prompt: string
  /** The sender's own button labels, in order: the negative one first, then the positive. */
  actions: Array<{ action: AnswerAction; label: string; optionId?: string }>
  expiresAt: string | null
  /** Sealed end to end: the browser must open it before it can answer. */
  encrypted?: boolean
  /**
   * Sealed and asked for this browser: whether the computer sealed it to this browser. False means it
   * was sealed only to phones, so it is answered on the iPhone. Absent when the server was not told.
   */
  readableHere?: boolean
  /** Who asks ("Claude Code", "deploy.sh"): "This lets <source> proceed". */
  source?: string
  state?: string
}

export type SubmittedAnswer = {
  interactionId: string
  state: string
  replayed: boolean
  /** Recorded after the question expired: a fact for the producer, never permission. */
  late: boolean
  respondedAt: string | null
}

export type AnswerRequest = {
  interactionId: string
  notificationId: string
  browserId: string
  action: AnswerAction
  optionId?: string
  /** Made once per tap and repeated on a retry, so a retry is one answer. */
  idempotencyKey: string
  signature: AnswerSignature
}

export class AnswerError extends Error {
  readonly code: string
  readonly status: number
  readonly state?: string

  constructor(code: string, status: number, state?: string) {
    super(answerErrorMessage(code))
    this.name = "AnswerError"
    this.code = code
    this.status = status
    this.state = state
  }
}

/** Plain words for every refusal the answer route returns. */
export function answerErrorMessage(code: string): string {
  switch (code) {
    case "browser_not_linked":
      return "This browser is no longer linked. Link it again from your iPhone to answer here."
    case "question_unreadable":
      return "This browser can't read this question. Answer it on your iPhone."
    case "interaction_not_pending":
    case "interaction_terminal":
    case "interaction_superseded":
      return "This question was already answered or closed."
    case "question_dismissed":
      return "You dismissed this question, so it takes no answer."
    case "invalid_signature":
      return "Your answer could not be signed correctly. Reload the page and try again."
    case "not_asked_copy":
      return "This question changed. Reload the page and answer again."
    case "not_found":
    case "interaction_not_found":
      return "This question is gone."
    case "rate_limited":
      return "Too many answers at once. Wait a minute and try again."
    case "owner_role_required":
      return "Only the account's owner can answer questions."
    default:
      return "The answer did not go through. Try again."
  }
}

export interface AnswerService {
  /** `browserId`: this browser, so the server can say whether a sealed question was sealed to it. */
  loadQuestion(interactionId: string, signal?: AbortSignal, browserId?: string): Promise<AnswerableQuestion>
  submitAnswer(request: AnswerRequest): Promise<SubmittedAnswer>
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  const payload = (await response.json().catch(() => null)) as unknown
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null
}

function refusal(response: Response, payload: Record<string, unknown> | null) {
  return new AnswerError(
    typeof payload?.error === "string" ? payload.error : `http_${response.status}`,
    response.status,
    typeof payload?.state === "string" ? payload.state : undefined
  )
}

export function createHttpAnswerService(fetcher: typeof fetch = (input, init) => fetch(input, init)): AnswerService {
  return {
    async loadQuestion(interactionId, signal, browserId) {
      const response = await fetcher(`/api/dashboard/questions/${encodeURIComponent(interactionId)}`, {
        credentials: "same-origin",
        headers: { accept: "application/json", ...(browserId ? { "x-relo-browser": browserId } : {}) },
        signal,
      })
      const payload = await readJson(response)
      if (!response.ok) throw refusal(response, payload)
      const question = payload?.question as (Omit<AnswerableQuestion, "kind"> & { kind: string }) | undefined
      if (!question) throw new AnswerError("not_found", 404)
      return { ...question, kind: question.kind === "approval" ? "approval" : "question" }
    },
    async submitAnswer({ interactionId, notificationId, browserId, action, optionId, idempotencyKey, signature }) {
      const response = await fetcher(`/api/dashboard/questions/${encodeURIComponent(interactionId)}/answer`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", accept: "application/json", "x-relo-browser": browserId },
        body: JSON.stringify({ notificationId, action, ...(optionId ? { optionId } : {}), idempotencyKey, signature }),
      })
      const payload = await readJson(response)
      if (!response.ok) throw refusal(response, payload)
      return {
        interactionId: String(payload?.interactionId ?? interactionId),
        state: String(payload?.state ?? ""),
        replayed: payload?.replayed === true,
        late: payload?.late === true,
        respondedAt: typeof payload?.respondedAt === "string" ? payload.respondedAt : null,
      }
    },
  }
}
