// Relo's voice on Windows: the same voice as Relo for Mac (Phonon 31M), run by src-tauri/src/voice.
//
//   import { speakFor, startVoice, playLine } from "./voice"
//   startVoice()                                   // when the voice mode speaks: fetch the voice on an unmetered connection
//   void speakFor(events, cards)                   // for each batch of new moments, in place of cuePlayer.playFor(events)
//   void speakProgress(previousCards, nextCards)   // at the Every step detail
//   playLine(card, prompt)                         // the card's play button: speak, or stop if it is being said
//
// `events` are the sound module's NotchEvents plus the card's id (`rowId`); `cards` are the presentation rows (with their sealed spoken
// words, see `SpokenCard`).

import { cuePlayer, isQuiet } from "../sound"
import { settingsStore } from "../settings/store"
import * as ipc from "./ipc"
import { VoiceMoments, type MomentCard, type VoiceEvent } from "./moments"
import * as SpokenLine from "./spokenLine"

export { text as spokenText, progress as spokenProgress, type SpokenCard, type Detail } from "./spokenLine"
export type { MomentCard, VoiceEvent } from "./moments"
export type { ModelStatus, VoiceState, VoiceStatus } from "./ipc"
export {
  status as voiceStatus,
  download as voiceDownload,
  cancelDownload as voiceCancelDownload,
  deleteModel as voiceDelete,
  preview as voicePreview,
  setEngine as voiceSetEngine,
  onProgress as onVoiceProgress,
} from "./ipc"

/** The app's one voice orchestration: src/alerts drives it. */
export const voiceMoments = new VoiceMoments({
  settings: () => settingsStore.get(),
  quiet: () => isQuiet(),
  cues: cuePlayer,
  voice: ipc.tauriBackend,
  now: Date.now,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
})
voiceMoments.attach()

/**
 * A batch of new notch moments: plays the leading one's cue and says the updates' lines after it, per the owner's voice mode, detail
 * and quiet rules (paused, full screen, microphone in use).
 */
export function speakFor(
  events: readonly VoiceEvent[],
  cards: readonly MomentCard[],
  options?: { prompts?: Readonly<Record<string, string>> },
): Promise<void> {
  return voiceMoments.speakFor(events, cards, options)
}

/** At the Every step detail, the lines for steps that finished between `previous` and `next` (the cards that are not folded). */
export function speakProgress(previous: readonly MomentCard[], next: readonly MomentCard[]): Promise<void> {
  return voiceMoments.speakProgress(previous, next)
}

/** Drops the lines waiting to be said (alerts were paused). */
export function clearSpeech(): void {
  voiceMoments.clear()
}

/** At launch, once settings are loaded: fetch the voice (on an unmetered connection) when the mode speaks, else leave it be. */
export async function startVoice(): Promise<void> {
  await settingsStore.start()
  if (settingsStore.get().voiceMode !== "soundOnly") await ipc.start()
}

/** The card's play button: its line at the Full detail (the owner asked for it); pressing again while it is said stops it. */
export async function playLine(card: SpokenLine.SpokenCard, prompt?: string | null): Promise<void> {
  const line = SpokenLine.text(card, { prompt, owner: "full" })
  if (line === null) return
  const id = `${card.id}|${line}`
  const status = await ipc.status()
  if (status && status.state.id === id && status.state.phase !== "idle") await ipc.tauriBackend.cancel()
  else await ipc.tauriBackend.speak(id, line)
}

/** Stops whatever is being said. */
export function stopSpeaking(): Promise<void> {
  return ipc.tauriBackend.cancel()
}
