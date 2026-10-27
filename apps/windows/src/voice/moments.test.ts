import { describe, expect, it } from "vitest"
import { EVENT_KINDS, cueFor, type Cue, type NotchEvent, type NotchEventKind } from "../sound/cues"
import { DEFAULTS, type ReloSettings } from "../settings/store"
import type { VoiceState } from "./ipc"
import { AFTER_CUE_MS, VoiceMoments, type MomentCard, type VoiceEvent, type VoiceSettings } from "./moments"

// A virtual clock: sleeping advances it, and a spoken line plays for `LINE_MS` of it.
const LINE_MS = 2_000
const CUE_MS = 600

function rig(settings: Partial<VoiceSettings> = {}) {
  let t = 1_000_000
  let playingUntil = 0
  let cueEnds = Number.NEGATIVE_INFINITY
  let quiet = false
  let mic = false
  let listener: ((s: VoiceState) => void) | null = null
  const log: string[] = []
  const spoken: { at: number; id: string; text: string }[] = []
  const state = (phase: VoiceState["phase"]): VoiceState => ({ phase, id: null, engine: "relo", error: null })
  const current: VoiceSettings = {
    voiceMode: "soundThenVoice",
    voiceDetail: "full",
    sounds: true,
    soundEvents: { ...DEFAULTS.soundEvents },
    ...settings,
  }
  const moments = new VoiceMoments({
    settings: () => current,
    quiet: () => quiet,
    cues: {
      playFor(events: readonly NotchEvent[]): Cue | null {
        const lead = events.find((e) => cueFor(e) !== null)
        const cue = lead ? cueFor(lead) : null
        if (cue) {
          log.push(`cue:${cue}@${t}`)
          cueEnds = t + CUE_MS
        }
        return cue
      },
      play(cue: Cue) {
        log.push(`cue:${cue}@${t}`)
        cueEnds = t + CUE_MS
        return true
      },
      endsAt: () => cueEnds,
    },
    voice: {
      async speak(id, text) {
        spoken.push({ at: t, id, text })
        log.push(`say:${text}`)
        playingUntil = t + LINE_MS
        listener?.(state("playing"))
      },
      async cancel() {},
      async microphoneInUse() {
        return mic
      },
      onState(cb) {
        listener = cb
        return () => void (listener = null)
      },
    },
    now: () => t,
    sleep: async (ms) => {
      t += ms
      if (playingUntil && t >= playingUntil) {
        playingUntil = 0
        listener?.(state("idle"))
      }
    },
  })
  moments.attach()
  return {
    moments,
    log,
    spoken,
    now: () => t,
    setQuiet: (v: boolean) => (quiet = v),
    setMic: (v: boolean) => (mic = v),
    settings: current,
    /** Lets a pending queue run to its end (the virtual clock moves on its own as the queue sleeps). */
    async drain() {
      for (let i = 0; i < 200; i++) await Promise.resolve()
      // The queue's own loop sleeps through the virtual clock; give it microtask turns until it is done.
      for (let i = 0; i < 200 && moments.busy; i++) await new Promise((r) => setTimeout(r, 0))
    },
  }
}

const card = (id: string, extra: Partial<MomentCard> = {}): MomentCard => ({
  id,
  title: "Redesign the open notch view",
  tone: "done",
  unreadable: false,
  currentStep: null,
  stepsDone: null,
  stepsTotal: null,
  spokenName: "Notch redesign",
  spoken: "Every gate passed and the build is ready.",
  notificationId: null,
  questionPending: false,
  ...extra,
})
const event = (kind: NotchEventKind, rowId: string, tone?: string): VoiceEvent => ({ kind, rowId, tone })

describe("voice modes", () => {
  it("sound only plays the cue and says nothing", async () => {
    const r = rig({ voiceMode: "soundOnly" })
    await r.moments.speakFor([event("finished", "a")], [card("a")])
    await r.drain()
    expect(r.log).toEqual([`cue:done@${r.log[0]!.split("@")[1]}`])
    expect(r.spoken).toHaveLength(0)
  })

  it("sound then voice waits for the cue to end, then says the kind, the name and the gist", async () => {
    const r = rig()
    const start = r.now()
    await r.moments.speakFor([event("finished", "a")], [card("a")])
    await r.drain()
    expect(r.log[0]).toBe(`cue:done@${start}`)
    expect(r.spoken).toHaveLength(1)
    expect(r.spoken[0]!.text).toBe("Finished: Notch redesign. Every gate passed and the build is ready.")
    expect(r.spoken[0]!.at).toBeGreaterThanOrEqual(start + CUE_MS + AFTER_CUE_MS)
    expect(r.spoken[0]!.id).toBe("moment|" + r.spoken[0]!.text)
  })

  it("sound as the kind starts the line at the name", async () => {
    const r = rig({ voiceMode: "soundAsKind" })
    await r.moments.speakFor([event("finished", "a")], [card("a")])
    await r.drain()
    expect(r.spoken[0]!.text).toBe("Notch redesign. Every gate passed and the build is ready.")
  })

  it("voice only says the kind in the line", async () => {
    const r = rig({ voiceMode: "voiceOnly" })
    await r.moments.speakFor([event("finished", "a")], [card("a")])
    await r.drain()
    expect(r.spoken[0]!.text.startsWith("Finished: Notch redesign.")).toBe(true)
  })
})

