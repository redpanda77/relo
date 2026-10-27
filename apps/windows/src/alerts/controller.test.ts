// ReloMoments' orchestration, rule by rule, with the real cue player and the real voice orchestration on a virtual clock and fake
// audio / voice backends. Mac references are ReloMoments.swift line numbers (apps/notch/boringNotch/components/Relo).

import { describe, expect, it } from "vitest"
import { EMPTY, type Presentation, type Row, type Section, type SectionKind, type Tone } from "../relo/presentation"
import { DEFAULTS, toSoundSettings, type ReloSettings } from "../settings/store"
import { CUES, type Cue } from "../sound/cues"
import { CuePlayer } from "../sound/player"
import type { VoiceState } from "../voice/ipc"
import { VoiceMoments } from "../voice/moments"
import { AlertsController, type AlertsInput } from "./controller"

const CUE_MS = 600
const LINE_MS = 2_000

function rig(over: Partial<ReloSettings> = {}) {
  let t = 1_000_000
  let playingUntil = 0
  let quiet = false
  let mic = false
  let ready = true
  let listener: ((s: VoiceState) => void) | null = null
  const log: string[] = []
  const settings: ReloSettings = { ...DEFAULTS, soundEvents: { ...DEFAULTS.soundEvents }, ...over }
  const state = (phase: VoiceState["phase"]): VoiceState => ({ phase, id: null, engine: "relo", error: null })
  const player = new CuePlayer({
    settings: () => toSoundSettings(settings),
    quiet: () => quiet,
    createContext: () => ({
      state: "running",
      destination: {},
      resume: async () => undefined,
      decodeAudioData: async (data) => ({ duration: data.byteLength / 1000 }),
      createGain: () => ({ gain: { value: 0 }, connect: () => undefined }),
      createBufferSource: () => ({
        buffer: null,
        connect: () => undefined,
        start() {
          const index = Math.round((this.buffer as { duration: number }).duration * 1000 / CUE_MS) - 1
          log.push(`cue:${CUES[index]}`)
        },
        stop() {},
      }),
    }),
    // Every file lasts CUE_MS; the index rides the byte length so the played cue is identifiable.
    load: async (cue: Cue) => new ArrayBuffer((CUES.indexOf(cue) + 1) * CUE_MS),
    now: () => t,
  })
  const backend = {
    async speak(id: string, text: string) {
      log.push(`say:${text}`)
      void id
      playingUntil = t + LINE_MS
      listener?.(state("playing"))
    },
    async cancel() {
      log.push("cancel")
      playingUntil = 0
      listener?.(state("idle"))
    },
    async microphoneInUse() {
      return mic
    },
    onState(cb: (s: VoiceState) => void) {
      listener = cb
      return () => void (listener = null)
    },
  }
  const sleep = async (ms: number) => {
    t += ms
    if (playingUntil && t >= playingUntil) {
      playingUntil = 0
      listener?.(state("idle"))
    }
  }
  const voice = new VoiceMoments({ settings: () => settings, quiet: () => quiet, cues: player, voice: backend, now: () => t, sleep })
  voice.attach()
  let current: string | null = null
  const controller = new AlertsController(
    {
      settings: () => settings,
      quiet: () => quiet,
      cues: player,
      voice,
      speech: {
        speak: async (id, text) => {
          current = id
          await backend.speak(id, text)
        },
        cancel: async () => {
          current = null
          await backend.cancel()
        },
        microphoneInUse: async () => mic,
        ready: async () => ready,
        current: async () => current,
      },
      now: () => t,
      sleep,
    },
    EMPTY,
  )
  return {
    controller,
    log,
    settings,
    player,
    now: () => t,
    advance: (ms: number) => void (t += ms),
    setQuiet: (v: boolean) => void (quiet = v),
    setMic: (v: boolean) => void (mic = v),
    setReady: (v: boolean) => void (ready = v),
    async load() {
      await player.preload()
    },
    async drain() {
      for (let i = 0; i < 300; i++) await Promise.resolve()
      for (let i = 0; i < 300 && voice.busy; i++) await new Promise((r) => setTimeout(r, 0))
    },
    /** Sends one observation to the controller. */
    async feed(input: Partial<AlertsInput> & { presentation: Presentation }) {
      controller.receive({ hasData: true, ...input })
      await this.drain()
    },
  }
}

