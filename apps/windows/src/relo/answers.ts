// The answers the owner can give from the notch: approve or deny, yes or no, or one of a choice's options.
// Ports the buttons of ReloAnswerBar (apps/notch/boringNotch/components/Relo/ReloNotchView.swift). Free-text
// replies go to the phone or the Dashboard. Nothing here sends anything: the host passes `onAnswer`.

export type AnswerAction = "approve" | "deny" | "yes" | "no" | "choose"

/**
 * What kind of question a pending card holds. The Now summary only says a question is pending (`question.id`,
 * `standing`); its kind and options come from the interaction itself, so the host supplies them by question id.
 */
export interface QuestionSpec {
  kind: "approval" | "yesNo" | "choice" | "text"
  prompt?: string
  /** A choice's options: two to four. */
  options?: Array<{ id: string; label: string }>
}

/** `onAnswer(interactionId, action, optionId?)`: the interaction is the pending question's id (`int_...`). */
export type OnAnswer = (interactionId: string, action: AnswerAction, optionId?: string) => void

/** Where an answer stands: the host reports it back by interaction id. */
export type AnswerPhase = { state: "sending" } | { state: "accepted" } | { state: "failed"; message: string }

export interface AnswerButton {
  label: string
  action: AnswerAction
  optionId?: string
  /** The primary answer is filled in the card's colour. */
  prominent: boolean
}

export const MAX_CHOICES = 4

/** The buttons for a question (Relo on this PC has nothing to approve: the same two answers read Yes and No); empty for a free-text one (answered on the phone) or an unknown kind. */
export function answerButtons(spec: QuestionSpec | undefined, local = false): AnswerButton[] {
  switch (spec?.kind) {
    case "approval":
      return [
        { label: local ? "Yes" : "Approve", action: "approve", prominent: true },
        { label: local ? "No" : "Deny", action: "deny", prominent: false },
      ]
    case "yesNo":
      return [
        { label: "Yes", action: "yes", prominent: true },
        { label: "No", action: "no", prominent: false },
      ]
    case "choice":
      return (spec.options ?? []).slice(0, MAX_CHOICES).map((option) => ({ label: option.label, action: "choose", optionId: option.id, prominent: false }))
    default:
      return []
  }
}
