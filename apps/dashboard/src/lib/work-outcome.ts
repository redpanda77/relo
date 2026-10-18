import type { NeedsYouReason, OwnerState } from "@relo/notification-contracts"
import {
  AlarmClockOff,
  AudioWaveform,
  Check,
  CirclePause,
  Hand,
  MessageCircleQuestion,
  MessageSquareReply,
  Moon,
  OctagonX,
  Pause,
  ShieldAlert,
  Square,
  TriangleAlert,
  WifiOff,
  type LucideIcon,
} from "lucide-react"

/**
 * How a work stands, in words, a meaning colour and an icon: the one table for Now, History and the
 * detail page. Labels copy the iPhone's `HistoryServerOutcome.make` (HistoryRowView.swift) in
 * sentence case; nothing here decides a state, it only names the one the server derived.
 */

/** A card's meaning colour. `cyanQuiet` is running work that is quiet (cyan at 70%). */
export type WorkTone = "cyan" | "cyanQuiet" | "yellow" | "orange" | "mint" | "red" | "neutral"

export type WorkOutcome = { label: string; tone: WorkTone; icon: LucideIcon }

/** The CSS class that sets `--tone` for a tone (index.css `.tone-*`; now.css `.tone-cyan-quiet`). */
export function toneClass(tone: WorkTone): string {
  return tone === "cyanQuiet" ? "tone-cyan-quiet" : `tone-${tone}`
}

/** The tone as a CSS colour, for inline styles (a glyph, a count). */
export const WORK_TONE_CSS: Record<WorkTone, string> = {
  cyan: "var(--neon-cyan)",
  cyanQuiet: "color-mix(in srgb, var(--neon-cyan) 70%, transparent)",
  yellow: "var(--neon-yellow)",
  orange: "var(--neon-orange)",
  mint: "var(--neon-mint)",
  red: "var(--neon-red)",
  neutral: "#8d93a8",
}

const OUTCOMES: Record<OwnerState, WorkOutcome> = {
  needs_you: { label: "Needs you", tone: "orange", icon: MessageCircleQuestion },
  failed: { label: "Failed", tone: "red", icon: OctagonX },
  done: { label: "Done", tone: "mint", icon: Check },
  dropped: { label: "Dropped", tone: "yellow", icon: Square },
  left_unfinished: { label: "Left unfinished", tone: "yellow", icon: TriangleAlert },
  paused: { label: "Paused", tone: "neutral", icon: Pause },
  waiting_on_you: { label: "Your turn", tone: "yellow", icon: Hand },
  moving: { label: "Running", tone: "cyan", icon: AudioWaveform },
  working_quietly: { label: "Working quietly", tone: "cyanQuiet", icon: AudioWaveform },
  stopped_responding: { label: "Stopped responding", tone: "neutral", icon: CirclePause },
  no_signal: { label: "No signal", tone: "neutral", icon: WifiOff },
  stale: { label: "Quiet", tone: "neutral", icon: Moon },
}

/** Why a work needs the owner, as its own word (Now's needs-you cards). */
const NEEDS_YOU: Record<NeedsYouReason, WorkOutcome> = {
  question: { label: "Question", tone: "orange", icon: MessageCircleQuestion },
  permission: { label: "Permission", tone: "orange", icon: ShieldAlert },
}

/** A question that timed out unanswered, as History tells it. */
const MISSED: WorkOutcome = { label: "Missed", tone: "orange", icon: AlarmClockOff }

/**
 * The server's owner state (and, for a question, its standing) as a label, tone and icon.
 * `standing` "missed" and "answered_late" win over the state, as on the iPhone; `answer` is the
 * owner's late answer in words ("Approved", "No"). Unknown states give null (show nothing).
 */
export function workOutcome(input: {
  state: OwnerState | null | undefined
  needsYou?: NeedsYouReason | null
  standing?: "pending" | "missed" | "answered" | "answered_late" | null
  answer?: string | null
}): WorkOutcome | null {
  if (input.standing === "missed") return MISSED
  if (input.standing === "answered_late") {
    const declined = input.answer != null && ["Declined", "No"].includes(input.answer)
    return {
      label: input.answer ? `${input.answer} (answered late)` : "Answered late",
      tone: declined ? "yellow" : "mint",
      icon: MessageSquareReply,
    }
  }
  if (!input.state) return null
  if (input.state === "needs_you" && input.needsYou) return NEEDS_YOU[input.needsYou]
  return OUTCOMES[input.state] ?? null
}

/**
 * The plan line: "Step 2 of 6 · Run migrations" while a top-level step is current (the server's position), "6 of 6 done"
 * once finished, "2 of 6 steps" for an older server that sends no position; null without steps.
 */
export function stepsCaption(
  steps: { done: number; total: number; current?: string | null; currentIndex?: number | null } | null | undefined,
  options: { finished?: boolean } = {}
): string | null {
  if (!steps || steps.total <= 0) return null
  if (options.finished || steps.done >= steps.total) return `${steps.total} of ${steps.total} done`
  const current = steps.current?.trim()
  // A current step without its index is the one after the done ones: still "Step N of M", never a bare count.
  const index = steps.currentIndex ?? (current ? Math.min(steps.done + 1, steps.total) : null)
  const lead = index ? `Step ${index} of ${steps.total}` : `${steps.done} of ${steps.total}`
  return current ? `${lead} · ${current}` : index ? lead : `${lead} steps`
}