const row = (id: string, tone: Tone, extra: Partial<Row> = {}): Row => ({
  id,
  title: `Work ${id}`,
  status: null,
  project: null,
  source: null,
  tone,
  stepsDone: null,
  stepsTotal: null,
  currentStep: null,
  startedAt: 0,
  questionId: null,
  notificationId: null,
  questionPending: false,
  unreadable: false,
  questionMissed: false,
  computerIcon: null,
  declaredAt: 0,
  roundOutcome: null,
  outline: null,
  currentIndex: null,
  currentFill: null,
  ...extra,
})

const SECTION: Record<Tone, SectionKind> = {
  needsYou: "needsYou", yourTurn: "waitingOnYou", working: "running", done: "recent", failed: "recent", dropped: "recent",
  leftUnfinished: "recent", quiet: "quiet", paused: "paused",
}
function pres(...rows: Row[]): Presentation {
  const sections: Section[] = []
  for (const r of rows) {
    const kind = SECTION[r.tone]
    const found = sections.find((s) => s.kind === kind)
    if (found) found.rows.push(r)
    else sections.push({ kind, rows: [r] })
  }
  return { ...EMPTY, sections }
}
const asking = (id: string, qid = "q1") => row(id, "needsYou", { questionId: qid, notificationId: `n_${qid}`, questionPending: true })
const cues = (log: string[]) => log.filter((l) => l.startsWith("cue:")).map((l) => l.slice(4))
const said = (log: string[]) => log.filter((l) => l.startsWith("say:")).map((l) => l.slice(4))

describe("moments and their cues (receive, lines 120-175)", () => {
  it("the first summary after launch is a baseline: a waiting question shows but makes no sound", async () => {
    const r = rig()
    await r.load()
    await r.feed({ presentation: pres(asking("a")) })
    expect(r.controller.getState().batch.events.map((e) => e.kind)).toEqual(["question"])
    expect(r.controller.getState().unseen).toBe(false)
    expect(r.log).toEqual([])
  })

  it("nothing fetched yet is no baseline: the first real summary is", async () => {
    const r = rig()
    await r.load()
    await r.feed({ presentation: EMPTY, hasData: false })
    await r.feed({ presentation: pres(asking("a")) })
    expect(r.log).toEqual([])
    r.advance(3_000)
    await r.feed({ presentation: pres(asking("a"), asking("b", "q2")) })
    expect(cues(r.log)).toEqual(["needs-you"])
  })

  it("a new question cues once and marks the orb unseen until the Relo tab opens", async () => {
    const r = rig()
    await r.load()
    await r.feed({ presentation: pres() })
    r.advance(3_000)
    await r.feed({ presentation: pres(asking("a")) })
    expect(cues(r.log)).toEqual(["needs-you"])
    expect(r.controller.getState().unseen).toBe(true)
    r.controller.markSeen()
    expect(r.controller.getState().unseen).toBe(false)
    // The same question again (a reconnect) is not a new moment.
    r.advance(3_000)
    await r.feed({ presentation: pres() })
    await r.feed({ presentation: pres(asking("a")) })
    expect(cues(r.log)).toEqual(["needs-you"])
  })

  it("the highest moment of a burst wins and a second cue within 2 s is dropped", async () => {
    const r = rig()
    await r.load()
    await r.feed({ presentation: pres() })
    r.advance(3_000)
    await r.feed({ presentation: pres(row("a", "done"), asking("b"), row("c", "working")) })
    expect(cues(r.log)).toEqual(["needs-you"])
    r.advance(500)
    await r.feed({ presentation: pres(row("a", "done"), asking("b"), row("c", "working"), row("d", "yourTurn")) })
    expect(cues(r.log)).toEqual(["needs-you"])
  })

  it("the per-event switches and the master switch mute their cue", async () => {
    const r = rig({ soundEvents: { ...DEFAULTS.soundEvents, finished: false } })
    await r.load()
    await r.feed({ presentation: pres() })
    r.advance(3_000)
    await r.feed({ presentation: pres(row("a", "done")) })
    expect(r.log).toEqual([])
    r.settings.sounds = false
    r.advance(3_000)
    await r.feed({ presentation: pres(row("a", "done"), asking("b")) })
    expect(r.log).toEqual([])
  })

  it("dropped or unfinished work is silent; failed work is heard; a start ticks", async () => {
    const r = rig()
    await r.load()
    await r.feed({ presentation: pres() })
    r.advance(3_000)
    await r.feed({ presentation: pres(row("a", "dropped")) })
    expect(r.log).toEqual([])
    r.advance(3_000)
    await r.feed({ presentation: pres(row("a", "dropped"), row("b", "failed")) })
    expect(cues(r.log)).toEqual(["failed"])
    r.advance(3_000)
    await r.feed({ presentation: pres(row("a", "dropped"), row("b", "failed"), row("c", "working")) })
    expect(cues(r.log)).toEqual(["failed", "start"])
  })
})

