import { absenceText } from "@relo/notification-contracts"
import {
  notificationProject,
} from "@/features/inbox/notification-project"
import type { NotificationDetail, NotificationSummary } from "@/features/inbox/types"
import { displayName, displayNameOrNull, ENCRYPTED_TEXT } from "@/lib/encrypted"
import { SIGNALS, type NowMix, type Signal } from "@/lib/signal"

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
}

const OUTCOMES: Record<Exclude<OutcomeKind, "answered">, Outcome> = {
  running: { kind: "running", label: "Running", tone: "cyan" },
  done: { kind: "done", label: "Done", tone: "mint" },
  // The owner's words, as History's state filter says them: failed work failed; work that ended
  // without saying it was done or failed stopped.
  stopped: { kind: "stopped", label: "Failed", tone: "red" },
  expired: { kind: "expired", label: "Expired", tone: "yellow" },
  ended: { kind: "ended", label: "Stopped", tone: "yellow" },
  replaced: { kind: "replaced", label: "Replaced", tone: "yellow" },
  "needs-you": { kind: "needs-you", label: "Needs you", tone: "orange" },
  unanswered: { kind: "unanswered", label: "Missed", tone: "yellow" },
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

/** 754 -> "12:34", 4_330 -> "1:12:10". */
export function clockLabel(totalSeconds: number): string {
  const total = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const two = (value: number) => String(value).padStart(2, "0")
  return hours > 0 ? `${hours}:${two(minutes)}:${two(secs)}` : `${two(minutes)}:${two(secs)}`
}

/** "running 12:40" while active, "ran 4:12" once finished; null without a start. */
export function runtimeLabel(card: Pick<ActivityCard, "outcome" | "startedAt" | "endedAt">, now: number): string | null {
  if (!card.startedAt) return null
  const started = new Date(card.startedAt).valueOf()
  if (!Number.isFinite(started)) return null
  if (card.outcome.kind === "running") return `running ${clockLabel((now - started) / 1000)}`
  if (!card.endedAt) return null
  const ended = new Date(card.endedAt).valueOf()
  return Number.isFinite(ended) && ended >= started ? `ran ${clockLabel((ended - started) / 1000)}` : null
}

/**
 * Seconds of agent work today: for each card that started today, (endedAt ?? now) - startedAt.
 * A card that is not running and has no end contributes nothing, because its length is unknown.
 */
export function agentSecondsToday(
  cards: Array<Pick<ActivityCard, "outcome" | "startedAt" | "endedAt">>,
  now: Date
): number {
  const today = dayKey(now)
  let total = 0
  for (const card of cards) {
    if (!card.startedAt) continue
    const started = new Date(card.startedAt)
    if (!Number.isFinite(started.valueOf()) || dayKey(started) !== today) continue
    const end = card.endedAt ? new Date(card.endedAt).valueOf() : card.outcome.kind === "running" ? now.valueOf() : NaN
    const seconds = (end - started.valueOf()) / 1000
    if (Number.isFinite(seconds) && seconds > 0) total += seconds
  }
  return total
}

/** 15_120 -> "4h 12m"; under an hour "12m"; under a minute "0m". */
export function agentTimeLabel(totalSeconds: number): string {
  const minutes = Math.floor(Math.max(0, totalSeconds) / 60)
  const hours = Math.floor(minutes / 60)
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
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

/** "4 of 4 done · 6 updates" or "2 of 5 steps · 6 updates". */
export function metaLine(card: ActivityCard): string {
  const parts: string[] = []
  if (card.steps) {
    parts.push(
      card.steps.done >= card.steps.total
        ? `${card.steps.total} of ${card.steps.total} done`
        : card.steps.currentIndex
          ? `Step ${card.steps.currentIndex} of ${card.steps.total}`
          : `${card.steps.done} of ${card.steps.total} steps`
    )
  } else if (card.progress != null) {
    parts.push(`${Math.round(card.progress * 100)}%`)
  }
  if (card.updates != null) parts.push(`${card.updates} update${card.updates === 1 ? "" : "s"}`)
  return parts.join(" · ")
}

export type StepState = "done" | "current" | "pending" | "stopped"

/** The step bar: completed first, then the current step, then what is left. */
export function stepStates(card: ActivityCard): StepState[] {
  if (!card.steps) return []
  const { done, total } = card.steps
  const stopped = card.outcome.kind === "stopped"
  return Array.from({ length: total }, (_, index): StepState => {
    if (index < done) return "done"
    if (index === done) {
      if (stopped) return "stopped"
      if (card.outcome.kind === "running") return "current"
    }
    return "pending"
  })
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

/** "updated 5 min ago". */
export function updatedAgo(at: string | null, now: number): string {
  if (!at) return ""
  const ms = now - new Date(at).valueOf()
  if (!Number.isFinite(ms)) return ""
  const minutes = Math.floor(Math.max(ms, 0) / 60_000)
  if (minutes < 1) return "updated just now"
  if (minutes < 60) return `updated ${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `updated ${hours} h ago` : `updated ${Math.floor(hours / 24)} d ago`
}

export function needsYouCard(card: ActivityCard): boolean {
  return card.outcome.kind === "needs-you" || card.decision?.pending === true
}

/** "3 need you · 1 running · 2 done": how the day went, in the order that matters. */
export function daySummary(cards: ActivityCard[]): string {
  const counts: Array<[string, number]> = []
  const add = (label: string, count: number) => {
    if (count > 0) counts.push([label, count])
  }
  const kinds = (...wanted: OutcomeKind[]) =>
    cards.filter((card) => wanted.includes(card.outcome.kind)).length
  add("need you", cards.filter(needsYouCard).length)
  add("running", kinds("running"))
  add("done", kinds("done"))
  add("failed", kinds("stopped"))
  add("stopped", kinds("ended", "expired", "replaced"))
  add("missed", kinds("unanswered"))
  add(
    "answered",
    cards.filter(
      (card) =>
        card.outcome.kind === "answered" ||
        (card.decision != null && !card.decision.pending)
    ).length
  )
  const messages = kinds("message")
  add(messages === 1 ? "message" : "messages", messages)
  return counts.map(([label, count]) => `${count} ${label}`).join(" · ")
}

export type DayGroup = { key: string; label: string; cards: ActivityCard[] }

function dayKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

export function dayLabel(date: Date, now: Date): string {
  const today = dayKey(now)
  const yesterday = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
  const key = dayKey(date)
  if (key === today) return "Today"
  if (key === yesterday) return "Yesterday"
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  }).format(date)
}

/** Cards in the order given, split wherever the calendar day changes. */
export function groupByDay(cards: ActivityCard[], now = new Date()): DayGroup[] {
  const groups: DayGroup[] = []
  for (const card of cards) {
    const date = card.at ? new Date(card.at) : null
    const valid = date && Number.isFinite(date.valueOf())
    const key = valid ? dayKey(date) : "unknown"
    const last = groups.at(-1)
    if (last && last.key === key) last.cards.push(card)
    else groups.push({ key, label: valid ? dayLabel(date, now) : "Earlier", cards: [card] })
  }
  return groups
}

export type NowMetrics = {
  today: number
  done: number
  running: number
  needsYou: number
}

/** What the HUD counts. Today is the owner's local calendar day. */
export function nowMetrics(input: {
  cards: ActivityCard[]
  running: number
  needsYou: number
  now?: Date
}): NowMetrics {
  const now = input.now ?? new Date()
  const today = dayKey(now)
  const todays = input.cards.filter(
    (card) => card.at && Number.isFinite(new Date(card.at).valueOf()) && dayKey(new Date(card.at)) === today
  )
  return {
    today: todays.length,
    done: todays.filter((card) => card.outcome.kind === "done" || card.outcome.kind === "answered").length,
    running: input.running,
    needsYou: input.needsYou,
  }
}

export function nowSentence(metrics: Pick<NowMetrics, "running" | "needsYou"> & { today?: number }): string {
  if (metrics.needsYou > 0) {
    const waiting = metrics.needsYou === 1 ? "A request is waiting for your answer below" : "Requests are waiting for your answer below"
    return metrics.running > 0 ? `${waiting}, and work is still running.` : `${waiting}.`
  }
  if (metrics.running === 1) return "One task is running. Its progress is on the ring."
  if (metrics.running > 1) return `${metrics.running} tasks are running. Their progress is on the ring.`
  if (metrics.today === 0) return "New requests from your agents arrive here."
  return "All clear. Nothing needs you right now."
}

export function timeOfDay(value: string | null): string {
  if (!value) return ""
  const date = new Date(value)
  if (!Number.isFinite(date.valueOf())) return ""
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date)
}

export type TodayActivity = {
  totals: number[]
  done: number[]
  /** Each hour's items split by meaning. */
  mixes: Array<Partial<Record<Signal, number>>>
  currentHour: number
  maxTotal: number
  /** Today's finished cards, newest first (running and waiting cards have their own sections). */
  rows: ActivityCard[]
  /** Today's items counted by meaning, skipping meanings with none. */
  legend: Array<{ signal: Signal; count: number; text: string }>
}

const LEGEND_WORD: Record<Signal, (count: number) => string> = {
  done: () => "done",
  running: () => "running",
  needsYou: () => "waiting",
  attention: () => "to review",
  failed: () => "stopped",
  message: (count) => (count === 1 ? "message" : "messages"),
}

/** Hour-by-hour counts for the owner's local day, plus the day's finished cards, newest first. */
export function todayActivity(cards: ActivityCard[], now = new Date()): TodayActivity {
  const totals = Array<number>(24).fill(0)
  const done = Array<number>(24).fill(0)
  const mixes = Array.from({ length: 24 }, (): Partial<Record<Signal, number>> => ({}))
  const counts: Partial<Record<Signal, number>> = {}
  const rows = cards
    .filter((card) => finishedCard(card) && isToday(card, now))
    .sort((a, b) => new Date(b.at!).valueOf() - new Date(a.at!).valueOf())
  for (const card of rows) {
    const hour = new Date(card.at!).getHours()
    const signal = signalOf(card)
    totals[hour]! += 1
    if (card.outcome.kind === "done" || card.outcome.kind === "answered") done[hour]! += 1
    mixes[hour]![signal] = (mixes[hour]![signal] ?? 0) + 1
    counts[signal] = (counts[signal] ?? 0) + 1
  }
  const legend = SIGNALS.flatMap((signal) => {
    const count = counts[signal] ?? 0
    return count > 0 ? [{ signal, count, text: `${count} ${LEGEND_WORD[signal](count)}` }] : []
  })
  return { totals, done, mixes, currentHour: now.getHours(), maxTotal: Math.max(0, ...totals), rows, legend }
}

/** "DONE · 33M · 6 UPDATES", or the source when the card has nothing to say about how it ended. */
export function logDetail(card: ActivityCard): string {
  const parts = [card.outcome.label ?? card.source]
  const minutes = card.duration == null ? null : card.duration
  if (minutes != null) {
    const value = Math.round(minutes)
    parts.push(value < 60 ? `${Math.max(value, 1)}S` : value < 3600 ? `${Math.floor(value / 60)}M` : `${Math.floor(value / 3600)}H ${Math.floor((value % 3600) / 60)}M`)
  }
  if (card.updates && card.updates > 0) parts.push(`${card.updates} UPDATES`)
  return parts.join(" · ").toUpperCase()
}

/** Live work keeps a holo card in History: it is running or waiting on the owner. */
export function isLiveCard(card: ActivityCard): boolean {
  return card.outcome.kind === "running" || needsYouCard(card)
}

/**
 * The one line under a settled History row's title: what was decided, else the summary, else what
 * the card's metadata says ("All 4 steps · 6 updates · ran 4:12"). Null when there is nothing to say.
 */
export function historyLine(card: ActivityCard): string | null {
  if (card.decision && !card.decision.pending) {
    const answer = card.decision.answer + (card.decision.at ? ` ${timeOfDay(card.decision.at)}` : "")
    return card.summary ? `${answer} · ${card.summary}` : answer
  }
  if (card.summary) return card.summary
  const parts = [metaLine(card), runtimeLabel(card, 0)].filter(Boolean)
  return parts.length ? parts.join(" · ") : null
}

export type HistorySegment =
  | { kind: "live"; card: ActivityCard }
  | { kind: "settled"; cards: ActivityCard[] }

/** A day's cards in order: runs of settled cards become one list, each live card stands alone. */
export function historySegments(cards: ActivityCard[]): HistorySegment[] {
  const segments: HistorySegment[] = []
  for (const card of cards) {
    if (isLiveCard(card)) {
      segments.push({ kind: "live", card })
      continue
    }
    const last = segments.at(-1)
    if (last?.kind === "settled") last.cards.push(card)
    else segments.push({ kind: "settled", cards: [card] })
  }
  return segments
}

/** The detail page's title: the work's own title, or a plain word when it is sealed. */
export function detailTitle(detail: NotificationDetail): string {
  const encrypted = detail.notification.encrypted === true || detail.activity?.encrypted === true
  if (encrypted) return detail.activity ? "Encrypted activity" : "Encrypted message"
  return displayName(detail.activity?.context.taskTitle ?? detail.notification.title)
}
