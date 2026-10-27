import { absenceText, HISTORY_OUTCOME_LABELS } from "@relo/notification-contracts"
import {
  notificationProject,
} from "@/features/inbox/notification-project"
import type { NotificationDetail, NotificationSummary } from "@/features/inbox/types"
import { displayName, displayNameOrNull, ENCRYPTED_TEXT } from "@/lib/encrypted"
import type { NowMix, Signal } from "@/lib/signal"

/** The neon tones of the app. Meaning, not decoration: each one is a state. */
export type Tone =
  | "cyan"
  | "violet"
  | "magenta"
  | "coral"
  | "mint"
  | "orange"
  | "yellow"
  | "red"
  | "neutral"

export type OutcomeKind =
  | "running"
  | "done"
  | "stopped"
  | "expired"
  | "ended"
  | "replaced"
  | "needs-you"
  | "answered"
  | "unanswered"
  | "message"

export type Outcome = {
  kind: OutcomeKind
  /** null for a plain message: there is nothing to say about how it ended. */
  label: string | null
  tone: Tone
}

/** `currentIndex` (from 1) and `fill` (0...1) are the server's, from the card's plan wire; absent on an older card. */
export type CardSteps = { done: number; total: number; current: string | null; currentIndex?: number; fill?: number }

export type Decision = {
  prompt: string
  /** The prompt is sealed end to end: prompt holds the "open on iPhone" text. */
  encrypted: boolean
  answer: string
  pending: boolean
  declined: boolean
  at: string | null
}

export type ActivityCard = {
  id: string
  /**
   * Sealed end to end (ADR 0005): the Dashboard has no key, so title says "open on iPhone" and
   * summary is empty. Metadata (time, state, steps count, source) still shows.
   */
  encrypted: boolean
  source: string
  project: { name: string; slot: number } | null
  topic: string | null
  type: string
  title: string
  summary: string | null
  outcome: Outcome
  at: string | null
  startedAt: string | null
  endedAt: string | null
  /** "computer · account", whichever exist. */
  origin: string | null
  /** Why the work left the screen or dimmed, in the server's reason (owner words); null when it needs none. */
  absenceLine: string | null
  /** Seconds, only when the card has both a start and an end. */
  duration: number | null
  updates: number | null
  steps: CardSteps | null
  progress: number | null
  decision: Decision | null
  unread: boolean
  /** It carries a link the owner can open (a validated destination). */
  link: boolean
}

/** History's words for how a row ended (history.ts, the iPhone's HistoryRow.Outcome.label). */
const OUTCOMES: Record<Exclude<OutcomeKind, "answered">, Outcome> = {
  running: { kind: "running", label: HISTORY_OUTCOME_LABELS.running, tone: "cyan" },
  done: { kind: "done", label: HISTORY_OUTCOME_LABELS.done, tone: "mint" },
  // Failed work stopped; work that ended without saying it was done or failed ended.
  stopped: { kind: "stopped", label: HISTORY_OUTCOME_LABELS.stopped, tone: "red" },
  expired: { kind: "expired", label: HISTORY_OUTCOME_LABELS.expired, tone: "yellow" },
  ended: { kind: "ended", label: HISTORY_OUTCOME_LABELS.ended, tone: "yellow" },
  replaced: { kind: "replaced", label: HISTORY_OUTCOME_LABELS.replaced, tone: "yellow" },
  "needs-you": { kind: "needs-you", label: HISTORY_OUTCOME_LABELS["needs-you"], tone: "orange" },
  unanswered: { kind: "unanswered", label: HISTORY_OUTCOME_LABELS.unanswered, tone: "yellow" },
  message: { kind: "message", label: null, tone: "violet" },
}

const ANSWERS: Record<string, { label: string; decision: string; declined: boolean }> = {
  approved: { label: "Approved", decision: "You approved", declined: false },
  denied: { label: "Declined", decision: "You declined", declined: true },
  yes: { label: "Yes", decision: "You said yes", declined: false },
  no: { label: "No", decision: "You said no", declined: true },
  replied: { label: "Replied", decision: "You replied", declined: false },
  responded: { label: "Answered", decision: "You answered", declined: false },
  canceled: { label: "Withdrawn", decision: "Withdrawn", declined: false },
}

