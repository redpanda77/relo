/**
 * AnswerControls: answer a question or an approval from this browser, signed with its own key
 * (docs/ENCRYPTION-PROTOCOL.md, "Answering from a linked browser"). Parity with the iPhone's
 * buttons: the sender's own labels, the time left, one answer per question.
 *
 * Props
 * - `question` (required): `AnswerableQuestion` from `services/answer-service.ts`
 *   - `id`: `int_…`, the copy the producer waits on, as `GET /api/dashboard/questions/:id` resolves
 *     any copy's id (a Now item's `question.id`, a detail's `interaction.id`); never sign another copy
 *   - `notificationId`: `ntf_…`, the question's notification (part of what the browser signs)
 *   - `kind`: "approval" | "question"
 *   - `actions`: `[{ action: "approve"|"deny"|"yes"|"no"|"choose", label, optionId? }]`, the sender's
 *     labels in order (negative first, then positive; a choice's options in their order)
 *   - `prompt`: the question line; `encrypted`: sealed end to end (the browser opens it first and
 *     shows the opened prompt); `readableHere`: false when it was sealed only to phones;
 *     `expiresAt`: ISO or null; `source`: who asks ("Claude Code")
 *   Don't have these? `useAnswerableQuestion(id)` (hooks/use-answerable-question.ts) loads them (`GET /api/dashboard/questions/:id`).
 * - `onAnswered?(answer)`: called once the server recorded the answer (`state`, `late`, `replayed`)
 * - `showPrompt?` (default true): render the question line above the buttons
 * - `countdown?` (default true): render the time left beside the buttons; a card that shows it in its
 *   header's corner passes false
 * - `link?`, `service?`: the browser link and the HTTP service; tests inject fakes, pages omit them
 *
 * Rendering: one wrapping row, gap 8: the countdown (the card set's Countdown) leading, the buttons
 * (card action height; outline, then primary) trailing. In a card footer (`.card-actions`) the
 * buttons lay straight into the footer beside the metadata. An approval says "This lets <source> proceed." and asks to confirm
 * before it signs. A browser that is not linked shows "Link this browser from your iPhone to answer
 * here" with a link to Account → Devices; a sealed question sealed only to phones, or one it cannot
 * open, says to answer on the iPhone and shows no buttons. The computer still decides whether a browser's answer counts (never in strict mode).
 */
import * as React from "react"

import { Countdown } from "@/components/card"
import { ActionButton, type ActionPhase } from "@/components/molecules/action-button"
import { Button } from "@/components/ui/button"
import { currentBrowserLink, type BrowserLink, type BrowserLinkState } from "@/lib/e2ee/browser-link"
import type { AnswerSignature } from "@/lib/e2ee/answer"
import { playCue } from "@/lib/sound"
import { useTicker } from "@/lib/ticker"
import { timeLeft } from "@/lib/time-left"
import { cn } from "@/lib/utils"
import {
  AnswerError,
  answerErrorMessage,
  createHttpAnswerService,
  type AnswerableQuestion,
  type AnswerService,
  type SubmittedAnswer,
} from "@/services/answer-service"

const LINK_BROWSER_HREF = "/dashboard/account#devices"

/** What AnswerControls needs from the browser link (BrowserLink implements it). */
export type AnswerLink = Pick<BrowserLink, "getState" | "subscribe" | "signAnswer" | "openQuestion">

type Choice = AnswerableQuestion["actions"][number]
type Attempt = { key: string; choice: Choice; browserId: string; signature: AnswerSignature }

const UNAVAILABLE: BrowserLinkState = { status: "unavailable" }
const noSubscription = () => () => undefined

function useLinkState(link: AnswerLink | null): BrowserLinkState {
  return React.useSyncExternalStore(link?.subscribe ?? noSubscription, link?.getState ?? (() => UNAVAILABLE), () => UNAVAILABLE)
}

const tapKey = () =>
  `tap-${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`

const sameChoice = (a: Choice, b: Choice) => a.action === b.action && a.optionId === b.optionId

