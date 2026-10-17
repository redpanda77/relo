import type { ComputerIcon } from "@relo/notification-contracts"

export type LiveActivityTone = "live" | "attention" | "success"

/** The state ramp (lead → end) and the owner chip of each state. */
export const LIVE_ACTIVITY_TONES: Record<LiveActivityTone, { lead: string; end: string; chip: string; chipColor: string; chipAlpha: string }> = {
  live: { lead: "#5CE1FF", end: "#8B7CFF", chip: "WORKING", chipColor: "#33D9F2", chipAlpha: "B3" },
  attention: { lead: "#FF6B57", end: "#D65CF0", chip: "NEEDS YOU", chipColor: "#FF9400", chipAlpha: "FF" },
  success: { lead: "#34D399", end: "#2DD4BF", chip: "DONE", chipColor: "#63E6BF", chipAlpha: "FF" },
}

export type LiveActivityPreviewModel = {
  icon: ComputerIcon
  /** Colors the header icon, and nothing else. */
  accent: string
  projectLabel: string
  title: string
  status: string
  tone: LiveActivityTone
  /** Present when the card has a plan: `done` finished, `total` in all, `current` the step being worked on. */
  steps?: { done: number; total: number; current: string }
  /** 0..1, for a card without a plan. */
  progress?: number
  /** Shown as given ("12:04"). */
  elapsed: string
}

/** The example card: it has a plan, so the phone shows steps. The words differ by state; the rest does not. */
export function exampleCard(tone: LiveActivityTone): Pick<LiveActivityPreviewModel, "title" | "status" | "steps" | "elapsed" | "projectLabel"> {
  const base = { projectLabel: "relo", title: "Ship the release", elapsed: "12:04" }
  if (tone === "success") return { ...base, status: "Release shipped", steps: { done: 4, total: 4, current: "Ship the release" } }
  return {
    ...base,
    status: tone === "attention" ? "Waiting for your approval to deploy" : "Running the migrations",
    steps: { done: 1, total: 4, current: "Run the migrations" },
  }
}

