import { CircleStop } from "lucide-react"
import * as React from "react"

import { ActionButton } from "@/components/molecules/action-button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import type { NowItem } from "@/features/inbox/now-model"
import type { InboxService } from "@/services/inbox-service"

/**
 * Ending a work from the Dashboard, the iPhone's End (EndingWork.swift, EndWorkViews.swift): offered for work that is
 * Quiet, Stopped responding, No signal, Paused or Your turn, never for a moving work, a question or settled work.
 * One confirmation, then the server decides (a work that is moving again is refused with `work_running`).
 */
const ENDABLE_STATES: ReadonlySet<NowItem["owner"]["state"]> = new Set([
  "stale",
  "stopped_responding",
  "no_signal",
  "paused",
  "waiting_on_you",
])

/** Whether the owner may end a work in this state. */
export function canEndWork(state: NowItem["owner"]["state"]): boolean {
  return ENDABLE_STATES.has(state)
}

export const endConfirmTitle = (goal: string) => `End "${goal}"?`
export const END_CONFIRM_MESSAGE = "It moves to History as ended by you. The agent's session keeps running."
export const ENDED_LINE = "Ended by you. It moved to History."
const END_RUNNING_REFUSAL = "This work is moving again; it can't be ended now."

/** A refusal in plain words (the server's code arrives as the service's error message). */
function endFailure(cause: unknown): string {
  const code = cause instanceof Error ? cause.message : ""
  if (code === "work_running") return END_RUNNING_REFUSAL
  if (code === "not_found" || code === "work_finished") return "This work is no longer there."
  return "Couldn't end the work. Check your connection and try again."
}

/** What a missed question's Dismiss says when the server refuses it. */
function dismissFailure(cause: unknown): string {
  return cause instanceof Error && cause.message === "not_found"
    ? "This question is already closed."
    : "Couldn't dismiss the question. Try again."
}

/** The owner's actions on Now's work, each answering null on success or the words for a refusal. */
export type WorkActions = {
  end(workId: string): Promise<string | null>
  dismiss(questionId: string): Promise<string | null>
}

/** The actions of a service that offers them (and the Now refetch after each); null when it offers none. */
export function workActionsOf(service: InboxService, refresh: () => void): WorkActions | null {
  const { endWork, dismissMissedQuestion } = service
  if (!endWork || !dismissMissedQuestion) return null
  return {
    async end(workId) {
      try {
        await endWork.call(service, workId)
        refresh()
        return null
      } catch (cause) {
        refresh()
        return endFailure(cause)
      }
    },
    async dismiss(questionId) {
      try {
        await dismissMissedQuestion.call(service, questionId)
        refresh()
        return null
      } catch (cause) {
        return dismissFailure(cause)
      }
    },
  }
}

/**
 * "End" on a Now card, "End work" on the detail: one confirmation (`End "<goal>"?`), then the work leaves Now for
 * History. The detail says so after it ended; a card simply goes with the next refetch.
 */
export function EndWorkButton({
  workId,
  goal,
  end,
  variant = "card",
}: {
  workId: string
  goal: string
  end: WorkActions["end"]
  variant?: "card" | "detail"
}) {
  const [asking, setAsking] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [ended, setEnded] = React.useState(false)
  const label = variant === "card" ? "End" : "End work"

  async function confirm() {
    setAsking(false)
    setPending(true)
    setError(null)
    const failure = await end(workId)
    setPending(false)
    if (failure) setError(failure)
    else setEnded(true)
  }

  if (ended && variant === "detail") {
    return (
      <p className="text-sm font-medium text-muted-foreground" role="status">
        {ENDED_LINE}
      </p>
    )
  }
  return (
    <>
      <ActionButton
        type="button"
        variant={variant === "card" ? "ghost" : "outline"}
        size="sm"
        pending={pending}
        failed={error !== null}
        pendingLabel="Ending…"
        disabled={ended}
        aria-label={variant === "card" ? `End ${goal}` : undefined}
        data-end-work={variant}
        onClick={() => setAsking(true)}
      >
        {variant === "detail" ? <CircleStop aria-hidden="true" /> : null}
        {label}
      </ActionButton>
      {error ? (
        <p className="basis-full text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{endConfirmTitle(goal)}</AlertDialogTitle>
            <AlertDialogDescription>{END_CONFIRM_MESSAGE}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void confirm()}>
              End work
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
