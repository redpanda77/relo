import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import type { Tone } from "../relo/presentation"
import { MAX_LENGTH, clean, progress, strip, text, type SpokenCard } from "./spokenLine"

// What the notch says (ADR 0015): "<Kind>: <name>. <gist>", held to the CLI's golden file so the CLI, the Mac and Windows agree.
interface Golden {
  label: string
  kind: string
  goal: string
  name?: string
  prompt?: string
  step?: string
  gist?: string
  line: string
}

const goldens: Golden[] = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../../../../packages/cli/test/fixtures/spoken-lines.json"), "utf8"),
).cases

const TONES: Record<string, Tone> = {
  question: "needsYou",
  failed: "failed",
  yourTurn: "yourTurn",
  finished: "done",
  working: "working",
  paused: "paused",
  stopped: "dropped",
}

function card(title: string, tone: Tone, extra: Partial<SpokenCard> = {}): SpokenCard {
  return { id: "wrk_1", title, tone, unreadable: false, currentStep: null, stepsDone: null, stepsTotal: null, ...extra }
}

describe("the golden file", () => {
  it("is read", () => {
    expect(goldens.length).toBeGreaterThanOrEqual(15)
  })

  // The Mac takes the CLI's gist as the card's sealed `spoken` (deliver, finish), or composes it from the prompt (a question) or
  // the current step (the play button), then frames the line.
  it.each(goldens.map((g) => [g.label, g] as const))("%s", (_label, golden) => {
    const tone = TONES[golden.kind]
    expect(tone, golden.kind).toBeDefined()
    const sealed = ["failed", "yourTurn", "finished"].includes(golden.kind) ? golden.gist : undefined
    const c = card(golden.goal, tone!, { spokenName: golden.name, currentStep: golden.step ?? null, spoken: sealed })
    expect(text(c, { prompt: golden.prompt })).toBe(golden.line)
  })

  it("every line starts with a kind word, fits one breath and carries no inventory", () => {
    const kinds = ["Needs you", "Failed", "Your turn", "Finished", "Working", "Paused", "Stopped"]
    for (const { line } of goldens) {
      expect(
        kinds.some((k) => line.startsWith(`${k}:`)),
        line,
      ).toBe(true)
      expect(line.split(" ").length <= 28 && [...line].length <= MAX_LENGTH, line).toBe(true)
      expect(/\d+\.\d+|\b[0-9a-f]{7,}\b|\/|\(/.test(line), line).toBe(false)
    }
  })
})

describe("SpokenLine", () => {
  it("without a sealed gist says the frame alone, never the outcome", () => {
    expect(text(card("Relo deploy", "done"))).toBe("Finished: Relo deploy.")
    expect(text(card("Ship it now", "yourTurn"))).toBe("Your turn: Ship it now.")
  })

  it("a line from an older CLI still gets its frame and its cap", () => {
    const c = card("Relo deploy", "done", { spoken: "Server 0.18.99 is live. " + "All gates passed and more. ".repeat(20) })
    const line = text(c)
    expect(line?.startsWith("Finished: Relo deploy. Server 0.18.99 is live.")).toBe(true)
    expect([...(line ?? "")].length).toBeLessThanOrEqual(MAX_LENGTH)
    expect(line?.endsWith(".")).toBe(true)
  })

  it("the detail is the lower of the owner's and the card's", () => {
    const c = card("Relo deploy", "done", { spokenName: "Relo deploy", spoken: "Server is live and every gate passed." })
    expect(text(c, { owner: "verbose" })).toBe("Finished: Relo deploy. Server is live and every gate passed.")
    expect(text(c, { owner: "brief" })).toBe("Finished: Relo deploy.")
    expect(text({ ...c, spokenVoice: "brief" }, { owner: "verbose" })).toBe("Finished: Relo deploy.")
    // A project set to off is never said, not even by the play button.
    expect(text({ ...c, spokenVoice: "off" }, { owner: "verbose" })).toBeNull()
  })

  it("sound as the kind drops only the kind word", () => {
    const c = card("Relo deploy", "done", { spoken: "Server is live and every gate passed." })
    expect(text(c, { kind: false })).toBe("Relo deploy. Server is live and every gate passed.")
    expect(text(c, { owner: "brief", kind: false })).toBe("Relo deploy.")
  })

  it("a finished step is said only at the Verbose detail", () => {
    const c = card("Redesign the open notch view", "working", {
      currentStep: "Build the list (with motion)",
      spokenName: "Notch redesign",
      stepsDone: 3,
      stepsTotal: 5,
    })
    // A readable card names no level: the owner's detail decides.
    expect(progress(c, "verbose")).toBe("Working: Notch redesign. 3 of 5 done, now build the list.")
    expect(progress(c, "full")).toBeNull()
    expect(progress({ ...c, spokenVoice: "verbose" }, "verbose")).toBe("Working: Notch redesign. 3 of 5 done, now build the list.")
    expect(progress({ ...c, spokenVoice: "verbose" }, "full")).toBeNull()
    expect(progress({ ...c, spokenVoice: "full" }, "verbose")).toBeNull()
  })

  it("a sealed card this PC cannot open says nothing", () => {
    expect(text(card("Private work", "done", { unreadable: true }))).toBeNull()
  })

  it("markdown, glyphs, links, paths and ids are said as words", () => {
    expect(clean("**Done** · see `ReloCards.swift`")).toBe("Done, see ReloCards.swift")
    expect(clean("Fixed /Users/me/relo/apps/notch/ReloCards.swift and apps/notch/README.md")).toBe("Fixed ReloCards.swift and README.md")
    expect(clean("Read [the PR](https://github.com/x/y/pull/9) at https://relo.example.com/now")).toBe("Read the PR at relo.example.com")
    expect(clean("Closed wrk_66bb4f2f ✓ for now…")).toBe("Closed for now.")
  })

  it("versions, hashes and codes are never read", () => {
    expect(strip("Deploy server fea6d51 to production (no migrations)")).toBe("Deploy server to production")
    expect(strip("0.17 is on TestFlight, build 289")).toBe("The new version is on TestFlight")
    expect(strip("Approve the sign-in, code HB9H-9HKB")).toBe("Approve the sign-in")
  })

  it("stopped and paused work say their frame; a working card without a step says the frame alone", () => {
    expect(text(card("Nightly backup job", "paused"))).toBe("Paused: Nightly backup job.")
    expect(text(card("Nightly backup job", "leftUnfinished"))).toBe("Stopped: Nightly backup job.")
    expect(text(card("Nightly backup job", "working"))).toBe("Working: Nightly backup job.")
  })
})
