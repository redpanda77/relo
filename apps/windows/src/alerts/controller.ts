// The sensory layer's orchestration: ReloMoments.swift, ported (apps/notch/boringNotch/components/Relo/ReloMoments.swift).
// It watches the notch's presentation (and the owner's connection and answers) and decides, once per moment, which cue,
// which spoken line and which light each change earns. The pure pieces are elsewhere: src/relo/events.ts (what changed),
// src/sound (the cue player and its 2 s / 400 ms / 3 min rules), src/voice (the lines and the queue). This file is the
// ordering between them, with every dependency injected so the rules are tested with fake timers and fake players.

import { eventsBetween, type NotchEvent as ReloEvent } from "../relo/events"
import { isFolded, type Presentation, type Row } from "../relo/presentation"
import type { ReloSettings } from "../settings/store"
import type { Cue } from "../sound/cues"
import { withSpoken } from "../client/view"
import type { SpokenWordsById } from "../relo/presentation"
import type { MomentCard, VoiceEvent } from "../voice/moments"
import * as SpokenLine from "../voice/spokenLine"

/** The slice of the settings the alerts read (at every use, so a changed switch applies at once). */
export type AlertSettings = Pick<ReloSettings, "sounds" | "interfaceSounds" | "voiceMode" | "voiceDetail" | "peek" | "closedActivity">

/** The cue player as the controller uses it (src/sound CuePlayer). */
export interface CuesLike {
  playFor(events: readonly VoiceEvent[], options?: { staged?: boolean }): Cue | null
  play(cue: Cue, options?: { force?: boolean }): boolean
  playStep(cardId: string, options?: { staged?: boolean; voiceBusy?: boolean }): boolean
  playOwnerAct(cue: "linked" | "sent"): boolean
  endsAt(): number
  duration(cue: Cue): number
}

/** The voice orchestration as the controller uses it (src/voice VoiceMoments). */
export interface VoiceLike {
  readonly busy: boolean
  speakFor(events: readonly VoiceEvent[], cards: readonly MomentCard[], options?: { prompts?: Readonly<Record<string, string>> }): Promise<void>
  speakProgress(previous: readonly MomentCard[], next: readonly MomentCard[]): Promise<void>
  observe(cards: readonly MomentCard[], prompts?: Readonly<Record<string, string>>): void
  clear(): void
}

/** What the "Relo is ready" greeting and the play button need of the voice (src/voice ipc). */
export interface SpeechLike {
  speak(lineId: string, text: string): Promise<void>
  cancel(): Promise<void>
  microphoneInUse(): Promise<boolean>
  /** The Relo voice (or the system voice) can speak now. */
  ready(): Promise<boolean>
  /** The id of the line being prepared or played, or null. */
  current(): Promise<string | null>
}

export interface AlertsDeps {
  settings(): AlertSettings
  /** Relo's pause, or a full-screen app in front with the setting on (ReloMoments.quiet). */
  quiet(): boolean
  cues: CuesLike
  voice: VoiceLike
  speech: SpeechLike
  now(): number
  sleep(ms: number): Promise<void>
}

/** What the controller reads at each change. All of it comes from the notch's data (`useRelo`) and the owner view (`useOwner`). */
export interface AlertsInput {
  presentation: Presentation
  /** A summary has been fetched (or a snapshot is shown). Without it the empty state is no baseline. Default: `presentation` is not empty-by-absence. */
  hasData: boolean
  /** The owner client's connection (signingIn to connecting/live plays `linked`). */
  connection?: string
  /** Where each answer stands, by question id; a new `accepted` plays `sent`. */
  answers?: Readonly<Record<string, { state: string }>>
  /** Question prompts by question id (what a "Needs you" line reads). */
  questions?: Readonly<Record<string, { prompt: string }>>
  /** What each card says aloud, by card id (sealed in the card). */
  spoken?: SpokenWordsById
  /** Relo's pause (epoch ms, 0 or absent = not paused). */
  pausedUntil?: number
  /** The latest batch of new notices (the owner client replaces the array per batch): each batch makes the orb breathe until Relo's tab is seen. */
  notices?: readonly unknown[]
  /** The staged onboarding: its moments repeat, every sound plays (only the master switch gates it), nothing is said. */
  staged?: boolean
  /** The staged work's card id (its finished steps always tick). */
  stagedRowId?: string
}