describe("detail", () => {
  it("Brief says the kind and the name; Full adds the gist", async () => {
    const brief = rig({ voiceDetail: "brief" })
    await brief.moments.speakFor([event("finished", "a")], [card("a")])
    await brief.drain()
    expect(brief.spoken[0]!.text).toBe("Finished: Notch redesign.")
  })

  it("a question says its prompt's first sentence while it is open", async () => {
    const r = rig()
    const q = card("a", { tone: "needsYou", spoken: null, notificationId: "ntf_1", questionPending: true })
    await r.moments.speakFor([event("question", "a")], [q], { prompts: { ntf_1: "Allow Bash: npm run public:check?" } })
    await r.drain()
    expect(r.spoken[0]!.text).toBe("Needs you: Notch redesign. Allow Bash?")
  })

  it("Every step says a finished step, once per card every 45 seconds, and only at that detail", async () => {
    const working = (done: number) =>
      card("w", { tone: "working", spoken: null, currentStep: "Build the list", stepsDone: done, stepsTotal: 5 })
    const full = rig({ voiceDetail: "full" })
    await full.moments.speakProgress([working(2)], [working(3)])
    await full.drain()
    expect(full.spoken).toHaveLength(0)

    const r = rig({ voiceDetail: "verbose" })
    await r.moments.speakProgress([working(2)], [working(3)])
    await r.drain()
    expect(r.spoken.map((s) => s.text)).toEqual(["Working: Notch redesign. 3 of 5 done, now build the list."])
    await r.moments.speakProgress([working(3)], [working(4)])
    await r.drain()
    expect(r.spoken).toHaveLength(1)
  })
})

describe("quiet rules", () => {
  it("paused or full screen: no line", async () => {
    const r = rig()
    r.setQuiet(true)
    await r.moments.speakFor([event("finished", "a")], [card("a")])
    await r.drain()
    expect(r.spoken).toHaveLength(0)
  })

  it("a microphone in use: no line, the queue is dropped, the cue still plays", async () => {
    const r = rig()
    r.setMic(true)
    await r.moments.speakFor([event("finished", "a")], [card("a")])
    await r.drain()
    expect(r.spoken).toHaveLength(0)
    expect(r.log.filter((l) => l.startsWith("cue:"))).toHaveLength(1)
  })

  it("a start only ticks, and a kind whose switch is off is not said", async () => {
    const r = rig()
    await r.moments.speakFor([event("started", "a")], [card("a", { tone: "working" })])
    await r.drain()
    expect(r.spoken).toHaveLength(0)
    const off = rig()
    off.settings.soundEvents = { ...off.settings.soundEvents, finished: false }
    await off.moments.speakFor([event("finished", "a")], [card("a")])
    await off.drain()
    expect(off.spoken).toHaveLength(0)
  })

  it("a sealed card this PC could not open says nothing", async () => {
    const r = rig()
    await r.moments.speakFor([event("finished", "a")], [card("a", { unreadable: true })])
    await r.drain()
    expect(r.spoken).toHaveLength(0)
  })
})

describe("the queue", () => {
  it("a burst says two lines, then a count", async () => {
    const r = rig()
    const cards = ["a", "b", "c"].map((id) => card(id))
    await r.moments.speakFor(
      ["a", "b", "c"].map((id) => event("finished", id)),
      cards,
    )
    await r.drain()
    expect(r.spoken).toHaveLength(3)
    expect(r.spoken[2]!.text).toBe("And 1 more update.")
  })

  it("an answered question is not said when its turn comes", async () => {
    const r = rig()
    const f = card("f", { tone: "done" })
    const q = card("q", { tone: "needsYou", spoken: null, notificationId: "ntf_1", questionPending: true })
    await r.moments.speakFor([event("finished", "f")], [f])
    await r.moments.speakFor([event("question", "q")], [f, q], { prompts: { ntf_1: "Deploy now?" } })
    // The owner answers while the first line plays.
    r.moments.observe([f, { ...q, questionPending: false }])
    await r.drain()
    expect(r.spoken.map((s) => s.text.split(":")[0])).toEqual(["Finished"])
  })

  it("while a line is being said the next update's cue waits and rides its own line", async () => {
    const r = rig()
    await r.moments.speakFor([event("finished", "a")], [card("a")])
    // Line a is queued or playing: busy.
    expect(r.moments.busy).toBe(true)
    const before = r.log.filter((l) => l.startsWith("cue:")).length
    await r.moments.speakFor([event("yourTurn", "b")], [card("a"), card("b", { tone: "yourTurn" })])
    expect(r.log.filter((l) => l.startsWith("cue:"))).toHaveLength(before)
    await r.drain()
    const order = r.log.map((l) => l.split("@")[0]!.replace(/^say:(\w+).*/, "say:$1"))
    expect(order).toEqual(["cue:done", "say:Finished", "cue:your-turn", "say:Your"])
  })

  it("covers every event kind a moment can have", () => {
    expect(EVENT_KINDS).toContain("progressed")
    const settings: ReloSettings = DEFAULTS
    expect(Object.keys(settings.soundEvents).sort()).toEqual([...EVENT_KINDS].sort())
  })
})
