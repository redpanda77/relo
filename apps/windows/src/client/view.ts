// Pure mappings from the owner client's state to what the views and the tray take.

import type { NowSummary } from "@relo/notification-contracts"
import type { AnswerPhase as ClientAnswerPhase, OwnerState, Question } from "@relo/owner-client"
import type { AnswerPhase, QuestionSpec } from "../relo/answers"
import type { TrayState } from "../bridge"
import { presentationOf, workingSessionsWithoutCards, type Presentation, type Row, type SectionKind, type SpokenWords, type SpokenWordsById } from "../relo/presentation"
import { detailFrom } from "../voice/spokenLine"

/** What the server writes in place of a question it sealed, when this PC could not open it (owner-client keeps the same list). */
const PROMPT_PLACEHOLDERS = new Set(["Private notification", "Open Relo on your iPhone to read this question.", "Encrypted question", "Open Relo on your iPhone to read this."])

function specOf(question: Question): QuestionSpec | null {
  // A question this PC could not read is not answered blind: the card says to approve this PC first.
  if (PROMPT_PLACEHOLDERS.has(question.prompt)) return null
  const kind = question.kind === "yes_no" ? "yesNo" : question.kind
  return { kind, prompt: question.prompt, ...(question.options.length ? { options: question.options } : {}) }
}

/** Question kinds and options by interaction id (what the views key them by). */
export function questionSpecs(state: Pick<OwnerState, "questions">): Record<string, QuestionSpec> {
  const specs: Record<string, QuestionSpec> = {}
  for (const question of Object.values(state.questions)) {
    const spec = specOf(question)
    if (spec) specs[question.interactionId] = spec
  }
  return specs
}

/** The notification a pending question hangs on, by interaction id. */
export function notificationsByInteraction(summary: NowSummary | null): Map<string, string> {
  const map = new Map<string, string>()
  if (!summary) return map
  for (const item of [...summary.needsYou, ...summary.recent, ...summary.waitingOnYou, ...summary.running, ...summary.quiet, ...summary.paused]) {
    if (item.question && item.notificationId) map.set(item.question.id, item.notificationId)
  }
  return map
}

function phaseOf(phase: ClientAnswerPhase): AnswerPhase {
  switch (phase.phase) {
    case "sending":
      return { state: "sending" }
    case "accepted":
      return { state: "accepted" }
    case "failed":
      return { state: "failed", message: phase.message }
  }
}

/** Where each answer stands, by interaction id. */
export function answerPhases(state: Pick<OwnerState, "answers" | "summary">): Record<string, AnswerPhase> {
  const byNotification = new Map([...notificationsByInteraction(state.summary)].map(([interaction, notification]) => [notification, interaction]))
  const phases: Record<string, AnswerPhase> = {}
  for (const [notificationId, phase] of Object.entries(state.answers)) {
    const interaction = byNotification.get(notificationId)
    if (interaction) phases[interaction] = phaseOf(phase)
  }
  return phases
}

/**
 * Whether a trusted device (the iPhone) approved this PC's keys: "approved"; "waiting" when a trusted phone exists and
 * has not (the Mac's "Approve this Mac on your iPhone"); null when signed out, unknown, or there is no phone to ask.
 */
export function approvalOf(state: Pick<OwnerState, "connection" | "deviceTrusted" | "phoneReceivesPushes">): "waiting" | "approved" | null {
  if (state.connection !== "live" && state.connection !== "offline" && state.connection !== "connecting") return null
  if (state.deviceTrusted === true) return "approved"
  if (state.deviceTrusted === false && state.phoneReceivesPushes === true) return "waiting"
  return null
}

/**
 * The tray's picture of the connection and what the menu says (ReloMenuItems.swift): the counts and first title are the
 * notch's own (`presentationOf`: needsYouCount, the first needs-you row, running cards plus working sessions without a
 * card), the account and whether a server address exists.
 */
export function trayStateOf(
  state: Pick<OwnerState, "connection" | "summary"> & Partial<Pick<OwnerState, "serverOrigin" | "accountEmail">>,
  paused: boolean,
): TrayState {
  const status: TrayState["status"] =
    state.connection === "live" ? "live"
    : state.connection === "offline" ? "offline"
    : state.connection === "starting" || state.connection === "connecting" ? "starting"
    : "signedOut"
  const presentation = presentationOf(state.summary)
  const rows = (kind: SectionKind) => presentation.sections.find((section) => section.kind === kind)?.rows ?? []
  const first = rows("needsYou")[0]?.title?.trim()
  return {
    status,
    needsYou: presentation.needsYouCount,
    running: rows("running").length + workingSessionsWithoutCards(presentation),
    paused,
    hasOrigin: Boolean(state.serverOrigin),
    firstTitle: first ? first : null,
    email: state.accountEmail ?? null,
    connecting: state.connection === "connecting",
  }
}

// --- What a card says aloud (ADR 0015) ---------------------------------------------------------------------------------
// The CLI seals three optional keys in a card's text (packages/cli/src/work/spoken.mjs, crypto/seal-work.mjs workCardText):
// `spoken` (the gist of a deliver or finish), `name` (how the work is called aloud) and `voice` (off|brief|full|verbose).
// A Now item's strict schema has no field for them, so ownerCrypto keeps them aside, by card id, as it opens each card.

const present = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null)

/** The spoken words of an opened card's text (Mac `ReloNotchStore.spokenLines`); null when it carries none. */
export function spokenWordsOf(content: unknown): SpokenWords | null {
  if (typeof content !== "object" || content === null) return null
  const text = content as Record<string, unknown>
  const words: SpokenWords = { spoken: present(text.spoken), name: present(text.name), voice: detailFrom(typeof text.voice === "string" ? text.voice : null) }
  return words.spoken !== null || words.name !== null || words.voice !== null ? words : null
}

/** `presentation` with each row's spoken fields filled from `words` (by card id); the same object when there is nothing to add. */
export function withSpoken(presentation: Presentation, words: SpokenWordsById | undefined | null): Presentation {
  if (!words || Object.keys(words).length === 0) return presentation
  const fill = (row: Row): Row => {
    const found = words[row.id]
    return found ? { ...row, spoken: found.spoken, spokenName: found.name, spokenVoice: found.voice } : row
  }
  return {
    ...presentation,
    focus: presentation.focus ? fill(presentation.focus) : null,
    sections: presentation.sections.map((section) => ({ ...section, rows: section.rows.map(fill) })),
  }
}
