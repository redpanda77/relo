// Relo's onboarding as one staged work in the notch (Mac: ReloNotchKit OnboardingStage.swift +
// ONB/ReloOnboardingNotch.swift). The Settings window's onboarding emits `onboarding_stage` to the notch at each change;
// the notch shows the work like any card (title "Setting up Relo", a plan of N steps; Started, Your turn while a choice
// waits, a step done on each Continue, Failed, Done) and its wings, peek and cues play for each transition. It is never a
// server card and never reaches History; nothing is spoken.
//
// The event's payload (settings/onboarding/notchStage.ts OnboardingStagePayload); phase "clear" (or null) takes it off:
//   { phase: "working" | "yourTurn" | "failed" | "done" | "clear", stepsDone, stepsTotal, title, status, startedAt }
// It is read defensively: a wrapper ({ stage }), other spellings of a phase, and missing numbers all have a reading.

import type { Presentation, Row, SectionKind, Tone } from "./presentation"

export type OnboardingPhase = "working" | "yourTurn" | "failed" | "done"

export interface OnboardingStage {
  phase: OnboardingPhase
  stepsDone: number
  stepsTotal: number
  title: string
  status: string | null
  /** When the staged work began (epoch ms); 0 when the sender gave none. */
  startedAt: number
}

/** The staged work's fixed row id: moments and the closed notch find it by this (OnboardingStage.rowID). */
export const ONBOARDING_ROW_ID = "onboarding"
/** The Tauri event the Settings window emits. */
export const ONBOARDING_STAGE_EVENT = "onboarding_stage"
export const ONBOARDING_TITLE = "Setting up Relo"

const PHASES: Record<string, OnboardingPhase> = {
  working: "working",
  started: "working",
  stepdone: "working",
  step_done: "working",
  yourturn: "yourTurn",
  your_turn: "yourTurn",
  waiting: "yourTurn",
  failed: "failed",
  done: "done",
  finished: "done",
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0)

/** Reads an `onboarding_stage` payload; null (nothing staged) for null, a clear marker or anything that is not a stage. */
export function parseStage(payload: unknown): OnboardingStage | null {
  if (!payload || typeof payload !== "object") return null
  let raw = payload as Record<string, unknown>
  if (raw.stage && typeof raw.stage === "object") raw = raw.stage as Record<string, unknown>
  if (raw.cleared === true || raw.clear === true) return null
  const phase = typeof raw.phase === "string" ? PHASES[raw.phase.toLowerCase()] : undefined
  if (!phase) return null
  const stepsTotal = count(raw.stepsTotal ?? raw.total)
  return {
    phase,
    stepsTotal,
    stepsDone: Math.min(count(raw.stepsDone ?? raw.done), stepsTotal),
    title: typeof raw.title === "string" && raw.title ? raw.title : ONBOARDING_TITLE,
    status: typeof raw.status === "string" && raw.status ? raw.status : null,
    startedAt: typeof raw.startedAt === "number" && Number.isFinite(raw.startedAt) ? raw.startedAt : 0,
  }
}

/**
 * What a real card in the stage's state produces (NotchPresentation.onboarding): the focus row, its section, the counts
 * and the plan bar's position. Nothing is spoken (the onboarding speaks itself).
 */
export function onboardingPresentation(stage: OnboardingStage, startedAt: number): Presentation {
  const total = Math.max(0, stage.stepsTotal)
  const done = Math.min(Math.max(0, stage.stepsDone), total)
  const finished = stage.phase === "done"
  const tone: Tone = stage.phase === "working" ? "working" : stage.phase === "yourTurn" ? "yourTurn" : stage.phase === "failed" ? "failed" : "done"
  const kind: SectionKind = stage.phase === "working" ? "running" : stage.phase === "yourTurn" ? "waitingOnYou" : "recent"
  const row: Row = {
    id: ONBOARDING_ROW_ID,
    title: stage.title,
    status: stage.status,
    project: null,
    source: null,
    tone,
    stepsDone: total > 0 ? (finished ? total : done) : null,
    stepsTotal: total > 0 ? total : null,
    currentStep: null,
    startedAt,
    questionId: null,
    notificationId: null,
    questionPending: false,
    unreadable: false,
    questionMissed: false,
    computerIcon: null,
    declaredAt: startedAt,
    roundOutcome: null,
    outline: null,
    currentIndex: total > 0 && !finished ? Math.min(done + 1, total) : null,
    currentFill: total > 0 && !finished ? 0 : null,
    spoken: null,
  }
  const live = kind === "running" || kind === "waitingOnYou"
  return {
    focus: row,
    needsYouCount: 0,
    activeCount: live ? 1 : 0,
    sections: [{ kind, rows: [row] }],
    hasUnreadable: false,
    sinceYouLooked: null,
    privateEarlier: 0,
    sessions: [],
  }
}