describe("sound and voice (modes, ordering)", () => {

  it("sound only plays the cue and says nothing", async () => {
    const r = rig({ voiceMode: "soundOnly" })
    await r.load()
    await r.feed({ presentation: pres() })
    r.advance(3_000)
    await r.feed({ presentation: pres(row("a", "done")), spoken: { a: { spoken: "Fixed.", name: "Login crash", voice: null } } })
    expect(r.log).toEqual(["cue:done"])
  })

  it("sound then voice: the cue, then the line after it ends plus 0.25 s", async () => {
    const r = rig({ voiceMode: "soundThenVoice", voiceDetail: "full" })
    await r.load()
    await r.feed({ presentation: pres() })
    r.advance(3_000)
    const before = r.now()
    await r.feed({ presentation: pres(row("a", "done")), spoken: { a: { spoken: "Fixed and tested.", name: "Login crash", voice: null } } })
    expect(r.log).toEqual(["cue:done", "say:Finished: Login crash. Fixed and tested."])
    expect(r.now() - before).toBeGreaterThanOrEqual(CUE_MS + 250)
  })

  it("sound as the kind: the cue says the kind, the line starts at the name", async () => {
    const r = rig({ voiceMode: "soundAsKind" })
    await r.load()
    await r.feed({ presentation: pres() })
    r.advance(3_000)
    await r.feed({ presentation: pres(row("a", "done")), spoken: { a: { spoken: "Fixed.", name: "Login crash", voice: null } } })
    expect(r.log).toEqual(["cue:done", "say:Login crash. Fixed."])
  })

  it("voice only: no cue (the line says the kind), but a start still ticks and is never said", async () => {
    const r = rig({ voiceMode: "voiceOnly" })
    await r.load()
    await r.feed({ presentation: pres() })
    r.advance(3_000)
    await r.feed({ presentation: pres(row("a", "done")), spoken: { a: { spoken: "Fixed.", name: "Login crash", voice: null } } })
    expect(r.log).toEqual(["say:Finished: Login crash. Fixed."])
    r.advance(3_000)
    await r.feed({ presentation: pres(row("a", "done"), row("w", "working")) })
    expect(r.log).toEqual(["say:Finished: Login crash. Fixed.", "cue:start"])
  })

  it("Brief says the kind and the name; the card's own voice level lowers the owner's, never raises it", async () => {
    const brief = rig({ voiceMode: "soundThenVoice", voiceDetail: "brief" })
    await brief.load()
    await brief.feed({ presentation: pres() })
    brief.advance(3_000)
    await brief.feed({ presentation: pres(row("a", "done")), spoken: { a: { spoken: "Fixed.", name: "Login crash", voice: null } } })
    expect(said(brief.log)).toEqual(["Finished: Login crash."])

    const low = rig({ voiceMode: "soundThenVoice", voiceDetail: "verbose" })
    await low.load()
    await low.feed({ presentation: pres() })
    low.advance(3_000)
    await low.feed({ presentation: pres(row("a", "done")), spoken: { a: { spoken: "Fixed.", name: "Login crash", voice: "brief" } } })
    expect(said(low.log)).toEqual(["Finished: Login crash."])
  })

  it("a card whose voice is off says nothing, but its cue still plays", async () => {
    const r = rig({ voiceMode: "soundThenVoice", voiceDetail: "verbose" })
    await r.load()
    await r.feed({ presentation: pres() })
    r.advance(3_000)
    await r.feed({ presentation: pres(row("a", "done")), spoken: { a: { spoken: "Fixed.", name: "Login crash", voice: "off" } } })
    expect(r.log).toEqual(["cue:done"])
  })

  it("a question reads its prompt from the owner's questions", async () => {
    const r = rig({ voiceMode: "soundThenVoice", voiceDetail: "full" })
    await r.load()
    await r.feed({ presentation: pres() })
    r.advance(3_000)
    await r.feed({
      presentation: pres(asking("a")),
      spoken: { a: { spoken: null, name: "Release", voice: null } },
      questions: { q1: { prompt: "Approve the deploy? It touches billing." } },
    })
    expect(r.log[0]).toBe("cue:needs-you")
    expect(said(r.log)[0]).toBe("Needs you: Release. Approve the deploy?")
  })

  it("a busy voice defers the next cue to right before its own line", async () => {
    const r = rig({ voiceMode: "soundThenVoice", voiceDetail: "full" })
    await r.load()
    await r.feed({ presentation: pres() })
    r.advance(3_000)
    const spoken = { a: { spoken: "One.", name: "First", voice: null }, b: { spoken: "Two.", name: "Second", voice: null } } as const
    r.controller.receive({ hasData: true, presentation: pres(row("a", "done")), spoken })
    for (let i = 0; i < 30; i++) await Promise.resolve()
    // The first update's line is being prepared; a second moment arrives meanwhile.
    r.advance(3_000)
    r.controller.receive({ hasData: true, presentation: pres(row("a", "done"), asking("b")), spoken })
    await r.drain()
    expect(r.log).toEqual(["cue:done", "say:Finished: First. One.", "cue:needs-you", "say:Needs you: Second."])
  })
})

