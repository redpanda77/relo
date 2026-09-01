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
