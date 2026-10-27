import { CUES, EVENT_KINDS, cueFor, isInterfaceCue, leadOf, previewCue } from "./cues"
import type { Cue, NotchEvent, NotchEventKind } from "./cues"

/**
 * Relo for Windows' cue player: ReloCuePlayer (volume 0.6, the same cue again within 400 ms plays once, `endsAt` so
 * a later voice can wait) plus ReloMoments' cue rules (2 s between moment cues, the highest moment of a burst wins,
 * the sounds / interface-sounds / per-event switches), played with Web Audio as the Dashboard does
 * (apps/dashboard/src/lib/sound.ts). Every failure is swallowed: a cue is never worth an error.
 */
export const VOLUME = 0.6
/** docs/SOUND.md: the same cue again within 400 ms plays once. */
export const SAME_CUE_MS = 400
/** At most one moment cue every 2 s. */
export const GLOBAL_GAP_MS = 2_000
/** A card ticks for a finished step at most once every three minutes. */
export const STEP_TICK_MS = 180_000

/** The slice of Web Audio the player uses (a fake in tests). */
export interface AudioBufferLike { readonly duration: number }
export interface SourceLike {
  buffer: AudioBufferLike | null
  connect(node: unknown): unknown
  start(when?: number): void
  stop(): void
}
export interface ContextLike {
  readonly state: string
  readonly destination: unknown
  resume(): Promise<void>
  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike>
  createBufferSource(): SourceLike
  createGain(): { gain: { value: number }; connect(node: unknown): unknown }
}

/** The owner's switches (Settings); read at every play, so changes apply at once. Defaults are the Mac's. */
export interface SoundSettings {
  /** Master switch (`reloSounds`). */
  sounds: boolean
  /** Interface sounds (`reloInterfaceSounds`). */
  interfaceSounds: boolean
  /** Per-event switches (`reloSoundQuestion`, `Failed`, `YourTurn`, `Finished`, `Started`, `Step`). */
  events: Record<NotchEventKind, boolean>
  /** Voice only mode: the spoken updates carry the kind, so only a start still ticks. */
  voiceOnly: boolean
}

export function defaultSettings(): SoundSettings {
  return {
    sounds: true,
    interfaceSounds: true,
    events: Object.fromEntries(EVENT_KINDS.map((kind) => [kind, true])) as Record<NotchEventKind, boolean>,
    voiceOnly: false,
  }
}

export interface PlayerOptions {
  settings?: () => SoundSettings
  /** Relo's pause or a full-screen app in front (ReloMoments.quiet). */
  quiet?: () => boolean
  createContext?: () => ContextLike
  /** Loads a cue file's bytes. Default: fetch `${baseUrl}${cue}.wav`. */
  load?: (cue: Cue) => Promise<ArrayBuffer>
  baseUrl?: string
  now?: () => number
}

export interface PlayForOptions {
  /** The staged onboarding teaches every moment: no gap, no voice and no per-event switch (only the master). */
  staged?: boolean
}

export class CuePlayer {
  private readonly settings: () => SoundSettings
  private readonly quiet: () => boolean
  private readonly createContext: () => ContextLike
  private readonly load: (cue: Cue) => Promise<ArrayBuffer>
  private readonly now: () => number
  private context: ContextLike | null = null
  private readonly buffers = new Map<Cue, AudioBufferLike>()
  private readonly playing = new Map<Cue, SourceLike>()
  private readonly lastPlayed = new Map<Cue, number>()
  private readonly stepTicked = new Map<string, number>()
  private lastCue = Number.NEGATIVE_INFINITY
  private end = Number.NEGATIVE_INFINITY
  private decoding: Promise<void> | null = null

  constructor(options: PlayerOptions = {}) {
    const base = options.baseUrl ?? "/sounds/"
    this.settings = options.settings ?? defaultSettings
    this.quiet = options.quiet ?? (() => false)
    this.createContext = options.createContext ?? (() => new AudioContext() as unknown as ContextLike)
    this.load = options.load ?? (async (cue) => {
      const response = await fetch(`${base}${cue}.wav`)
      if (!response.ok) throw new Error(`sound ${cue}: ${response.status}`)
      return response.arrayBuffer()
    })
    this.now = options.now ?? Date.now
  }

