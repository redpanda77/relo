// Development only: `settings.html?localMock=ok|slow|fail|none` drives the local setup against a scripted server instead
// of Rust, so its screens can be seen (and screenshotted) in a browser without a payload. Never active in a build.
import { initialProgress } from "../settings/onboarding/stages"
import { settingsStore } from "../settings/store"
import { localApi, OFF, setLocalStateForTest, type LocalAgent } from "./api"

const scenario: string | null = import.meta.env.DEV && typeof location !== "undefined" ? new URLSearchParams(location.search).get("localMock") : null

export const mocked = scenario !== null

const AGENTS: LocalAgent[] = [
  { id: "claude-code", name: "Claude Code" },
  { id: "opencode", name: "OpenCode" },
  { id: "codex", name: "Codex" },
]

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
let failures = 0
const listeners = new Set<(state: string) => void>()

/** What `owner_state` would deliver, for the screen that waits on it. */
export const mockSubscribe = (cb: (state: string) => void): (() => void) => {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}
const say = (state: string) => listeners.forEach((l) => l(state))

/** `localMockAuto=1`: Continue is pressed on the agents list by itself (for a screenshot of the whole run). */
export const mockAuto = mocked && new URLSearchParams(location.search).get("localMockAuto") === "1"

if (mocked) {
  const view = new URLSearchParams(location.search).get("localMockView")
  setLocalStateForTest({ ...OFF, bundled: true, ...(view === "settings" ? { mode: true, phase: "running", port: 8187, version: "0.2.32" } : {}) })
  // `localMockView=local`: open on the local steps; `settings`: the Settings window of a PC that runs Relo itself.
  void settingsStore.start().then(() => {
    if (view === "local") settingsStore.update({ onboarding: { ...initialProgress(), stage: "local", place: "local" } })
    if (view === "settings") settingsStore.update({ onboardingDone: true, onboarding: null })
  })
  Object.assign(localApi, {
    check: async () => null,
    async start() {
      await wait(scenario === "slow" ? 6000 : 900)
      // `fail`: the port is taken the first time, then the owner presses Try again.
      if (scenario === "fail" && failures++ === 0) throw "Something on this PC is blocking Relo. Try again."
    },
    detectAgents: async () => (scenario === "none" ? [] : AGENTS),
    async installCommand() {
      await wait(700)
      return { result: "written", note: null }
    },
    async link() {
      await wait(500)
      say("signingIn")
      await wait(900)
      say("live")
    },
    commit: async () => {},
    testCard: async () => {},
    abandon: async () => {},
  })
}
