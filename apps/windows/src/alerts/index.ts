// Relo for Windows' sensory layer in one place: sounds, voice, interface cues and the quiet rules, ported from
// ReloMoments.swift. Call `useAlerts` ONCE from the notch (Notch.tsx) and read everything else from what it returns:
//
//   const owner = useOwner()
//   const relo = useRelo({ ...owner.input, ...props })
//   const alerts = useAlerts({ presentation: relo.presentation, owner, events: stagedOnboarding ? { staged: true, stagedRowId } : null })
//   // Draw `alerts.presentation` instead of `relo.presentation`: its rows carry the sealed spoken words (`spoken`, `spokenName`,
//   // `spokenVoice`) the card's play button needs.
//
// What the hook does by itself (ReloMoments.receive), at every change of the presentation, connection or answers:
//   - new moments (question, failed, yourTurn, finished, started; once each by kind|card|question, the first summary after launch
//     is a baseline: shown, never cued) -> one cue (the highest moment wins, 2 s apart, per-event switches) and, when the voice
//     mode speaks, the spoken lines queued after it (a busy voice defers the cue to right before its line);
//   - a finished plan step -> the faint `update` tick (once per card per 3 min, never over a cue or the voice) and, at the Every
//     step detail, the progress line; `alerts.stepped` changes with every finished step even when no sound plays (the wings);
//   - signing in lands -> `linked`; an accepted answer -> `sent` (not when quiet);
//   - Relo's pause starting drops the lines waiting.
// It replaces the cue-only `playFor` that OwnerApp used to call (now a no-op port): nothing else may call cuePlayer.playFor or
// speakFor for notch moments, or the cue would play twice.
//
// What the notch calls (all on the hook's result):
//   alerts.batch            { serial, events }  the latest new moments, most important first (peek / wings follow `serial`)
//   alerts.stepped          { serial, rowId }   the latest card that finished a step (the closed notch's step light)
//   alerts.unseen           the orb breathes until `markSeen()` (call it when the Relo tab appears)
//   alerts.quiet()          Relo's pause, or a full-screen app in front with "Stay quiet" on: no peeks, notices, sent cue, ticks
//   alerts.peekAllowed()    the Peek switch is on and not quiet
//   alerts.canPlay(row) / alerts.playCard(row)   the card's play button (Mac: shown with "Show a play button on cards"); pressing
//                           again while the line is said stops it; not gated by quiet or the microphone
//   alerts.interfaceCue(name)   "open" when the notch opens (only if it was closed), "close" when it closes (only if it was open),
//                           "tab", "expand" / "collapse" (a card unfolds / folds), "section" (Settings page), "on" / "off"
//                           (switch, agent ticked), "turn" (onboarding page), plus the Settings window with the standalone
//                           `interfaceCue` below. Switches and the 400 ms rule are the player's.
//   alerts.launchCue({ atLogin })   Relo opened by the owner (not started at login): "launch"
//   alerts.quitSound()      plays "quit" and returns the ms to wait before exiting (0 = exit now; at most 2000)
//   alerts.greetReady({ atLogin })  "Relo is ready", once per launch, when the local server first answers
//
// Also: `speakFor`/`playLine` in ../voice stay as the low-level voice API; `isQuiet()` in ../sound is the one quiet rule.

import { cuePlayer, type Cue } from "../sound"
import type { InterfaceCueName } from "./controller"

export { AlertsController } from "./controller"
export type {
  AlertSettings,
  AlertsDeps,
  AlertsInput,
  AlertsState,
  Batch,
  CuesLike,
  InterfaceCueName,
  OwnerAlerts,
  SpeechLike,
  StagedMoments,
  Stepped,
  VoiceLike,
} from "./controller"
export { alerts, createAlerts, useAlerts, type UseAlertsOptions } from "./useAlerts"
export { isQuiet } from "../sound"
export { withSpoken, spokenWordsOf } from "../client/view"

/** An interface cue from any window (the Settings window has no notch): the player's switches and 400 ms rule apply. */
export function interfaceCue(name: InterfaceCueName): boolean {
  return cuePlayer.play(name satisfies Cue)
}