function isPending(state: string, expiresAt: string | null, now: number) {
  if (state !== "pending") return false
  return !expiresAt || new Date(expiresAt).valueOf() > now
}

export function answerOutcome(state: string, expiresAt: string | null, now: number): Outcome {
  if (isPending(state, expiresAt, now)) return OUTCOMES["needs-you"]
  if (state === "pending" || state === "expired") return OUTCOMES.unanswered
  const answer = ANSWERS[state]
  if (!answer) return OUTCOMES.unanswered
  return {
    kind: "answered",
    label: answer.label,
    tone: answer.declined ? "yellow" : "mint",
  }
}

export function activityOutcome(state: string, outcome: string | null | undefined): Outcome {
  switch (state) {
    case "active":
      return OUTCOMES.running
    case "expired":
      return OUTCOMES.expired
    case "replaced":
      return OUTCOMES.replaced
    default:
      return outcome === "completed"
        ? OUTCOMES.done
        : outcome === "failed"
          ? OUTCOMES.stopped
          : OUTCOMES.ended
  }
}

export function typeLabel(kind: string, questionKind: string | null): string {
  if (questionKind) {
    if (questionKind === "approval") return "Approval"
    if (questionKind === "choice") return "Choice"
    if (/yes|no/.test(questionKind)) return "Question"
    return "Reply request"
  }
  if (kind === "live_activity") return "Live Activity"
  if (kind === "response") return "Response"
  return "Message"
}

function decisionFor(
  question: NonNullable<NotificationSummary["question"]>,
  now: number,
  sealed = false
): Decision {
  const pending = isPending(question.state, question.expiresAt, now)
  const known = ANSWERS[question.state]
  const encrypted = sealed || question.encrypted === true
  return {
    prompt: encrypted ? ENCRYPTED_TEXT : question.prompt,
    encrypted,
    answer: pending
      ? "Waiting for you"
      : question.chosenLabel
        ? `You chose ${question.chosenLabel}`
        : known
          ? known.decision
          : "No answer in time",
    pending,
    declined: pending ? false : (known?.declined ?? true),
    at: question.respondedAt,
  }
}

/**
 * A name worth showing: a sealed name this browser has not learned ("Encrypted topic") tells the
 * owner nothing, so identity lines omit it instead.
 */
export function knownName(value: string | null | undefined): string | null {
  const name = displayNameOrNull(value)
  return name && !SEALED_NAMES.has(name) ? name : null
}

/** What `displayName` says for a sealed name it has not learned (lib/encrypted.ts). */
const SEALED_NAMES = new Set(["project", "topic", "task", "computer", "account"].map((part) => `Encrypted ${part}`))

function seconds(from: string | null, to: string | null): number | null {
  if (!from || !to) return null
  const value = (new Date(to).valueOf() - new Date(from).valueOf()) / 1000
  return Number.isFinite(value) && value >= 0 ? value : null
}

function sameText(left: string, right: string) {
  return left.trim().toLowerCase() === right.trim().toLowerCase()
}

export function cardFor(notification: NotificationSummary, now = Date.now()): ActivityCard {
  const { activity, question } = notification
  const isCard = notification.kind === "live_activity"
  const context = activity?.context ?? notification.context
  const encrypted = notification.encrypted === true || activity?.encrypted === true
  const readableTitle = displayName(context.taskTitle ?? activity?.title ?? notification.title)
  const title = encrypted ? ENCRYPTED_TEXT : readableTitle
  // A card's own state wins; a plain question or message is described by its answer.
  const outcome: Outcome = isCard
    ? activity
      ? activityOutcome(activity.state, activity.outcome)
      : notification.state === "active"
        ? OUTCOMES.running
        : OUTCOMES.ended
    : question
      ? answerOutcome(question.state, question.expiresAt, now)
      : OUTCOMES.message

  const project = notificationProject(notification)
  const palette = notification.resources?.project.palette.slot
  const steps = activity?.steps && activity.steps.total > 0
    ? encrypted ? { ...activity.steps, current: null } : activity.steps
    : null
  const status = activity?.status?.trim() || null
  const body = notification.body.trim()
  const summary = encrypted
    ? null
    : (isCard ? status : null) ??
      (question?.encrypted ? ENCRYPTED_TEXT : question?.prompt) ??
      (body && !sameText(body, title) ? body : null)
  const topic = knownName(context.threadName)
  const projectName = project.direct ? null : knownName(project.name)

  return {
    id: notification.id,
    encrypted,
    source: notification.source,
    project: projectName ? { name: projectName, slot: palette ?? hashSlot(projectName) } : null,
    topic: topic && !sameText(topic, title) ? topic : null,
    type: typeLabel(notification.kind, isCard ? null : (question?.kind ?? null)),
    title,
    summary: summary && !sameText(summary, title) ? summary : null,
    outcome,
    at: activity?.updatedAt ?? notification.createdAt,
    startedAt: activity?.createdAt ?? null,
    endedAt: activity?.endedAt ?? null,
    origin: originLabel(context),
    absenceLine: activity?.absence ? absenceText(activity.absence, { computer: context.computer }) : null,
    duration: seconds(activity?.createdAt ?? null, activity?.endedAt ?? null),
    updates: activity?.updates ?? null,
    steps,
    progress: steps ? null : (activity?.progress ?? null),
    decision: isCard && question ? decisionFor(question, now, encrypted) : null,
    unread: !notification.readAt && !notification.withdrawnAt,
    link: notification.destination?.state === "safe",
  }
}