describe("progress and the step tick (stepMoment, lines 204-250)", () => {
  const working = (done: number, extra: Partial<Row> = {}) => row("a", "working", { stepsDone: done, stepsTotal: 5, currentStep: "Build the list", ...extra })

  it("a finished step ticks `update` once per card per 3 minutes, and the wings light every time", async () => {
    const r = rig()
    await r.load()
    await r.feed({ presentation: pres(working(1)) })
    r.advance(3_000)
    await r.feed({ presentation: pres(working(2)) })
    expect(cues(r.log)).toEqual(["update"])
    expect(r.controller.getState().stepped).toEqual({ serial: 1, rowId: "a" })
    r.advance(60_000)
    await r.feed({ presentation: pres(working(3)) })
    expect(cues(r.log)).toEqual(["update"])
    expect(r.controller.getState().stepped.serial).toBe(2)
    r.advance(130_000)
    await r.feed({ presentation: pres(working(4)) })
    expect(cues(r.log)).toEqual(["update", "update"])
  })

  it("never ticks when quiet or when the Step switch is off, but still lights the wings", async () => {
    const r = rig({ soundEvents: { ...DEFAULTS.soundEvents, progressed: false } })
    await r.load()
    await r.feed({ presentation: pres(working(1)) })
    r.advance(3_000)
    await r.feed({ presentation: pres(working(2)) })
    expect(r.log).toEqual([])
    expect(r.controller.getState().stepped.serial).toBe(1)
    r.settings.soundEvents.progressed = true
    r.setQuiet(true)
    r.advance(3_000)
    await r.feed({ presentation: pres(working(3)) })
    expect(r.log).toEqual([])
  })

  it("does not tick over a cue (the 2 s gap)", async () => {
    const r = rig()
    await r.load()
    await r.feed({ presentation: pres(working(1)) })
    r.advance(3_000)
    await r.feed({ presentation: pres(working(1), row("d", "done")) })
    expect(cues(r.log)).toEqual(["done"])
    r.advance(500)
    await r.feed({ presentation: pres(working(2), row("d", "done")) })
    expect(cues(r.log)).toEqual(["done"])
  })

  it("the Every step detail says the finished step; Full does not", async () => {
    const verbose = rig({ voiceMode: "soundThenVoice", voiceDetail: "verbose" })
    await verbose.load()
    await verbose.feed({ presentation: pres(working(2, { spokenName: "Notch redesign" })) })
    verbose.advance(3_000)
    await verbose.feed({ presentation: pres(working(3, { spokenName: "Notch redesign" })) })
    expect(said(verbose.log)).toEqual(["Working: Notch redesign. 3 of 5 done, now build the list."])
    // The queued line holds the faint tick back: it never goes over the voice (ReloMoments.stepMoment).
    expect(cues(verbose.log)).toEqual([])

    const full = rig({ voiceMode: "soundThenVoice", voiceDetail: "full" })
    await full.load()
    await full.feed({ presentation: pres(working(2)) })
    full.advance(3_000)
    await full.feed({ presentation: pres(working(3)) })
    expect(said(full.log)).toEqual([])
  })

  it("the staged onboarding always ticks its step, ignoring the throttle and the switch", async () => {
    const r = rig({ soundEvents: { ...DEFAULTS.soundEvents, progressed: false } })
    await r.load()
    const staged = (tone: Tone, done: number) => row("onboarding", tone, { stepsDone: done, stepsTotal: 4 })
    await r.feed({ presentation: pres(staged("yourTurn", 1)), staged: true, stagedRowId: "onboarding" })
    await r.feed({ presentation: pres(staged("working", 2)), staged: true, stagedRowId: "onboarding" })
    r.advance(500)
    await r.feed({ presentation: pres(staged("yourTurn", 2)), staged: true, stagedRowId: "onboarding" })
    r.advance(500)
    await r.feed({ presentation: pres(staged("working", 3)), staged: true, stagedRowId: "onboarding" })
    expect(cues(r.log).filter((c) => c === "update")).toHaveLength(2)
  })
})

