import { settingsStore, toSoundSettings } from "../settings/store"
import type { Cue } from "./cues"
import { CuePlayer } from "./player"

export * from "./cues"
export * from "./player"

/** Why the app is quiet right now (ReloMoments.quiet): a full-screen app in front, or Relo's pause (epoch ms, 0 = not paused). */
export const quiet = { fullscreen: false, pausedUntil: 0 }

/**
 * ReloMoments.quiet: Relo's own pause, or a full-screen app in front while "Stay quiet while a full-screen app is in front" is on
 * (`quietInFullScreen`, default on). Read at every play, so a changed switch applies at once.
 */
export function isQuiet(now: number = Date.now()): boolean {
  return now < quiet.pausedUntil || (quiet.fullscreen && settingsStore.get().quietInFullScreen)
}

/**
 * The app's one player: call `cuePlayer.preload()` from a gesture (or at start), then `playFor(events)`. Its switches are the
 * owner's settings (Alerts and Voice pages), read at every play.
 */
export const cuePlayer = new CuePlayer({ settings: () => toSoundSettings(settingsStore.get()), quiet: () => isQuiet() })

let warming: Promise<void> | null = null

/**
 * An interface cue from a window that has no alerts controller (Settings, onboarding): `turn` on a page turn, `section` on a
 * Settings page change, `on` / `off` on a switch or an agent tick (ADR 0013 section 4; A09, A15, A16, A17, G14). The first call is
 * a gesture, so it also wakes the audio context and decodes the set; the cue plays once that is done. The sounds and
 * interface-sounds switches are the player's. Never throws.
 */
export function uiCue(cue: Cue): void {
  const go = () => void cuePlayer.play(cue)
  warming ??= cuePlayer.preload().catch(() => undefined)
  void warming.then(go)
}