/** The accessible name of a card's open control; a sealed card never names its placeholder. */
export function openLabel(card: Pick<ActivityCard, "encrypted" | "title">): string {
  return card.encrypted ? "Open encrypted item" : `Open ${card.title}`
}

/** "MacBook · work": which computer and which agent account a card came from. */
export function originLabel(context: { computer?: string | null; account?: string | null }): string | null {
  const parts = [context.computer, context.account].map(knownName).filter(Boolean)
  return parts.length ? parts.join(" · ") : null
}

export function hashSlot(value: string): number {
  let hash = 0
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return hash % 12
}

/** Twelve project hues along the neon ramp so a project keeps one colour everywhere. */
export { projectColor } from "@/lib/project-palette"

export function elapsedLabel(totalSeconds: number | null): string | null {
  if (totalSeconds == null) return null
  const minutes = Math.round(totalSeconds / 60)
  if (totalSeconds < 60) return `${Math.max(1, Math.round(totalSeconds))} sec`
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} h ${rest} min` : `${hours} h`
}

/** What a card means; every color on the page comes from this (NowSignal.of). */
export function signalOf(card: Pick<ActivityCard, "outcome">): Signal {
  switch (card.outcome.kind) {
    case "done":
      return "done"
    case "running":
      return "running"
    case "needs-you":
      return "needsYou"
    case "stopped":
      return "failed"
    case "expired":
    case "ended":
    case "replaced":
    case "unanswered":
      return "attention"
    case "answered":
      return card.outcome.label === "Declined" || card.outcome.label === "No" ? "attention" : "done"
    case "message":
      return "message"
  }
}

const finishedCard = (card: ActivityCard) => card.outcome.kind !== "running" && card.outcome.kind !== "needs-you"

function isToday(card: ActivityCard, now: Date) {
  if (!card.at) return false
  const date = new Date(card.at)
  return Number.isFinite(date.valueOf()) && dayKey(date) === dayKey(now)
}

/** Today's finished rows by meaning, plus what needs the owner and what is running right now. */
export function nowMix(input: { cards: ActivityCard[]; running: number; needsYou: number; now?: Date }): NowMix {
  const now = input.now ?? new Date()
  const mix: NowMix = {}
  for (const card of input.cards) {
    if (!finishedCard(card) || !isToday(card, now)) continue
    const signal = signalOf(card)
    mix[signal] = (mix[signal] ?? 0) + 1
  }
  if (input.needsYou > 0) mix.needsYou = (mix.needsYou ?? 0) + input.needsYou
  if (input.running > 0) mix.running = (mix.running ?? 0) + input.running
  return mix
}

function dayKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

export function timeOfDay(value: string | null): string {
  if (!value) return ""
  const date = new Date(value)
  if (!Number.isFinite(date.valueOf())) return ""
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date)
}

/** The detail page's title: the work's own title, or a plain word when it is sealed. */
export function detailTitle(detail: NotificationDetail): string {
  const encrypted = detail.notification.encrypted === true || detail.activity?.encrypted === true
  if (encrypted) return detail.activity ? "Encrypted activity" : "Encrypted message"
  return displayName(detail.activity?.context.taskTitle ?? detail.notification.title)
}
