// The voice half of ReloMoments.swift (ADR 0015): the updates' lines, queued to be said after their cue, one at a time. Modes
// (Settings > Voice): sound only, sound then voice (the line waits for the cue to end), sound as the kind (the cue says "needs you",
// so the line starts at the name) and voice only (the line says the kind; only a start still ticks). Detail: Brief (kind and name),
// Full (and the gist), Every step (and finished steps). Quiet: Relo's pause, a full-screen app in front, a microphone in use. The
// notch's play button always speaks.

import { cueFor, leadOf, type Cue, type NotchEvent, type NotchEventKind } from "../sound/cues"
import type { ReloSettings } from "../settings/store"
import type { VoiceBackend } from "./ipc"
import * as SpokenLine from "./spokenLine"
import { SpokenQueue, type QueuedLine } from "./spokenQueue"

/** A notch moment for a card: the sound module's event plus the card it is about. */
export interface VoiceEvent extends NotchEvent {
  rowId: string
}

/** A card as the voice reads it: a presentation `Row` (plus its sealed spoken words) fits. */
export interface MomentCard extends SpokenLine.SpokenCard {
  notificationId?: string | null
  questionPending?: boolean
  /** The sealed question's prompt (a card that needs the owner). */
  prompt?: string | null
}

export type VoiceSettings = Pick<ReloSettings, "voiceMode" | "voiceDetail" | "sounds" | "soundEvents">

/** The slice of the cue player the voice uses: `playFor` and `play` (src/sound), and when the cue playing now ends. */
export interface CueLike {
  playFor(events: readonly NotchEvent[]): Cue | null
  play(cue: Cue): boolean
  endsAt(): number
}

export interface MomentsDeps {
  settings(): VoiceSettings
  /** Relo's pause or a full-screen app in front. */
  quiet(): boolean
  cues: CueLike
  voice: VoiceBackend
  now(): number
  sleep(ms: number): Promise<void>
}

/** A moment's cue waits this long after the last one ends before the voice starts (ReloMoments' 0.25 s). */
export const AFTER_CUE_MS = 250
/** The voice looks again this often while another line plays. */
export const BUSY_POLL_MS = 150
/** At most one finished-step line per card every 45 seconds. */
export const PROGRESS_GAP_MS = 45_000

export class VoiceMoments {
  private readonly queue = new SpokenQueue()
  private speaking: Promise<void> | null = null
  private cards: readonly MomentCard[] = []
  private prompts: Readonly<Record<string, string>> = {}
  private phase: "idle" | "preparing" | "playing" = "idle"
  private readonly progressSaid = new Map<string, number>()
  private off: (() => void) | null = null

  private readonly deps: MomentsDeps

  constructor(deps: MomentsDeps) {
    this.deps = deps
  }

  /** Follows the voice's own state (a line the play button started counts as busy too). */
  attach(): void {
    this.off ??= this.deps.voice.onState((state) => {
      this.phase = state.phase
    })
  }

  detach(): void {
    this.off?.()
    this.off = null
  }

  get busy(): boolean {
    return this.phase !== "idle" || this.speaking !== null
  }

  /** The current cards, for a question's "still open" check when its line comes up. */
  observe(cards: readonly MomentCard[], prompts: Readonly<Record<string, string>> = this.prompts): void {
    this.cards = cards
    this.prompts = prompts
  }

  private get ownerDetail(): SpokenLine.Detail {
    return this.deps.settings().voiceDetail
  }

  private get mode(): ReloSettings["voiceMode"] {
    return this.deps.settings().voiceMode
  }

  private soundEnabled(kind: NotchEventKind): boolean {
    const s = this.deps.settings()
    return s.sounds && s.soundEvents[kind]
  }

  /** Voice only: the spoken updates carry no cue (their line says the kind); a start still ticks. */
  private voiceCarries(kind: NotchEventKind): boolean {
    return this.mode === "voiceOnly" && kind !== "started"
  }

  /**
   * A batch of new moments (ranked or not), most important first: plays the leading one's cue and queues the lines to say after
   * it, as ReloMoments.receive does. While a line is being said the cue waits and plays right before this update's own line,
   * never on top of the voice. Replaces `cuePlayer.playFor(events)` in the notch.
   */
  async speakFor(
    events: readonly VoiceEvent[],
    cards: readonly MomentCard[],
    options: { prompts?: Readonly<Record<string, string>> } = {},
  ): Promise<void> {
    this.observe(cards, options.prompts ?? this.prompts)
    const lead = leadOf(events)
    if (!lead) return
    const moments = events.filter((e) => cueFor(e) !== null)
    const deferred = this.busy ? await this.say(moments, lead as VoiceEvent) : false
    if (deferred) return
    this.deps.cues.playFor(events)
    await this.say(moments)
  }

