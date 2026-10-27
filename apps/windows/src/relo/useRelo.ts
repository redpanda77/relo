// The data the notch shows. Until the network client lands this is the snapshot mode: `?snapshot=<fixture>` renders a
// Now summary from a fixture (relo/fixtures); with no snapshot and no summary passed in, the notch says "Not connected".
// The network step passes `summary` (the parsed `GET /api/now`), `questions` and `answers` instead, and `onAnswer`.

import type { NowSummary } from "@relo/notification-contracts"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { AnswerAction, AnswerPhase, OnAnswer, QuestionSpec } from "./answers"
import { loadSnapshot, SNAPSHOT_NAMES } from "./fixtures"
import { presentationOf, type Presentation } from "./presentation"

export interface ReloInput {
  summary?: NowSummary | null
  /** Question kinds and options by question id (the Now summary only says a question is pending). */
  questions?: Record<string, QuestionSpec>
  /** Where each answer stands, by question id. */
  answers?: Record<string, AnswerPhase>
  onAnswer?: OnAnswer
  /** Dismisses a missed question (POST /api/devices/self/questions/:id/dismiss); in snapshot mode there is nothing to dismiss. */
  onDismiss?: (questionId: string) => void
  offline?: boolean
}

export interface ReloData {
  presentation: Presentation
  hasData: boolean
  offline: boolean
  questions: Record<string, QuestionSpec>
  answers: Record<string, AnswerPhase>
  onAnswer: OnAnswer
  onDismiss: (questionId: string) => void
  /** The snapshot being shown, if any. */
  snapshot: string | null
}

const NONE: Record<string, never> = {}
const noDismiss = (): void => {}

/** `?snapshot=<name>`, or the `VITE_RELO_SNAPSHOT` dev flag; null when neither names a known fixture. */
export function snapshotName(search: string = typeof location === "undefined" ? "" : location.search): string | null {
  const name = new URLSearchParams(search).get("snapshot") ?? (import.meta.env.VITE_RELO_SNAPSHOT as string | undefined) ?? null
  return name && SNAPSHOT_NAMES.includes(name) ? name : null
}

export function useRelo(input: ReloInput = {}): ReloData {
  const name = useMemo(() => snapshotName(), [])
  const snapshot = useMemo(() => (name ? loadSnapshot(name) : null), [name])
  // Dev only: `window.__reloEdit(s => { s.needsYou = [] })` changes the snapshot in place (frame captures of the summary line).
  const [edited, setEdited] = useState<NowSummary | null>(null)
  const base = edited ?? snapshot?.summary ?? null
  useEffect(() => {
    if (!import.meta.env.DEV || !snapshot) return
    ;(window as unknown as { __reloEdit?: unknown }).__reloEdit = (fn: (s: NowSummary) => void) => setEdited((cur) => { const next = structuredClone(cur ?? snapshot.summary); fn(next); return next })
  }, [snapshot])
  const summary = input.summary ?? base
  const presentation = useMemo(() => presentationOf(summary), [summary])
  // In snapshot mode an answer is simulated (sending, then accepted) so the controls can be tried without a server.
  const [local, setLocal] = useState<Record<string, AnswerPhase>>({})
  const timers = useRef<Array<ReturnType<typeof setTimeout>>>([])
  const simulate: OnAnswer = useCallback((id: string, _action: AnswerAction) => {
    setLocal((s) => ({ ...s, [id]: { state: "sending" } }))
    timers.current.push(setTimeout(() => setLocal((s) => ({ ...s, [id]: { state: "accepted" } })), 600))
  }, [])
  return {
    presentation,
    hasData: summary !== null,
    offline: input.offline ?? false,
    questions: input.questions ?? snapshot?.questions ?? NONE,
    answers: input.answers ?? local,
    onAnswer: input.onAnswer ?? simulate,
    onDismiss: input.onDismiss ?? noDismiss,
    snapshot: name,
  }
}
