import { describe, expect, it } from "vitest"
import { initialLocal } from "../../local/setup"
import { normalizeProgress } from "../store"
import { canContinue, initialProgress, reduce, resume, route, stepIndex, type Event, type Progress } from "./stages"

const run = (p: Progress, ...events: Event[]) => events.reduce(reduce, p)
const at = (stage: Progress["stage"], over: Partial<Progress> = {}): Progress => ({ ...initialProgress(), stage, ...over })

describe("the local route of the onboarding", () => {
  it("is the default and has five screens: Hello, Sound, Where, the local steps, Ready", () => {
    expect(initialProgress().place).toBe("local")
    expect(route("local")).toEqual(["hello", "sound", "where", "local", "ready"])
    expect(route("server")).toEqual(["hello", "sound", "where", "server", "agents", "setup", "ready"])
    expect(stepIndex("local", "local")).toBe(3)
    expect(stepIndex("ready", "local")).toBe(4)
    expect(stepIndex("ready", "server")).toBe(6)
  })

  it("Where continues to the local steps, never to a sign-in or the agents screen", () => {
    const p = run(at("where"), { type: "continue" })
    expect(p.stage).toBe("local")
    expect(p.signIn).toBe("idle")
  })

  it("the local screen blocks Continue until Done, and a failure blocks it too", () => {
    let p = at("local")
    expect(canContinue(p)).toBe(false)
    p = run(p, { type: "local", patch: { step: "done" } })
    expect(canContinue(p)).toBe(true)
    expect(run(p, { type: "continue" }).stage).toBe("ready")
    expect(canContinue(run(p, { type: "local", patch: { failure: "no" } }))).toBe(false)
  })

  it("progress patches merge into the local steps and nothing else", () => {
    const p = run(at("local"), { type: "local", patch: { step: "agents", waitingForAgents: true, selected: ["codex"] } })
    expect(p.local).toMatchObject({ step: "agents", waitingForAgents: true, selected: ["codex"], skippedAgents: false })
    expect(p.rows).toEqual([])
    expect(p.agents).toEqual([])
  })

  it("Back from the local screen returns to Where; Back from Ready returns to the local screen", () => {
    expect(run(at("local"), { type: "back" }).stage).toBe("where")
    expect(run(at("ready"), { type: "back" }).stage).toBe("local")
    expect(run(at("ready", { place: "server" }), { type: "back" }).stage).toBe("agents")
  })

  it("choosing a server after starting the local steps starts them over", () => {
    const started = run(at("local"), { type: "local", patch: { step: "command", failure: "x" } })
    const back = run(started, { type: "back" }, { type: "localReset" }, { type: "choosePlace", place: "server" })
    expect(back).toMatchObject({ stage: "where", place: "server", local: initialLocal() })
  })

  it("a relaunch in the middle of a step goes back to the step it would retry from", () => {
    const p = resume(at("local", { local: { ...initialLocal(), step: "settingUp", retryFrom: "settingUp", running: true } }))
    expect(p.local).toMatchObject({ running: false, step: "settingUp", failure: null })
    const early = resume(at("local", { local: { ...initialLocal(), step: "starting", retryFrom: "starting", running: true } }))
    expect(early.local.step).toBe("starting")
  })

  it("the local progress survives the settings file, and a bad one falls back to the first step", () => {
    const saved = JSON.parse(JSON.stringify(at("local", { local: { ...initialLocal(), step: "agents", waitingForAgents: true, agents: [{ id: "codex", name: "Codex" }], selected: ["codex"] } })))
    expect(normalizeProgress(saved)?.local).toMatchObject({ step: "agents", waitingForAgents: true, agents: [{ id: "codex", name: "Codex" }], selected: ["codex"] })
    expect(normalizeProgress({ stage: "local", local: { step: "bogus", agents: "no", failure: 5 } })?.local).toEqual(initialLocal())
    // An older settings file without the local route still opens, on the local default.
    expect(normalizeProgress({ stage: "where" })).toMatchObject({ stage: "where", place: "local", local: initialLocal() })
  })
})