export function AnswerControls({
  question,
  onAnswered,
  showPrompt = true,
  countdown: showCountdown = true,
  link: givenLink,
  service,
  className,
}: {
  question: AnswerableQuestion
  onAnswered?: (answer: SubmittedAnswer) => void
  showPrompt?: boolean
  countdown?: boolean
  link?: AnswerLink | null
  service?: AnswerService
  className?: string
}) {
  const link = givenLink === undefined ? currentBrowserLink() : givenLink
  const http = React.useMemo(() => service ?? createHttpAnswerService(), [service])
  const state = useLinkState(link)
  const now = useTicker(Boolean(question.expiresAt))
  const left = timeLeft(question.expiresAt, now)
  const linked = state.status === "linked"

  // A sealed question: open it first; its context is what the answer binds to.
  const [opened, setOpened] = React.useState<{ context: string; prompt: string | null } | "unreadable" | null>(null)
  React.useEffect(() => {
    if (!question.encrypted || question.readableHere === false || !linked || !link) return
    let active = true
    link.openQuestion(question.notificationId).then(
      (result) => {
        if (!active) return
        const summary = result?.content.summary
        setOpened(result ? { context: result.context, prompt: typeof summary === "string" && summary.trim() ? summary : null } : "unreadable")
      },
      () => active && setOpened("unreadable")
    )
    return () => {
      active = false
    }
  }, [link, linked, question.encrypted, question.notificationId, question.readableHere])

  const [confirming, setConfirming] = React.useState<Choice | null>(null)
  const [running, setRunning] = React.useState<Choice | null>(null)
  const [phase, setPhase] = React.useState<{ choice: Choice; phase: ActionPhase } | null>(null)
  const [error, setError] = React.useState("")
  const [answered, setAnswered] = React.useState<{ choice: Choice; result: SubmittedAnswer } | null>(null)
  const attempt = React.useRef<Attempt | null>(null)

  const sealedPrompt = opened && opened !== "unreadable" ? opened.prompt : null
  const prompt = sealedPrompt ?? (question.encrypted ? null : question.prompt)
  const source = question.source?.trim() || "it"
  const positive = (choice: Choice) => choice.action === "approve"

  async function submit(choice: Choice) {
    if (!link || running) return
    setRunning(choice)
    setPhase({ choice, phase: "pending" })
    setError("")
    try {
      // One signature per tap (like the iPhone): a retry of the same answer sends identical bytes.
      if (!attempt.current || !sameChoice(attempt.current.choice, choice)) {
        const context = question.encrypted ? (opened && opened !== "unreadable" ? opened.context : null) : undefined
        if (context === null) throw new AnswerError("question_unreadable", 403)
        const signed = await link.signAnswer({
          interactionId: question.id,
          notificationId: question.notificationId,
          action: choice.action,
          ...(choice.optionId ? { optionId: choice.optionId } : {}),
          ...(context ? { question: context } : {}),
        })
        attempt.current = { key: tapKey(), choice, browserId: signed.browserId, signature: signed.signature }
      }
      const current = attempt.current
      const result = await http.submitAnswer({
        interactionId: question.id,
        notificationId: question.notificationId,
        browserId: current.browserId,
        action: choice.action,
        ...(choice.optionId ? { optionId: choice.optionId } : {}),
        idempotencyKey: current.key,
        signature: current.signature,
      })
      setPhase({ choice, phase: "success" })
      setConfirming(null)
      setAnswered({ choice, result })
      playCue("sent")
      onAnswered?.(result)
    } catch (cause) {
      setPhase({ choice, phase: "error" })
      setError(cause instanceof AnswerError ? cause.message : cause instanceof Error && /Link this browser/u.test(cause.message)
        ? answerErrorMessage("browser_not_linked") : answerErrorMessage("unknown"))
      // A refusal from the server is final for this signature; a network failure retries the same one.
      if (cause instanceof AnswerError) attempt.current = null
    } finally {
      setRunning(null)
    }
  }

  const countdown = showCountdown && left !== "" ? <Countdown deadline={question.expiresAt} /> : null
  const promptLine = showPrompt && prompt ? <p className="basis-full text-sm font-medium text-foreground">{prompt}</p> : null

  let body: React.ReactNode
  if (answered) {
    body = (
      <p className="text-sm text-muted-foreground" role="status">
        {answered.result.late
          ? `Answered late: ${answered.choice.label}. Recorded as a note, never as permission.`
          : `Answered here: ${answered.choice.label}.`}
      </p>
    )
  } else if (state.status === "unlinked" || state.status === "unavailable" || state.status === "error") {
    body = (
      <p className="text-sm text-muted-foreground">
        <a href={LINK_BROWSER_HREF} className="text-primary underline-offset-4 hover:underline">
          Link this browser from your iPhone to answer here
        </a>
        .
      </p>
    )
  } else if (left === null) {
    body = <p className="text-sm text-muted-foreground">This question expired. Nothing proceeds without your answer.</p>
  } else if (question.encrypted && question.readableHere === false) {
    // Sealed only to the phones (the computer did not seal it to this browser): no buttons that would fail.
    body = <p className="text-sm text-muted-foreground">This question was sealed to your iPhone only. Answer it on your iPhone.</p>
  } else if (question.encrypted && opened === "unreadable") {
    body = <p className="text-sm text-muted-foreground">This browser can&apos;t read this question. Answer it on your iPhone.</p>
  } else if (confirming) {
    body = (
      <>
        <p className="mr-auto text-sm text-foreground">This lets {source} proceed.</p>
        <div className="answer-buttons" role="group" aria-label="Confirm">
          <Button type="button" variant="outline" disabled={Boolean(running)} onClick={() => setConfirming(null)}>
            Back
          </Button>
          <ActionButton
            type="button"
            phase={phase && sameChoice(phase.choice, confirming) ? phase.phase : "idle"}
            pendingLabel="Signing…"
            successLabel="Answered"
            onClick={() => void submit(confirming)}
          >
            {confirming.label}
          </ActionButton>
        </div>
      </>
    )
  } else {
    const waiting = state.status === "starting" || (question.encrypted && opened === null)
    const choice = question.kind !== "approval" && question.actions.every((entry) => entry.action === "choose")
    body = (
      <div className="answer-buttons" role="group" aria-label="Answer">
        {question.actions.map((entry, index) => {
          const primary = !choice && index === question.actions.length - 1
          return (
            <ActionButton
              key={`${entry.action}:${entry.optionId ?? ""}`}
              type="button"
              variant={primary ? "default" : "outline"}
              disabled={waiting || Boolean(running && !sameChoice(running, entry))}
              phase={phase && sameChoice(phase.choice, entry) ? phase.phase : "idle"}
              pendingLabel="Signing…"
              successLabel="Answered"
              onClick={() => (positive(entry) ? setConfirming(entry) : void submit(entry))}
            >
              {entry.label}
            </ActionButton>
          )
        })}
      </div>
    )
  }

  return (
    <div className={cn("answer-controls", className)} data-slot="answer-controls">
      {promptLine}
      {answered ? null : countdown}
      {body}
      {error ? (
        <p className="basis-full text-[13px] text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
