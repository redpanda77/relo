// The onboarding as one staged work in the notch (the Mac's ReloOnboardingNotch + OnboardingStage): "Setting up Relo" with one
// plan step per screen between Hello and Ready; a choice screen is Your turn, working while something runs, Failed with
// its words, Done titled "Ready to use with <names>" or "Relo is ready". It is never a server card and never History.
//
// CONTRACT (O02). The Settings window broadcasts the Tauri event `onboarding_stage` whenever the staged work changes, with an
// `OnboardingStagePayload`. The notch (W3: Presentation.onboarding + Notch.tsx) renders it as a focus row and plays the moments
// (start, your turn, step, failed, done) for each transition. `phase: "clear"` takes the staged work off the notch; nothing is
// spoken for it.
import { RELO_ROW, route, type Progress } from "./stages"

export const ONBOARDING_STAGE_EVENT = "onboarding_stage"
export const ONBOARDING_TITLE = "Setting up Relo"

export interface OnboardingStagePayload {
  phase: "working" | "yourTurn" | "failed" | "done" | "clear"
  stepsDone: number
  stepsTotal: number
  title: string
  /** The failure's words (phase "failed"). */
  status: string | null
  /** When the staged work began (epoch ms): the row's start time. */
  startedAt: number
}

/** "Ready to use with Claude Code" / "... A and B" / "... A, B and C"; "Relo is ready" with no agent. */
export function readyLine(p: Pick<Progress, "rows">): string {
  const names = p.rows.filter((r) => r.status === "done" && r.id !== RELO_ROW).map((r) => r.name)
  if (names.length === 0) return "Relo is ready"
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
  return `Ready to use with ${list}`
}

/** One step per screen between Hello and Ready. */
export function stepsTotal(p: Pick<Progress, "place">): number {
  return route(p.place).length - 2
}

/** What the notch shows for the onboarding at `p`; null at Hello (nothing has begun) so the staged work is cleared. */
export function stagePayload(p: Progress, startedAt: number): OnboardingStagePayload | null {
  if (p.stage === "hello") return null
  const total = stepsTotal(p)
  const base = { stepsTotal: total, title: ONBOARDING_TITLE, status: null, startedAt }
  if (p.stage === "ready") return { ...base, phase: "done", stepsDone: total, title: readyLine(p) }
  const index = route(p.place).indexOf(p.stage)
  // Hello is step zero; Sound is the first screen, so the screens behind this one are `index - 1`.
  const done = Math.min(total, Math.max(0, index - 1))
  const working = { ...base, phase: "working" as const, stepsDone: done }
  switch (p.stage) {
    case "server":
      return p.signIn === "waiting" ? working : { ...base, phase: "yourTurn", stepsDone: done }
    case "setup": {
      const failed = p.rows.find((r) => r.status === "failed")
      if (failed) return { ...base, phase: "failed", stepsDone: done, status: failed.message ?? `Relo could not set up ${failed.name}.` }
      return working
    }
    case "local": {
      if (p.local.failure) return { ...base, phase: "failed", stepsDone: done, status: p.local.failure }
      return p.local.step === "done" || p.local.waitingForAgents ? { ...base, phase: "yourTurn", stepsDone: done } : working
    }
    default:
      return { ...base, phase: "yourTurn", stepsDone: done }
  }
}

/** Same payload apart from the start time: nothing to re-send. */
export function samePayload(a: OnboardingStagePayload | null, b: OnboardingStagePayload | null): boolean {
  if (a === null || b === null) return a === b
  return a.phase === b.phase && a.stepsDone === b.stepsDone && a.stepsTotal === b.stepsTotal && a.title === b.title && a.status === b.status
}

/** The payload that takes the staged work off the notch. */
export function clearPayload(): OnboardingStagePayload {
  return { phase: "clear", stepsDone: 0, stepsTotal: 0, title: ONBOARDING_TITLE, status: null, startedAt: 0 }
}
