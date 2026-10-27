import { describe, expect, it, vi } from "vitest"
import type { LocalApi } from "./api"
import {
  abandon, agentsSummary, begin, buttonsFor, chooseAgents, createSignInWatch, initialLocal, noAgentsFound, rowState, runLocalSetup, skipAgents,
  type LocalProgress, type SetupIO,
} from "./setup"
import { SETUP } from "./words"

const AGENTS = [
  { id: "claude-code", name: "Claude Code" },
  { id: "opencode", name: "OpenCode" },
]

/** A setup whose steps are recorded and whose failures can be scripted. */
function rig(over: Partial<LocalApi> = {}, appLinked: "yes" | "no" = "yes") {
  const calls: string[] = []
  let state: LocalProgress = initialLocal()
  const seen: string[] = []
  const api: LocalApi = {
    check: async () => (calls.push("check"), null),
    start: async () => void calls.push("start"),
    detectAgents: async () => (calls.push("detect"), AGENTS),
    installCommand: async () => (calls.push("command"), { result: "written", note: null }),
    link: async (agents, setUp) => void calls.push(`link:${agents.join("+")}:${setUp}`),
    commit: async () => void calls.push("commit"),
    testCard: async () => void calls.push("testCard"),
    abandon: async () => void calls.push("abandon"),
    ...over,
  }
  const io: SetupIO = {
    api,
    get: () => state,
    patch: (p) => {
      state = { ...state, ...p }
      if (p.step && seen[seen.length - 1] !== p.step) seen.push(p.step)
    },
    watchAppSignIn: () => ({ done: appLinked === "yes" ? Promise.resolve() : Promise.reject("Relo could not link this PC."), cancel: () => void calls.push("unwatch") }),
  }
  return { io, calls, seen, state: () => state }
}

describe("the five steps", () => {
  it("run in the Mac's order and wait on the agents list", async () => {
    const r = rig()
    await runLocalSetup("starting", r.io)
    // Stops at Choosing your agents: the owner is asked which to set up, nothing else.
    expect(r.state()).toMatchObject({ step: "agents", waitingForAgents: true, running: false, selected: ["claude-code", "opencode"], failure: null })
    expect(r.calls).toEqual(["check", "start", "detect"])
    expect(buttonsFor(r.state())).toBe("agents")
    expect(rowState(r.state(), "starting")).toBe("done")
    expect(rowState(r.state(), "agents")).toBe("waiting")
    expect(rowState(r.state(), "command")).toBe("pending")

    await chooseAgents(r.io)
    expect(r.calls.slice(3)).toEqual(["command", "link:claude-code+opencode:true", "unwatch", "commit", "testCard"])
    expect(r.state()).toMatchObject({ step: "done", running: false, waitingForAgents: false, failure: null })
    expect(r.seen).toEqual(["starting", "agents", "command", "settingUp", "done"])
    expect(buttonsFor(r.state())).toBe("done")
    expect(agentsSummary(r.state())).toBe("Claude Code, OpenCode")
  })

  it("an unticked agent is left alone", async () => {
    const r = rig()
    await runLocalSetup("starting", r.io)
    r.io.patch({ selected: ["opencode"] })
    await chooseAgents(r.io)
    expect(r.calls).toContain("link:opencode:true")
    expect(agentsSummary(r.state())).toBe("OpenCode")
  })

  it("nothing ticked cannot continue", async () => {
    const r = rig()
    await runLocalSetup("starting", r.io)
    r.io.patch({ selected: [] })
    await chooseAgents(r.io)
    expect(r.state().waitingForAgents).toBe(true)
    expect(r.calls).not.toContain("command")
  })

  it("Skip agents for now links the app and the command and sets up nothing", async () => {
    const r = rig()
    await runLocalSetup("starting", r.io)
    await skipAgents(r.io)
    expect(r.calls).toContain("link::false")
    expect(r.state()).toMatchObject({ step: "done", skippedAgents: true })
    expect(agentsSummary(r.state())).toBe(SETUP.skipped)
  })

  it("no agents found says so and moves on without asking", async () => {
    const r = rig({ detectAgents: async () => [] })
    await runLocalSetup("starting", r.io)
    expect(r.state()).toMatchObject({ step: "done", skippedAgents: true, waitingForAgents: false })
    expect(noAgentsFound(r.state())).toBe(true)
    expect(agentsSummary(r.state())).toBe(SETUP.noAgents)
    expect(r.calls).toContain("link::false")
  })

  it("the owner's own relo command stays in place and the done screen says so", async () => {
    const r = rig({ installCommand: async () => ({ result: "otherInstalled", note: "Another relo command is installed; Relo for Windows' agents use it." }) })
    await runLocalSetup("starting", r.io)
    await chooseAgents(r.io)
    expect(r.state().launcherNote).toBe("Another relo command is installed; Relo for Windows' agents use it.")
    const mine = rig()
    await runLocalSetup("starting", mine.io)
    await chooseAgents(mine.io)
    expect(mine.state().launcherNote).toBeNull()
  })
})