  /** Queues the updates' lines. With `deferring`, that update's cue rides its line; false when it cannot (no voice, no line). */
  private async say(events: readonly VoiceEvent[], deferring?: VoiceEvent): Promise<boolean> {
    if (!speaks(this.mode) || this.deps.quiet()) return false
    if (await this.deps.voice.microphoneInUse()) {
      this.queue.clear()
      return false
    }
    const now = this.deps.now()
    const lines: QueuedLine[] = []
    for (const event of events) {
      // A start only ticks: it is never said.
      if (!this.soundEnabled(event.kind) || event.kind === "started") continue
      const card = this.cards.find((c) => c.id === event.rowId)
      if (!card) continue
      const prompt = card.prompt ?? (card.notificationId ? this.prompts[card.notificationId] : undefined) ?? null
      // Sound as the kind: the cue already said "needs you", so the line starts at the name.
      const text = SpokenLine.text(card, { prompt, owner: this.ownerDetail, kind: this.mode !== "soundAsKind" })
      if (text === null) continue
      lines.push({ id: event.rowId, kind: event.kind, text, at: now })
    }
    if (deferring && !this.voiceCarries(deferring.kind)) {
      const cue = cueFor(deferring)
      const line = lines.find((l) => l.id === deferring.rowId && l.kind === deferring.kind)
      if (!cue || !this.soundEnabled(deferring.kind) || !line) return false
      line.cue = cue
    }
    this.enqueue(lines)
    return true
  }

  /**
   * At the Every step detail, a card that finished a step says so (no cue, lowest in the queue, one per card every 45 seconds;
   * steps finished faster are said together as the latest count). `previous` and `next` are the cards that are not folded.
   */
  async speakProgress(previous: readonly MomentCard[], next: readonly MomentCard[]): Promise<void> {
    if (!speaks(this.mode) || this.ownerDetail !== "verbose" || this.deps.quiet()) return
    if (await this.deps.voice.microphoneInUse()) return
    const before = new Map(previous.map((c) => [c.id, c]))
    const now = this.deps.now()
    const lines: QueuedLine[] = []
    for (const card of next) {
      const old = before.get(card.id)
      if (card.tone !== "working" || !old || old.tone !== "working") continue
      if (card.stepsDone === null || card.stepsDone <= (old.stepsDone ?? card.stepsDone)) continue
      if (now - (this.progressSaid.get(card.id) ?? Number.NEGATIVE_INFINITY) < PROGRESS_GAP_MS) continue
      const text = SpokenLine.progress(card, this.ownerDetail)
      if (text === null) continue
      this.progressSaid.set(card.id, now)
      lines.push({ id: card.id, kind: "progressed", text, at: now })
    }
    this.enqueue(lines)
  }

  /** The lines are dropped (alerts were paused, a call began). */
  clear(): void {
    this.queue.clear()
  }

  private enqueue(lines: readonly QueuedLine[]): void {
    if (lines.length === 0) return
    this.queue.add(lines)
    if (this.speaking) return
    const wait = Math.max(0, this.deps.cues.endsAt() - this.deps.now()) + AFTER_CUE_MS
    this.speaking = (async () => {
      try {
        await this.deps.sleep(wait)
        await this.speakQueued()
      } finally {
        this.speaking = null
      }
    })()
  }

  /** Says the queued lines in turn, each after the one playing (a play button press included) has ended. */
  private async speakQueued(): Promise<void> {
    for (;;) {
      while (this.phase !== "idle") await this.deps.sleep(BUSY_POLL_MS)
      if (this.deps.quiet() || !speaks(this.mode) || (await this.deps.voice.microphoneInUse())) this.queue.clear()
      const line = this.queue.next(this.deps.now(), (l) => this.cards.some((c) => c.id === l.id && c.questionPending === true))
      if (!line) return
      if (line.cue) {
        this.deps.cues.play(line.cue)
        await this.deps.sleep(Math.max(0, this.deps.cues.endsAt() - this.deps.now()) + AFTER_CUE_MS)
      }
      // Optimistic: the line is being prepared from now on, so the next loop waits for it even before Rust says so.
      this.phase = "preparing"
      await this.deps.voice.speak(`moment|${line.text}`, line.text).catch(() => {
        this.phase = "idle"
      })
      await this.deps.sleep(BUSY_POLL_MS)
    }
  }
}

function speaks(mode: ReloSettings["voiceMode"]): boolean {
  return mode !== "soundOnly"
}
