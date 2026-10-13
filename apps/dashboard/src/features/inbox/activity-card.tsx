import {
  ArrowRight,
  BellRing,
  Check,
  CircleDashed,
  Clock,
  Laptop,
  Minus,
  Radio,
  Replace,
  Square,
  X,
} from "lucide-react"
import type * as React from "react"

import {
  metaLine,
  openLabel,
  projectColor,
  runtimeLabel,
  stepStates,
  timeOfDay,
  type ActivityCard,
  type Outcome,
  type OutcomeKind,
} from "@/features/inbox/activity-model"
import { EncryptedText } from "@/components/atoms/encrypted-text"
import { useTicker } from "@/lib/ticker"
import { cn } from "@/lib/utils"

const OUTCOME_ICON: Record<OutcomeKind, React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>> = {
  running: Radio,
  done: Check,
  stopped: Square,
  expired: Clock,
  ended: CircleDashed,
  replaced: Replace,
  "needs-you": BellRing,
  answered: Check,
  unanswered: Minus,
  message: CircleDashed,
}

/** Outcome as an icon, a word and a tone: colour is never the only cue. */
export function OutcomeBadge({ outcome, declined = false }: { outcome: Outcome; declined?: boolean }) {
  if (!outcome.label) return null
  const Icon = declined ? X : OUTCOME_ICON[outcome.kind]
  return (
    <span className={cn("outcome-badge", `tone-${outcome.tone}`)} data-outcome={outcome.kind}>
      <Icon aria-hidden="true" />
      {outcome.label}
    </span>
  )
}

export function StepBar({ card, className }: { card: ActivityCard; className?: string }) {
  const states = stepStates(card)
  if (!states.length) return null
  return (
    <div
      className={cn("step-bar", className)}
      role="img"
      aria-label={`${card.steps!.done} of ${card.steps!.total} steps complete`}
    >
      {states.map((state, index) => (
        <span key={index} data-step={state} />
      ))}
    </div>
  )
}

/** "source · PROJECT › topic": the project wears its own colour. */
export function IdentityLine({ card, className }: { card: ActivityCard; className?: string }) {
  const label = [card.source, card.project?.name, card.topic].filter(Boolean).join(" › ")
  return (
    <span className={cn("micro flex min-w-0 items-center gap-1.5", className)} aria-label={label}>
      <span className="truncate" data-part="source">{card.source}</span>
      {card.project ? (
        <>
          <span aria-hidden="true">·</span>
          <span
            className="truncate"
            data-part="project"
            style={{ color: projectColor(card.project.slot) }}
          >
            {card.project.name}
          </span>
        </>
      ) : null}
      {card.topic ? (
        <>
          <span aria-hidden="true">›</span>
          <span className="truncate normal-case tracking-normal" data-part="topic">{card.topic}</span>
        </>
      ) : null}
    </span>
  )
}

/** Which computer and which agent account the card came from; nothing when neither is known. */
export function OriginMeta({ card, className }: { card: Pick<ActivityCard, "origin">; className?: string }) {
  if (!card.origin) return null
  return (
    <span className={cn("micro inline-flex min-w-0 items-center gap-1 normal-case tracking-wide", className)} data-part="origin">
      <Laptop className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{card.origin}</span>
    </span>
  )
}

/** "running 12:40" ticking once a second off the shared page clock, or "ran 4:12" when finished. */
export function RuntimeClock({ card, className }: { card: ActivityCard; className?: string }) {
  const live = card.outcome.kind === "running"
  const now = useTicker(live)
  const label = runtimeLabel(card, live ? now : 0)
  if (!label) return null
  return <span className={cn("micro tabular-nums normal-case tracking-wide", className)} data-part="runtime">{label}</span>
}

/** A question asked on a card, and what became of it. */
export function DecisionStrip({ card }: { card: ActivityCard }) {
  const decision = card.decision
  if (!decision) return null
  const tone = decision.pending ? "orange" : decision.declined ? "yellow" : "mint"
  return (
    <div
      className={cn(
        "tone-" + tone,
        "flex min-w-0 items-center gap-2 rounded-xl border px-3 py-2 text-xs",
        "border-[color-mix(in_srgb,var(--tone)_26%,transparent)] bg-[color-mix(in_srgb,var(--tone)_9%,transparent)]"
      )}
    >
      {decision.encrypted ? (
        <EncryptedText className="text-foreground/90" />
      ) : (
        <span className="min-w-0 truncate text-foreground/90">{decision.prompt}</span>
      )}
      <ArrowRight className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="shrink-0 font-medium" style={{ color: "color-mix(in srgb, var(--tone) 80%, white)" }}>
        {decision.answer}
        {decision.at ? ` · ${timeOfDay(decision.at)}` : ""}
      </span>
    </div>
  )
}

function Body({ card }: { card: ActivityCard }) {
  const meta = metaLine(card)
  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <IdentityLine card={card} className="flex-1" />
        <span className="flex shrink-0 items-center gap-2">
          {card.unread ? (
            <span className="ink-dot tone-violet" aria-label="Unread" role="img" />
          ) : null}
          <RuntimeClock card={card} />
          <time className="micro" dateTime={card.at ?? undefined}>{timeOfDay(card.at)}</time>
        </span>
      </div>
      {card.origin ? <OriginMeta card={card} className="mt-1 max-w-full" /> : null}
      <div className="mt-2 flex min-w-0 items-start justify-between gap-3">
        <h3 className="min-w-0 text-[15px] leading-snug font-medium text-foreground [overflow-wrap:anywhere]">
          {card.encrypted ? <EncryptedText className="text-muted-foreground" /> : card.title}
        </h3>
        <OutcomeBadge outcome={card.outcome} />
      </div>
      {card.summary ? (
        <p className="mt-1 line-clamp-2 text-[13px] leading-5 text-muted-foreground">{card.summary}</p>
      ) : null}
      {card.steps ? <StepBar card={card} className="mt-3" /> : null}
      {card.progress != null ? (
        <div
          className="mt-3 h-1 overflow-hidden rounded-full bg-white/10"
          role="progressbar"
          aria-label="Progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(card.progress * 100)}
        >
          <div className="h-full rounded-full" style={{ width: `${Math.round(card.progress * 100)}%`, background: "var(--tone, var(--neon-cyan))" }} />
        </div>
      ) : null}
      {meta || card.type ? (
        <div className="mt-2.5 flex items-center justify-between gap-3">
          <span className="micro tracking-wide normal-case">{meta}</span>
          <span className="micro shrink-0">{card.type}</span>
        </div>
      ) : null}
      {card.decision ? (
        <div className="mt-3">
          <DecisionStrip card={card} />
        </div>
      ) : null}
    </>
  )
}

/** One history row, full width. A card's events have already collapsed into its latest. */
export function ActivityCardRow({
  card,
  onOpen,
}: {
  card: ActivityCard
  onOpen?: () => void
  /** Unused: timers read the shared page clock. Kept so callers need not change. */
  now?: number
}) {
  const cls = cn(
    "holo-card block w-full p-4 text-left",
    `tone-${card.outcome.tone}`
  )
  return (
    <li>
      {onOpen ? (
        <div
          role="button"
          tabIndex={0}
          onClick={onOpen}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault()
              onOpen()
            }
          }}
          aria-label={openLabel(card)}
          className={cn(cls, "cursor-pointer")}
          data-live={card.outcome.kind === "running" || card.outcome.kind === "needs-you"}
        >
          <Body card={card} />
        </div>
      ) : (
        <div className={cls}>
          <Body card={card} />
        </div>
      )}
    </li>
  )
}
