import { useSyncExternalStore } from "react"

import doneUrl from "@/assets/sounds/done.m4a?no-inline"
import failedUrl from "@/assets/sounds/failed.m4a?no-inline"
import linkedUrl from "@/assets/sounds/linked.m4a?no-inline"
import needsYouUrl from "@/assets/sounds/needs-you.m4a?no-inline"
import sentUrl from "@/assets/sounds/sent.m4a?no-inline"
import yourTurnUrl from "@/assets/sounds/your-turn.m4a?no-inline"

/**
 * Relo's sound set in the browser (ADR 0013): the same cues as the iPhone and the Mac, played with
 * Web Audio. Off until the owner turns it on in Settings (that click unlocks the AudioContext), kept
 * per browser, silent in a hidden tab, and never more than one cue every two seconds. Every failure
 * (autoplay policy, a missing file, a decoding error) is swallowed: a cue is never worth an error.
 * The files are imported from `src/assets/sounds` (where `scripts/sounds/render.sh` writes them) so Vite
 * hashes them into `/assets`, the only static path the server serves.
 */
export type Cue = "needs-you" | "your-turn" | "done" | "failed" | "sent" | "linked"

const URLS: Record<Cue, string> = {
  "needs-you": needsYouUrl,
  "your-turn": yourTurnUrl,
  done: doneUrl,
  failed: failedUrl,
  sent: sentUrl,
  linked: linkedUrl,
}

const STORAGE_KEY = "relo.sound"
/** Modest: the cues are loudness-matched, and a browser tab is rarely the only thing playing. */
const GAIN = 0.6
/** At most one cue every 2 s per surface (ADR 0013, section 2). */
export const MIN_GAP_MS = 2_000
/** The owner's own acts always confirm: they are the answer to a tap, not news competing for attention. */
const OWNER_CUES: ReadonlySet<Cue> = new Set<Cue>(["sent", "linked"])

let enabled: boolean | null = null
let context: AudioContext | null = null
let buffers = new Map<Cue, AudioBuffer>()
let decoding: Promise<void> | null = null
let lastPlayedAt = Number.NEGATIVE_INFINITY
let unlocking = false
const listeners = new Set<() => void>()

function read(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "on"
  } catch {
    return false
  }
}

/** Whether this browser plays Relo's sounds (off by default, kept per browser). */
export function isSoundEnabled(): boolean {
  enabled ??= read()
  return enabled
}

export function subscribeSound(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useSoundEnabled() {
  return useSyncExternalStore(subscribeSound, isSoundEnabled, () => false)
}

/** One context for the page's life, made on the first enable or gesture, never at load. */
function audioContext(): AudioContext | null {
  if (context) return context
  const Constructor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Constructor) return null
  try {
    context = new Constructor()
  } catch {
    context = null
  }
  return context
}

/** Resumes the context (inside a gesture) and decodes the cues once. */
async function prepare(): Promise<void> {
  const ctx = audioContext()
  if (!ctx) return
  try {
    await ctx.resume()
  } catch {
    // Still locked: the next gesture tries again.
  }
  decoding ??= Promise.all(
    (Object.keys(URLS) as Cue[]).map(async (cue) => {
      try {
        const response = await fetch(URLS[cue])
        if (!response.ok) return
        buffers.set(cue, await ctx.decodeAudioData(await response.arrayBuffer()))
      } catch {
        // This cue stays silent.
      }
    })
  ).then(() => undefined)
  await decoding
}

/**
 * Turns sound on or off for this browser. Turning it on is the owner's gesture: it unlocks the
 * AudioContext and confirms with `linked`, Relo's brand bloom.
 */
export async function setSoundEnabled(on: boolean): Promise<void> {
  enabled = on
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? "on" : "off")
  } catch {
    // Storage blocked: the choice holds for this page only.
  }
  for (const listener of listeners) listener()
  if (!on) return
  await prepare()
  play("linked", false)
}

/**
 * A browser that already chose sound on a past visit has no gesture yet: the first click or key
 * unlocks the context. Safe to call on every mount.
 */
export function unlockSoundOnGesture() {
  if (unlocking || !isSoundEnabled()) return
  unlocking = true
  const unlock = () => {
    document.removeEventListener("pointerdown", unlock, true)
    document.removeEventListener("keydown", unlock, true)
    void prepare()
  }
  document.addEventListener("pointerdown", unlock, true)
  document.addEventListener("keydown", unlock, true)
}

function play(cue: Cue, spaced: boolean): boolean {
  try {
    if (!isSoundEnabled() || document.visibilityState !== "visible") return false
    const ctx = context
    const buffer = buffers.get(cue)
    // A locked context would queue the cue and blurt it out at the next gesture: skip instead.
    if (!ctx || !buffer || ctx.state !== "running") return false
    const now = Date.now()
    if (spaced && now - lastPlayedAt < MIN_GAP_MS) return false
    const source = ctx.createBufferSource()
    const gain = ctx.createGain()
    source.buffer = buffer
    gain.gain.value = GAIN
    source.connect(gain)
    gain.connect(ctx.destination)
    source.start()
    lastPlayedAt = now
    return true
  } catch {
    return false
  }
}

/** Plays a cue if the owner enabled sound, the tab is visible and the last cue was 2 s ago (owner acts always play). */
export function playCue(cue: Cue): boolean {
  return play(cue, !OWNER_CUES.has(cue))
}

/** Settings' Test button: `needs-you`, the signature, whatever the last cue was. */
export async function testSound(): Promise<void> {
  await prepare()
  play("needs-you", false)
}

/** Forgets everything (tests only). */
export function resetSoundForTests() {
  enabled = null
  context = null
  buffers = new Map()
  decoding = null
  lastPlayedAt = Number.NEGATIVE_INFINITY
  unlocking = false
  listeners.clear()
}
