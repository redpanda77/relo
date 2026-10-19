import { ArrowRight, MessageSquareText, X } from "lucide-react"

import { EncryptedText } from "@/components/atoms/encrypted-text"
import { Strip } from "@/components/card"
import { WorkCard } from "@/components/organisms/work-card"
import {
  elapsedLabel,
  isLiveCard,
  needsYouCard,
  projectColor,
  timeOfDay,
  type ActivityCard,
  type Tone,
} from "@/features/inbox/activity-model"
import { OUTCOME_ICON, TYPE_ICON } from "@/features/inbox/outcome-icons"
import { stepsCaption, type WorkTone } from "@/lib/work-outcome"

/** A question asked on a card, and what became of it (iOS HistoryRowView.decisionStrip). */
export function DecisionStrip({ card }: { card: ActivityCard }) {
  const decision = card.decision
  if (!decision) return null
  const tone = decision.pending ? "orange" : decision.declined ? "yellow" : "mint"
  return (
    <Strip tone={tone}>
      {decision.encrypted ? (
        <EncryptedText className="text-foreground/90" />
      ) : (
        <span className="min-w-0 [overflow-wrap:anywhere]">{decision.prompt}</span>
      )}{" "}
      <ArrowRight className="inline size-3 shrink-0 text-muted-foreground" aria-hidden="true" />{" "}
      <span className="font-semibold" style={{ color: "color-mix(in srgb, var(--tone) 80%, white)" }}>
        {decision.answer}
        {decision.at ? <span className="font-normal text-muted-foreground tabular-nums"> · {timeOfDay(decision.at)}</span> : null}
      </span>
    </Strip>
  )
}

/** The card model's tones as the work card's: a message (violet) reads as secondary, as on iOS. */
function workTone(tone: Tone): WorkTone {
  switch (tone) {
    case "cyan":
    case "mint":
    case "orange":
    case "yellow":
    case "red":
      return tone
    default:
      return "neutral"
  }
}

/** iOS HistoryRowView.duration: "under a minute", "33 min", "1 h 12 min". */
function tookLabel(seconds: number | null): string | null {
  if (seconds == null) return null
  return seconds < 60 ? "under a minute" : elapsedLabel(seconds)
}

/**
 * One History item as the shared work card (iOS HistoryRowView): live work (running, needs you) is a
 * framed `live` card; everything settled is a `row` inside its day's CardList. Its origin omits what
 * a filter already pins (`showSource`, `showProject`), as the iPhone does.
 */
export function HistoryWorkCard({
  card,
  onOpen,
  open = false,
  showSource = true,
  showProject = true,
}: {
  card: ActivityCard
  onOpen: () => void
  open?: boolean
  showSource?: boolean
  showProject?: boolean
}) {
  const live = isLiveCard(card)
  const running = card.outcome.kind === "running"
  const finished = card.outcome.kind === "done"
  const declined = card.outcome.kind === "answered" && card.outcome.tone === "yellow"
  const state = card.outcome.label
    ? { label: card.outcome.label, icon: declined ? X : OUTCOME_ICON[card.outcome.kind] }
    : { label: card.type, icon: TYPE_ICON[card.type] ?? MessageSquareText }
  // What it amounted to; the type closes it only when the state already said how it ended.
  const facts = [
    card.absenceLine,
    tookLabel(card.duration),
    card.outcome.label && card.type !== "Live Activity" ? card.type : null,
  ].filter((fact): fact is string => Boolean(fact))
  const project = showProject ? card.project : null
  return (
    <WorkCard
      variant={live ? "live" : "row"}
      tone={workTone(card.outcome.tone)}
      title={card.title}
      encrypted={card.encrypted}
      origin={{
        source: card.source,
        project: project?.name ?? null,
        projectColor: project ? projectColor(project.slot) : null,
        topic: card.topic,
        showSource,
      }}
      summary={card.summary}
      extra={card.decision ? <DecisionStrip card={card} /> : null}
      meter={
        card.steps || card.progress != null
          ? {
              steps: card.steps,
              progress: card.progress,
              live: running,
              finished,
              caption: card.steps ? stepsCaption(card.steps, { finished }) : card.progress != null ? `${Math.round(card.progress * 100)}%` : null,
            }
          : null
      }
      state={state}
      facts={facts}
      runningSince={running ? card.startedAt : null}
      at={card.at}
      computer={card.origin}
      tint={live && needsYouCard(card)}
      live={running}
      onOpen={onOpen}
      open={open}
      attrs={{ "data-outcome": card.outcome.kind, "data-unread": card.unread ? "true" : undefined }}
    />
  )
}