describe("owner acts and quiet rules", () => {
  it("signing in lands: `linked`; an accepted answer: `sent`, but not when quiet", async () => {
    const r = rig()
    await r.load()
    await r.feed({ presentation: EMPTY, hasData: false, connection: "signingIn" })
    await r.feed({ presentation: EMPTY, hasData: false, connection: "connecting" })
    expect(cues(r.log)).toEqual(["linked"])
    await r.feed({ presentation: pres(), answers: { q1: { state: "sending" } } })
    await r.feed({ presentation: pres(), answers: { q1: { state: "accepted" } } })
    expect(cues(r.log)).toEqual(["linked", "sent"])
    r.advance(1_000)
    r.setQuiet(true)
    await r.feed({ presentation: pres(), answers: { q1: { state: "accepted" }, q2: { state: "accepted" } } })
    expect(cues(r.log)).toEqual(["linked", "sent"])
  })

  it("Relo's pause or a full-screen app silences cues and speech", async () => {
    const r = rig({ voiceMode: "soundThenVoice" })
    await r.load()
    await r.feed({ presentation: pres() })
    r.advance(3_000)
    r.setQuiet(true)
    await r.feed({ presentation: pres(asking("a")) })
    expect(r.log).toEqual([])
    expect(r.controller.quiet()).toBe(true)
    expect(r.controller.peekAllowed()).toBe(false)
    r.setQuiet(false)
    expect(r.controller.peekAllowed()).toBe(true)
    r.settings.peek = false
    expect(r.controller.peekAllowed()).toBe(false)
  })

  it("a microphone in use keeps the voice quiet; the cue still plays", async () => {
    const r = rig({ voiceMode: "soundThenVoice" })
    await r.load()
    await r.feed({ presentation: pres() })
    r.advance(3_000)
    r.setMic(true)
    await r.feed({ presentation: pres(row("a", "done")), spoken: { a: { spoken: "Fixed.", name: "Login crash", voice: null } } })
    expect(r.log).toEqual(["cue:done"])
  })

  it("pausing alerts drops the lines waiting", async () => {
    const r = rig({ voiceMode: "soundThenVoice" })
    await r.load()
    await r.feed({ presentation: pres() })
    r.advance(3_000)
    const spoken = { a: { spoken: "Fixed.", name: "Login crash", voice: null } }
    r.controller.receive({ hasData: true, presentation: pres(row("a", "done")), spoken })
    r.controller.receive({ hasData: true, presentation: pres(row("a", "done")), spoken, pausedUntil: r.now() + 3_600_000 })
    r.setQuiet(true)
    await r.drain()
    expect(said(r.log)).toEqual([])
  })
})