/** The staged onboarding, while it runs in the notch (ReloOnboardingNotch). */
export interface StagedMoments {
  staged: true
  /** The staged work's card id: its finished steps always tick. */
  stagedRowId?: string
}

/** The slice of the owner view (`useOwner().view`) the alerts read. */
export interface OwnerAlerts {
  view: {
    connection?: string
    answers?: AlertsInput["answers"]
    questions?: AlertsInput["questions"]
    spoken?: SpokenWordsById
    pausedUntil?: number
    arrivals?: readonly unknown[]
  }
}

/** The latest new moments, most important first; `serial` changes with every batch (the closed notch's wings and peek follow it). */
export interface Batch {
  serial: number
  events: ReloEvent[]
}

/** The latest card that finished a plan step; `serial` changes with every one (the closed notch's step light). */
export interface Stepped {
  serial: number
  rowId: string | null
}

export interface AlertsState {
  batch: Batch
  stepped: Stepped
  /** A moment arrived that the owner has not seen yet: the orb breathes until the Relo tab opens (`markSeen`). */
  unseen: boolean
  /** Rows with their sealed spoken words filled in. */
  presentation: Presentation
}

export type InterfaceCueName = "turn" | "open" | "close" | "expand" | "collapse" | "launch" | "quit" | "tab" | "section" | "on" | "off"

const key = (event: ReloEvent): string => `${event.kind}|${event.row.id}|${event.row.questionId ?? ""}`
const rowsOf = (p: Presentation): Row[] => p.sections.flatMap((s) => s.rows)
const unfolded = (p: Presentation): Row[] => p.sections.filter((s) => !isFolded(s.kind)).flatMap((s) => s.rows)
const byId = (rows: readonly Row[]): Map<string, Row> => {
  const map = new Map<string, Row>()
  for (const row of rows) if (!map.has(row.id)) map.set(row.id, row)
  return map
}

export class AlertsController {
  private state: AlertsState
  private readonly listeners = new Set<() => void>()
  private previous: Presentation | null = null
  private readonly cued = new Set<string>()
  private lastConnection: string | undefined
  private accepted = new Set<string>()
  private wasStaged = false
  private pausedUntil = 0
  private spokenWords: SpokenWordsById = {}
  private questions: Readonly<Record<string, { prompt: string }>> = {}
  private greeted = false
  private notices: readonly unknown[] | undefined
  private cards: readonly Row[] = []

  private readonly deps: AlertsDeps

