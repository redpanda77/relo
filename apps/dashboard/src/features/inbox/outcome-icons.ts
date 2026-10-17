import {
  AudioWaveform,
  BellRing,
  Check,
  CircleDashed,
  Clock,
  Hand,
  MessageSquareText,
  Minus,
  OctagonX,
  Replace,
  Square,
  type LucideIcon,
} from "lucide-react"

import type { OutcomeKind } from "@/features/inbox/activity-model"

/** Each outcome's mark: colour is never the only cue. */
export const OUTCOME_ICON: Record<OutcomeKind, LucideIcon> = {
  running: AudioWaveform,
  done: Check,
  stopped: OctagonX,
  expired: Clock,
  ended: Square,
  replaced: Replace,
  "needs-you": Hand,
  answered: Check,
  unanswered: Minus,
  message: CircleDashed,
}

/** A message has no outcome: its type stands in its place, with the type's own mark. */
export const TYPE_ICON: Record<string, LucideIcon> = {
  Approval: BellRing,
  Question: BellRing,
  Choice: BellRing,
  "Reply request": MessageSquareText,
  Response: MessageSquareText,
}