describe("the play button and interface sounds", () => {
  it("plays the card's line at Full, stops it when pressed again, and ignores quiet and the microphone", async () => {
    const r = rig({ voiceMode: "soundOnly", voiceDetail: "brief" })
    r.setQuiet(true)
    r.setMic(true)
    const card = row("a", "done", { spokenName: "Login crash", spoken: "Fixed and tested." })
    r.controller.receive({ hasData: true, presentation: pres(card) })
    expect(r.controller.canPlay(card)).toBe(true)
    await r.controller.playCard(card)
    expect(said(r.log)).toEqual(["Finished: Login crash. Fixed and tested."])
    await r.controller.playCard(card)
    expect(r.log.at(-1)).toBe("cancel")
  })

  it("a card whose words arrived sealed is read from the controller's words; unreadable cards have no play button", () => {
    const r = rig()
    const plain = row("a", "done")
    r.controller.receive({ hasData: true, presentation: pres(plain), spoken: { a: { spoken: "Fixed.", name: "Login crash", voice: null } } })
    expect(r.controller.getState().presentation.sections[0]!.rows[0]).toMatchObject({ spokenName: "Login crash", spoken: "Fixed." })
    expect(r.controller.canPlay(plain)).toBe(true)
    expect(r.controller.canPlay(row("b", "done", { unreadable: true }))).toBe(false)
  })

  it("interface cues obey the master and interface switches", async () => {
    const r = rig()
    await r.load()
    expect(r.controller.interfaceCue("open")).toBe(true)
    r.advance(500)
    r.settings.interfaceSounds = false
    expect(r.controller.interfaceCue("tab")).toBe(false)
    r.settings.interfaceSounds = true
    r.settings.sounds = false
    expect(r.controller.interfaceCue("tab")).toBe(false)
    expect(cues(r.log)).toEqual(["open"])
  })

  it("launch plays unless Relo started at login; quit waits for its sound (at most 2 s) only when sounds are on and not quiet", async () => {
    const r = rig()
    await r.load()
    expect(r.controller.launchCue({ atLogin: true })).toBe(false)
    expect(r.controller.launchCue()).toBe(true)
    expect(r.controller.quitSound()).toBe(2_000)
    expect(cues(r.log)).toEqual(["launch", "quit"])
    r.setQuiet(true)
    expect(r.controller.quitSound()).toBe(0)
    r.setQuiet(false)
    r.settings.interfaceSounds = false
    expect(r.controller.quitSound()).toBe(0)
  })

  it("`Relo is ready` is said once, after the launch cue, only in a speaking mode, not at login, not quiet, with the voice ready", async () => {
    const quietCase = rig({ voiceMode: "soundThenVoice" })
    quietCase.setQuiet(true)
    expect(await quietCase.controller.greetReady()).toBe(false)

    const login = rig({ voiceMode: "soundThenVoice" })
    expect(await login.controller.greetReady({ atLogin: true })).toBe(false)

    const silent = rig({ voiceMode: "soundOnly" })
    expect(await silent.controller.greetReady()).toBe(false)

    const notReady = rig({ voiceMode: "soundThenVoice" })
    notReady.setReady(false)
    expect(await notReady.controller.greetReady()).toBe(false)

    const r = rig({ voiceMode: "soundThenVoice" })
    await r.load()
    r.controller.launchCue()
    const start = r.now()
    expect(await r.controller.greetReady()).toBe(true)
    expect(r.log).toEqual(["cue:launch", "say:Relo is ready"])
    expect(r.now() - start).toBeGreaterThanOrEqual(CUE_MS + 250)
    expect(await r.controller.greetReady()).toBe(false)
  })
})

describe("the one quiet rule (ReloMoments.quiet, lines 305-312)", () => {
  it("is Relo's pause, or a full-screen app in front while the setting is on", async () => {
    const { isQuiet, quiet } = await import("../sound")
    const { settingsStore } = await import("../settings/store")
    expect(isQuiet(0)).toBe(false)
    quiet.fullscreen = true
    expect(isQuiet()).toBe(true)
    settingsStore.update({ quietInFullScreen: false })
    expect(isQuiet()).toBe(false)
    settingsStore.update({ quietInFullScreen: true })
    quiet.fullscreen = false
    quiet.pausedUntil = Date.now() + 60_000
    expect(isQuiet()).toBe(true)
    expect(isQuiet(quiet.pausedUntil + 1)).toBe(false)
    quiet.pausedUntil = 0
  })
})

describe("notices (ReloMoments.noticeMoment, N04)", () => {
  it("a new batch of notices marks the orb unseen with no sound; the first batch is the baseline", async () => {
    const r = rig()
    await r.load()
    await r.feed({ presentation: pres(), notices: [] })
    expect(r.controller.getState().unseen).toBe(false)
    const batch = [{ id: "n1" }]
    await r.feed({ presentation: pres(), notices: [] }) // the empty array at launch is the baseline
    expect(r.controller.getState().unseen).toBe(false)
    await r.feed({ presentation: pres(), notices: batch })
    expect(r.controller.getState().unseen).toBe(true)
    expect(r.log).toEqual([])
    r.controller.markSeen()
    await r.feed({ presentation: pres(), notices: batch }) // the same array again (a re-render): nothing
    expect(r.controller.getState().unseen).toBe(false)
    await r.feed({ presentation: pres(), notices: [] }) // an emptied batch is not news
    expect(r.controller.getState().unseen).toBe(false)
    await r.feed({ presentation: pres(), notices: [{ id: "n2" }] })
    expect(r.controller.getState().unseen).toBe(true)
    r.controller.markSeen()
    expect(r.controller.getState().unseen).toBe(false)
  })
})