  constructor(deps: AlertsDeps, initial: Presentation) {
    this.deps = deps
    this.state = { batch: { serial: 0, events: [] }, stepped: { serial: 0, rowId: null }, unseen: false, presentation: initial }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  getState = (): AlertsState => this.state

  private set(patch: Partial<AlertsState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  /** The Relo tab appeared (ReloMoments.markSeen). */
  markSeen = (): void => {
    if (this.state.unseen) this.set({ unseen: false })
  }

  /** Relo's pause or a full-screen app in front (ReloMoments.quiet): no peeks, notices, sent cue, step ticks, speech. */
  quiet = (): boolean => this.deps.quiet()

  /** The notch may open by itself for a moment (the Peek switch, and not quiet). */
  peekAllowed = (): boolean => this.deps.settings().peek && !this.deps.quiet()

  // --- the moments ------------------------------------------------------------------------------------------

  /** ReloMoments.receive: call at every change of the presentation, the connection or the answers. */
  receive(input: AlertsInput): Promise<void> {
    this.questions = input.questions ?? {}
    this.spokenWords = input.spoken ?? {}
    const presentation = withSpoken(input.presentation, this.spokenWords)
    this.cards = rowsOf(presentation)
    this.trackPause(input.pausedUntil ?? 0)
    this.noticeMoment(input.notices)
    this.signInMoment(input.connection)
    this.answerMoment(input.answers)
    const staged = input.staged === true
    const wasStaged = this.wasStaged
    this.wasStaged = staged
    if (presentation !== this.state.presentation) this.set({ presentation })
    this.deps.voice.observe(this.momentCards(this.cards), this.prompts())
    // Nothing fetched yet (launch, sign-in): the empty state is no baseline. The first real summary is.
    if (!input.hasData && !staged) {
      this.previous = null
      return Promise.resolve()
    }
    // The staged work ended: the server's own rows return silently, as at launch.
    if (wasStaged && !staged) {
      this.previous = presentation
      return Promise.resolve()
    }
    const baseline = this.previous === null && !staged
    const before: Presentation | null = this.previous
    // Once per moment: a question still open, a card still done never cues again (a reconnect, a remount). The staged work
    // repeats its moments (Your turn at every choice), so it is not deduplicated.
    const events = eventsBetween(before, presentation).filter((event) => {
      if (staged) return true
      if (this.cued.has(key(event))) return false
      this.cued.add(key(event))
      return true
    })
    // Progress first, as the Mac does: a queued progress line holds the step tick back (the tick never goes over the voice).
    const progress = before && !staged ? this.deps.voice.speakProgress(rowsOf(before).map((row) => card(row)), this.momentCards(unfolded(presentation))) : Promise.resolve()
    this.previous = presentation
    if (events.length > 0) this.set({ batch: { serial: this.state.batch.serial + 1, events }, ...(baseline ? {} : { unseen: true }) })
    return (async () => {
      await progress.catch(() => undefined)
      if (before) this.stepMoment(before, presentation, staged, input.stagedRowId)
      // The first observation after launch is the baseline: what already waits shows, but makes no sound.
      if (events.length === 0 || baseline) return
      const voiceEvents: VoiceEvent[] = events.map((event) => ({ kind: event.kind, tone: event.row.tone, rowId: event.row.id }))
      if (staged) {
        // The staged onboarding teaches every moment (only the master switch gates it) and is never voiced.
        this.deps.cues.playFor(voiceEvents, { staged: true })
        return
      }
      await this.deps.voice.speakFor(voiceEvents, this.momentCards(this.cards), { prompts: this.prompts() })
    })()
  }

  private prompts(): Record<string, string> {
    const prompts: Record<string, string> = {}
    for (const row of this.cards) {
      const prompt = row.questionId ? this.questions[row.questionId]?.prompt : undefined
      if (row.notificationId && prompt) prompts[row.notificationId] = prompt
    }
    return prompts
  }

  private momentCards(rows: readonly Row[]): MomentCard[] {
    return rows.map((row) => card(row, row.questionId ? this.questions[row.questionId]?.prompt : undefined))
  }

  /** A working card finished a plan step: one faint tick (the cue player holds the 3 min, 2 s and voice rules), and the wings always light. */
  private stepMoment(previous: Presentation, next: Presentation, staged: boolean, stagedRowId?: string): void {
    const before = byId(rowsOf(previous))
    const finished = unfolded(next).filter((row) => {
      const old = before.get(row.id)
      if (row.tone !== "working" || !old || row.stepsDone === null) return false
      if (!(old.tone === "working" || (staged && old.tone === "yourTurn"))) return false
      return row.stepsDone > (old.stepsDone ?? row.stepsDone)
    })
    // The wings light every finished step; the sound stays rare.
    const first = finished[0]
    if (first) this.set({ stepped: { serial: this.state.stepped.serial + 1, rowId: first.id } })
    if (this.deps.quiet()) return
    // The staged onboarding's step always ticks (no throttle, no voice to wait for): the owner pressed Continue.
    if (staged) {
      if (finished.some((row) => row.id === stagedRowId)) this.deps.cues.playStep(stagedRowId ?? "", { staged: true })
      return
    }
    for (const row of finished) this.deps.cues.playStep(row.id, { voiceBusy: this.deps.voice.busy })
  }

  /** New notices (`relo notify`), once per batch: no sound of its own; the orb breathes until Relo's tab is opened (ReloMoments.noticeMoment). The first batch seen is the baseline. */
  private noticeMoment(notices: readonly unknown[] | undefined): void {
    if (notices === undefined || notices === this.notices) return
    const first = this.notices === undefined
    this.notices = notices
    if (!first && notices.length > 0 && !this.state.unseen) this.set({ unseen: true })
  }

  /** Signing in lands: Relo's bloom, once. */
  private signInMoment(connection: string | undefined): void {
    const was = this.lastConnection
    this.lastConnection = connection
    if (was === "signingIn" && (connection === "connecting" || connection === "live")) this.deps.cues.playOwnerAct("linked")
  }

  /** The owner's own answer was accepted: a quiet tap (never needs-you: the owner acting is not news). */
  private answerMoment(answers: AlertsInput["answers"]): void {
    const now = new Set(Object.entries(answers ?? {}).flatMap(([id, phase]) => (phase.state === "accepted" ? [id] : [])))
    const fresh = [...now].filter((id) => !this.accepted.has(id))
    this.accepted = now
    if (fresh.length > 0 && !this.deps.quiet()) this.deps.cues.playOwnerAct("sent")
  }

  /** Alerts were paused: the lines waiting are dropped. */
  private trackPause(until: number): void {
    const was = this.pausedUntil > this.deps.now()
    this.pausedUntil = until
    if (!was && until > this.deps.now()) this.deps.voice.clear()
  }

  // --- the card's play button -----------------------------------------------------------------------------------

  /** The card has a line to say (a play button is worth showing; unreadable or off-level cards have none). */
  canPlay = (row: Row): boolean => this.line(row) !== null

  private line(row: Row): string | null {
    const withWords = this.cardWithWords(row)
    return SpokenLine.text(withWords, { prompt: this.promptOf(row), owner: "full" })
  }

  private promptOf(row: Row): string | null {
    return row.questionId ? (this.questions[row.questionId]?.prompt ?? null) : null
  }

  private cardWithWords(row: Row): Row {
    const words = this.spokenWords[row.id]
    return words && row.spoken === undefined ? { ...row, spoken: words.spoken, spokenName: words.name, spokenVoice: words.voice } : row
  }

  /** The card's play button: its line at the Full detail (the owner asked for it); pressing again while it is said stops it. Never gated by quiet or the microphone. */
  playCard = async (row: Row): Promise<void> => {
    const line = this.line(row)
    if (line === null) return
    const id = `${row.id}|${line}`
    if ((await this.deps.speech.current()) === id) await this.deps.speech.cancel()
    else await this.deps.speech.speak(id, line)
  }

  // --- interface sounds -----------------------------------------------------------------------------------------

  /** An interface cue (the notch opening, a tab, a card unfolding...): the player applies the master and interface switches and the 400 ms rule. */
  interfaceCue = (name: InterfaceCueName): boolean => this.deps.cues.play(name)

  /** Relo opened by the owner (not at login): the launch bloom. */
  launchCue = (options: { atLogin?: boolean } = {}): boolean => (options.atLogin ? false : this.deps.cues.play("launch"))

  /**
   * Quitting plays its sound first (at most 2 s): plays `quit` and returns how long to wait before exiting, in ms; 0 when
   * sounds or interface sounds are off, alerts are quiet, or the sound is not loaded (boringNotchApp.swift:108-116).
   */
  quitSound = (): number => {
    const settings = this.deps.settings()
    if (!settings.sounds || !settings.interfaceSounds || this.deps.quiet()) return 0
    const length = Math.min(this.deps.cues.duration("quit"), 2_000)
    if (length <= 0) return 0
    this.deps.cues.play("quit")
    return length
  }

  /** "Relo is ready", once per launch, when the local server first answers (not at login): after the launch cue ends and 0.25 s (ReloLocalMode.announceReady). */
  greetReady = async (options: { atLogin?: boolean } = {}): Promise<boolean> => {
    if (this.greeted) return false
    this.greeted = true
    const { voiceMode } = this.deps.settings()
    if (options.atLogin || voiceMode === "soundOnly" || this.deps.quiet()) return false
    if ((await this.deps.speech.microphoneInUse()) || !(await this.deps.speech.ready())) return false
    await this.deps.sleep(Math.max(0, this.deps.cues.endsAt() - this.deps.now()) + 250)
    await this.deps.speech.speak("launch|ready", "Relo is ready").catch(() => undefined)
    return true
  }
}

function card(row: Row, prompt?: string): MomentCard {
  return prompt === undefined ? row : { ...row, prompt }
}