  /** Makes the context (once), resumes it (call from a gesture if the platform requires one) and decodes every cue once. */
  async preload(): Promise<void> {
    try {
      this.context ??= this.createContext()
      await this.context.resume().catch(() => undefined)
    } catch {
      return
    }
    const context = this.context
    this.decoding ??= Promise.all(
      CUES.map(async (cue) => {
        try {
          this.buffers.set(cue, await context.decodeAudioData(await this.load(cue)))
        } catch {
          // This cue stays silent.
        }
      }),
    ).then(() => undefined)
    await this.decoding
  }

  /** When the cue playing now ends (ms, the player's clock): the voice waits for it. */
  endsAt(): number {
    return this.end
  }

  /** How long `cue` lasts in ms (0 when it is not loaded): quitting waits for its sound. */
  duration(cue: Cue): number {
    return (this.buffers.get(cue)?.duration ?? 0) * 1000
  }

  /** Plays `cue` when sounds (and, for interface sounds, their switch) are on; `force` is Settings' preview. Returns whether it played. */
  play(cue: Cue, options: { force?: boolean } = {}): boolean {
    const force = options.force === true
    if (!force) {
      const settings = this.settings()
      if (!settings.sounds) return false
      if (isInterfaceCue(cue) && !settings.interfaceSounds) return false
    }
    const now = this.now()
    if (!force && now - (this.lastPlayed.get(cue) ?? Number.NEGATIVE_INFINITY) < SAME_CUE_MS) return false
    this.lastPlayed.set(cue, now)
    const buffer = this.buffers.get(cue)
    const context = this.context
    // A locked context would queue the cue and blurt it out at the next gesture: skip instead.
    if (!buffer || !context || context.state !== "running") return false
    try {
      this.playing.get(cue)?.stop()
    } catch {
      // Already ended.
    }
    try {
      const source = context.createBufferSource()
      const gain = context.createGain()
      source.buffer = buffer
      gain.gain.value = VOLUME
      source.connect(gain)
      gain.connect(context.destination)
      source.start()
      this.playing.set(cue, source)
    } catch {
      return false
    }
    this.end = now + buffer.duration * 1000
    return true
  }

  /** Settings' preview of a kind's cue. */
  preview(kind: NotchEventKind): boolean {
    return this.play(previewCue(kind), { force: true })
  }

  /**
   * A batch of new notch moments (ranked or not): one sound, the highest moment wins. Silent when quiet, when the
   * kind's switch is off, when the voice carries it, or within 2 s of the last moment cue. Returns the cue played.
   */
  playFor(events: readonly NotchEvent[], options: PlayForOptions = {}): Cue | null {
    const staged = options.staged === true
    const lead = leadOf(events)
    const cue = lead && cueFor(lead)
    if (!lead || !cue || this.quiet()) return null
    const settings = this.settings()
    if (!settings.sounds) return null
    if (!staged && (!settings.events[lead.kind] || (settings.voiceOnly && lead.kind !== "started"))) return null
    const now = this.now()
    if (!staged && now - this.lastCue < GLOBAL_GAP_MS) return null
    this.lastCue = now
    return this.play(cue) ? cue : null
  }

  /**
   * A working card finished a plan step: one faint `update` tick, at most one per card every three minutes, never over
   * another cue (the 2 s gap) or the voice (`voiceBusy`). The staged onboarding always ticks.
   */
  playStep(cardId: string, options: PlayForOptions & { voiceBusy?: boolean } = {}): boolean {
    if (this.quiet()) return false
    const settings = this.settings()
    if (options.staged) return this.play("update")
    if (!settings.sounds || !settings.events.progressed || options.voiceBusy) return false
    const now = this.now()
    if (now - this.lastCue < GLOBAL_GAP_MS) return false
    if (now - (this.stepTicked.get(cardId) ?? Number.NEGATIVE_INFINITY) < STEP_TICK_MS) return false
    this.stepTicked.set(cardId, now)
    this.lastCue = now
    return this.play("update")
  }

  /** An owner act (signing in lands: `linked`; an accepted answer: `sent`): plays on its own, outside the moment gap. */
  playOwnerAct(cue: "linked" | "sent"): boolean {
    if (cue === "sent" && this.quiet()) return false
    return this.play(cue)
  }
}
