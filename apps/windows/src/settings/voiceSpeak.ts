// Samples spoken by the real voice (src-tauri/src/voice: the Relo voice once downloaded, the Windows voice until then),
// not the WebView's speech synthesis.

import { useEffect, useState } from "react"
import { isQuiet } from "../sound"
import { tauriBackend } from "../voice/ipc"
import { settingsStore, type VoiceDetail } from "./store"

export const VOICE_SAMPLES: Record<VoiceDetail, string> = {
  brief: "Done: Login crash.",
  full: "Done: Login crash. Fixed and tested.",
  verbose: "Login crash. Three of five done, now the tests.",
}

/** Says `text` with the voice engine Settings chose; a no-op outside the app. */
export function speak(text: string): void {
  void tauriBackend.speak(`settings|${text}`, text).catch(() => {})
}

export function stopSpeaking(): void {
  void tauriBackend.cancel()
}

/** What the first screen says (V16, O03). */
export const WELCOME_LINE = "Welcome to Relo"

/**
 * "Welcome to Relo", once, under 3 s: quiet while the microphone is in use or Relo is quiet (a full-screen app in front, the
 * pause) or sounds are off. The caption shows it either way. Resolves to whether it was spoken.
 */
export async function speakWelcome(): Promise<boolean> {
  if (!settingsStore.get().sounds || isQuiet()) return false
  if (await tauriBackend.microphoneInUse().catch(() => false)) return false
  await tauriBackend.speak("onboarding|welcome", WELCOME_LINE).catch(() => {})
  return true
}

/** True while a line of the onboarding or of Settings' previews is being prepared or played (drives the voice wave). */
export function useSpeaking(): boolean {
  const [speaking, setSpeaking] = useState(false)
  useEffect(
    () =>
      tauriBackend.onState((s) => setSpeaking(s.phase !== "idle" && (s.id === null || s.id.startsWith("settings|") || s.id.startsWith("onboarding|")))),
    [],
  )
  return speaking
}

/** "98.1 MB" for the model's size. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`
}