describe("failures", () => {
  it("a start that fails says why, and Try again resumes from the start", async () => {
    let up = false
    const r = rig({ start: async () => { if (!up) throw "Something on this PC is blocking Relo. Try again."; up = true } })
    await runLocalSetup("starting", r.io)
    expect(r.state()).toMatchObject({ step: "starting", failure: "Something on this PC is blocking Relo. Try again.", failedAt: "starting", retryFrom: "starting", running: false })
    expect(rowState(r.state(), "starting")).toBe("failed")
    expect(buttonsFor(r.state())).toBe("failed")
    up = true
    await begin(r.io)
    expect(r.state()).toMatchObject({ step: "agents", failure: null, waitingForAgents: true })
  })

  it("a setup problem on this PC (not 64-bit, run as administrator) stops before anything starts", async () => {
    const r = rig({ check: async () => "Open Relo without \"Run as administrator\", then try again." })
    await runLocalSetup("starting", r.io)
    expect(r.state().failure).toContain("administrator")
    expect(r.calls).toEqual([])
  })

  it("a failure after the agents list retries from that step, not from the list", async () => {
    let fail = true
    const r = rig({ link: async () => { if (fail) throw "Relo could not finish setting up." } })
    await runLocalSetup("starting", r.io)
    await chooseAgents(r.io)
    expect(r.state()).toMatchObject({ failure: "Relo could not finish setting up.", failedAt: "settingUp", retryFrom: "settingUp", step: "settingUp" })
    const detects = r.calls.filter((c) => c === "detect").length
    fail = false
    await begin(r.io)
    expect(r.state().step).toBe("done")
    expect(r.calls.filter((c) => c === "detect").length).toBe(detects)
    expect(r.calls.filter((c) => c === "start").length).toBe(1)
  })

  it("the app not being signed in by the end is a failure, and nothing is committed", async () => {
    const r = rig({}, "no")
    await runLocalSetup("starting", r.io)
    await chooseAgents(r.io)
    expect(r.state().failure).toBe("Relo could not link this PC.")
    expect(r.calls).not.toContain("commit")
    expect(r.calls).not.toContain("testCard")
  })

  it("a failure with no words gets the generic ones", async () => {
    const r = rig({ installCommand: async () => { throw new Error("x") } })
    await runLocalSetup("starting", r.io)
    await chooseAgents(r.io)
    expect(r.state()).toMatchObject({ failure: SETUP.genericFailure, retryFrom: "command" })
  })

  it("Try again is ignored while a step runs; Back only abandons when nothing runs", async () => {
    const r = rig()
    r.io.patch({ running: true })
    await begin(r.io)
    expect(r.calls).toEqual([])
    await abandon(r.io)
    expect(r.calls).toEqual([])
    r.io.patch({ running: false })
    await abandon(r.io)
    expect(r.calls).toEqual(["abandon"])
  })
})

describe("the app's own link", () => {
  const rigWatch = (timeoutMs = 1000) => {
    let push: (s: string) => void = () => {}
    let unsubscribed = 0
    const watch = createSignInWatch((cb) => ((push = cb), () => void unsubscribed++), timeoutMs)
    return { watch, push: (s: string) => push(s), unsubscribed: () => unsubscribed }
  }

  it("is linked as soon as the notch is signed in, whichever state says so", async () => {
    for (const state of ["connecting", "live", "offline"]) {
      const w = rigWatch()
      w.push("signingIn")
      w.push(state)
      await expect(w.watch.done).resolves.toBeUndefined()
      expect(w.unsubscribed()).toBe(1)
    }
  })

  it("fails when a sign-in that began ends signed out, but not for a signed-out report before it began", async () => {
    const early = rigWatch()
    early.push("signedOut")
    early.push("signingIn")
    early.push("live")
    await expect(early.watch.done).resolves.toBeUndefined()
    const w = rigWatch()
    w.push("signingIn")
    w.push("signedOut")
    await expect(w.watch.done).rejects.toBe("Relo could not link this PC.")
  })

  it("fails after the time it was given", async () => {
    vi.useFakeTimers()
    const w = rigWatch(5000)
    const assertion = expect(w.watch.done).rejects.toBe("Relo could not link this PC.")
    await vi.advanceTimersByTimeAsync(5001)
    await assertion
    vi.useRealTimers()
  })

  it("cancelling is quiet", async () => {
    const w = rigWatch()
    w.watch.cancel()
    await expect(w.watch.done).rejects.toBe("cancelled")
    expect(w.unsubscribed()).toBe(1)
  })
})
