export type SemanticStatusTone =
  "success" | "active" | "warning" | "danger" | "info" | "neutral"

const SUCCESS_STATES = new Set([
  "accepted",
  "approved",
  "complete",
  "completed",
  "delivered",
  "ended",
  "received",
  "responded",
  "succeeded",
])

const WARNING_STATES = new Set([
  "durable",
  "pending",
  "queued",
  "retrying",
  "waiting",
])

/** Waiting on the owner or on a pause: the amber warning (yellow is offline only). */
const AMBER_STATES = new Set(["your turn", "your_turn", "waiting", "paused"])
const SLATE_STATES = new Set(["quiet", "idle"])

const DANGER_STATES = new Set([
  "canceled",
  "cancelled",
  "denied",
  "error",
  "expired",
  "failed",
  "rejected",
])

const INFO_STATES = new Set([
  "answer",
  "approval",
  "live_activity",
  "notification",
  "question",
  "recorded",
  "reply",
])

export function semanticStatusTone(value: string): SemanticStatusTone {
  const state = value.toLowerCase()
  if (SUCCESS_STATES.has(state)) return "success"
  if (state === "active") return "active"
  if (WARNING_STATES.has(state)) return "warning"
  if (DANGER_STATES.has(state)) return "danger"
  if (INFO_STATES.has(state)) return "info"
  return "neutral"
}

/**
 * The meaning palette (DESIGN.md): every state colour in the dashboard is one of these, and each
 * maps to a `.tone-*` class. mint done, cyan running, orange needs you, yellow attention, red
 * failed, violet messages, neutral for everything quiet.
 */
export type NeonTone =
  "mint" | "cyan" | "orange" | "amber" | "yellow" | "slate" | "red" | "violet" | "neutral"

const NEON_BY_SEMANTIC: Record<SemanticStatusTone, NeonTone> = {
  success: "mint",
  active: "cyan",
  warning: "yellow",
  danger: "red",
  info: "violet",
  neutral: "neutral",
}

/** The meaning colour for a semantic tone (success, active, warning, danger, info, neutral). */
export function neonTone(tone: SemanticStatusTone): NeonTone {
  return NEON_BY_SEMANTIC[tone]
}

/** One mapping from a state word ("delivered", "pending", "failed", "running"…) to its colour. */
export function toneFor(state: string): NeonTone {
  const value = state.toLowerCase()
  if (value === "running" || value === "live") return "cyan"
  if (AMBER_STATES.has(value)) return "amber"
  if (SLATE_STATES.has(value)) return "slate"
  if (value === "needs_you" || value === "needs you" || value === "awaiting_response") return "orange"
  return neonTone(semanticStatusTone(value))
}

/** The `.tone-*` class for a tone. */
export function toneClass(tone: NeonTone): string {
  return `tone-${tone}`
}
