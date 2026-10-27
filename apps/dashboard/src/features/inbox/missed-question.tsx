import * as React from "react"

import { ActionButton } from "@/components/molecules/action-button"
import { Button } from "@/components/ui/button"
import type { WorkActions } from "@/features/inbox/end-work"

/**
 * The footer of a missed question's Now card, the iPhone's: Dismiss (the question no longer needs the owner and
 * refuses a late answer) and Answer late (the answer controls open in the card, and what it sends is a note, never
 * permission). Neither opens the detail.
 */
export function MissedActions({
  questionId,
  dismiss,
  answering,
  onAnswerLate,
}: {
  questionId: string
  dismiss: WorkActions["dismiss"]
  /** The late answer is open on the card. */
  answering: boolean
  onAnswerLate: () => void
}) {
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  async function run() {
    setPending(true)
    setError(null)
    const failure = await dismiss(questionId)
    setPending(false)
    if (failure) setError(failure)
  }
  return (
    <>
      <ActionButton
        type="button"
        variant="outline"
        pending={pending}
        failed={error !== null}
        pendingLabel="Dismissing…"
        onClick={() => void run()}
      >
        Dismiss
      </ActionButton>
      <Button type="button" aria-expanded={answering} onClick={onAnswerLate}>
        Answer late
      </Button>
      {error ? (
        <p className="basis-full text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </>
  )
}
