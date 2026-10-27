import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { CUES, cueFor, isInterfaceCue, leadOf } from "./cues"
import type { Cue, NotchEvent } from "./cues"
import { CuePlayer, defaultSettings } from "./player"
import type { ContextLike, SoundSettings } from "./player"

function setup(overrides: Partial<SoundSettings> = {}, quiet = false) {
  let clock = 10_000
  const started: { cue: string; gain: number }[] = []
  const settings = { ...defaultSettings(), ...overrides }
  const state = { quiet, ctx: "running" }
  const context: ContextLike = {
    get state() { return state.ctx },
    destination: {},
    resume: async () => undefined,
    decodeAudioData: async (data) => ({ duration: data.byteLength / 1000 }),
    createGain: () => ({ gain: { value: 0 }, connect: () => undefined }),
    createBufferSource: () => ({
      buffer: null,
      connect(node) { (this as unknown as { gainNode: unknown }).gainNode = node },
      start() { started.push({ cue: String((this.buffer as { duration: number }).duration), gain: 0 }) },
      stop() {},
    }),
  }
  const player = new CuePlayer({
    settings: () => settings,
    quiet: () => state.quiet,
    createContext: () => context,
    // Each cue's "file" is 1000 bytes per index+1 -> duration (index + 1) seconds, so the played cue is identifiable.
    load: async (cue: Cue) => new ArrayBuffer((CUES.indexOf(cue) + 1) * 1000),
    now: () => clock,
  })
  const played = () => started.map((s) => CUES[Number(s.cue) - 1])
  return { player, settings, state, played, advance: (ms: number) => { clock += ms }, started }
}

const ev = (kind: NotchEvent["kind"], tone?: string): NotchEvent => ({ kind, tone })

describe("cue mapping", () => {
  it("has the Mac's 19 cues", () => {
    expect(CUES).toHaveLength(19)
    expect(CUES.filter(isInterfaceCue)).toHaveLength(11)
  })

  it("maps moments as ReloMoments.cue(for:)", () => {
    expect(cueFor(ev("question"))).toBe("needs-you")
    expect(cueFor(ev("failed", "failed"))).toBe("failed")
    expect(cueFor(ev("failed", "paused"))).toBeNull()
    expect(cueFor(ev("yourTurn"))).toBe("your-turn")
    expect(cueFor(ev("finished"))).toBe("done")
    expect(cueFor(ev("started"))).toBe("start")
    expect(cueFor(ev("progressed"))).toBeNull()
  })

  it("ranks a burst: question beats failed beats yourTurn beats finished", () => {
    expect(leadOf([ev("started"), ev("finished"), ev("question"), ev("failed", "failed")])?.kind).toBe("question")
    expect(leadOf([ev("finished"), ev("yourTurn")])?.kind).toBe("yourTurn")
    expect(leadOf([ev("failed", "idle"), ev("finished")])?.kind).toBe("finished")
  })

  it("ships a wav for every cue", () => {
    const dir = join(import.meta.dirname, "../../public/sounds")
    expect(readdirSync(dir).sort()).toEqual(CUES.map((c) => `${c}.wav`).sort())
    for (const cue of CUES) expect(readFileSync(join(dir, `${cue}.wav`)).subarray(0, 4).toString()).toBe("RIFF")
  })
})

describe("CuePlayer", () => {
  it("plays the lead of a burst once, at volume 0.6", async () => {
    const { player, played } = setup()
    await player.preload()
    expect(player.playFor([ev("finished"), ev("question"), ev("started")])).toBe("needs-you")
    expect(played()).toEqual(["needs-you"])
  })

  it("sets gain 0.6", async () => {
    const gains: { value: number }[] = []
    const player = new CuePlayer({
      createContext: () => ({
        state: "running", destination: {}, resume: async () => undefined,
        decodeAudioData: async () => ({ duration: 1 }),
        createGain: () => { const gain = { value: 0 }; gains.push(gain); return { gain, connect: () => undefined } },
        createBufferSource: () => ({ buffer: null, connect() {}, start() {}, stop() {} }),
      }),
      load: async () => new ArrayBuffer(1),
    })
    await player.preload()
    player.play("done")
    expect(gains.map((g) => g.value)).toEqual([0.6])
  })

  it("debounces the same cue for 400 ms", async () => {
    const { player, advance, played } = setup()
    await player.preload()
    player.play("tab")
    advance(399)
    expect(player.play("tab")).toBe(false)
    advance(2)
    expect(player.play("tab")).toBe(true)
    expect(played()).toEqual(["tab", "tab"])
  })

  it("keeps a 2 s gap between moment cues", async () => {
    const { player, advance } = setup()
    await player.preload()
    expect(player.playFor([ev("finished")])).toBe("done")
    advance(1999)
    expect(player.playFor([ev("question")])).toBeNull()
    advance(2)
    expect(player.playFor([ev("question")])).toBe("needs-you")
  })

  it("honours the master, interface and per-event switches", async () => {
    const { player, settings, advance } = setup()
    await player.preload()
    settings.events.finished = false
    expect(player.playFor([ev("finished")])).toBeNull()
    settings.interfaceSounds = false
    expect(player.play("tab")).toBe(false)
    expect(player.play("done")).toBe(true)
    advance(5000)
    settings.sounds = false
    expect(player.play("done")).toBe(false)
    expect(player.play("done", { force: true })).toBe(true)
  })

  it("is silent when quiet, and the voice carries all but a start", async () => {
    const { player, state, settings, advance } = setup()
    await player.preload()
    state.quiet = true
    expect(player.playFor([ev("question")])).toBeNull()
    state.quiet = false
    settings.voiceOnly = true
    expect(player.playFor([ev("question")])).toBeNull()
    advance(10)
    expect(player.playFor([ev("started")])).toBe("start")
  })

  it("exposes endsAt for a later voice", async () => {
    const { player } = setup()
    await player.preload()
    player.play("done") // index 2 -> 3 s
    expect(player.endsAt()).toBe(10_000 + 3000)
    expect(player.duration("done")).toBe(3000)
  })

  it("ticks a step once per card per three minutes", async () => {
    const { player, advance, played } = setup()
    await player.preload()
    expect(player.playStep("a")).toBe(true)
    advance(2500)
    expect(player.playStep("a")).toBe(false)
    expect(player.playStep("b")).toBe(true)
    advance(181_000)
    expect(player.playStep("a")).toBe(true)
    expect(played()).toEqual(["update", "update", "update"])
  })

  it("never plays on a locked context or before preload", async () => {
    const { player, state } = setup()
    expect(player.play("done")).toBe(false)
    await player.preload()
    state.ctx = "suspended"
    expect(player.play("done")).toBe(false)
  })
})
