// "Run Relo on this PC" as a state machine (the Mac's ReloLocalSetup): five steps with live state, the owner asked only
// which agents to set up. `LocalProgress` is saved with the onboarding progress, so a relaunch resumes where it was;
// `runLocalSetup` does the work through `LocalApi`, so tests drive it with a fake.
import type { LocalAgent, LocalApi } from "./api"
import { SETUP } from "./words"

export const LOCAL_STEPS = ["starting", "agents", "command", "settingUp", "done"] as const
export type LocalStep = (typeof LOCAL_STEPS)[number]

export interface LocalProgress {
  step: LocalStep
  /** Waiting on the owner (the agents list). */
  waitingForAgents: boolean
  /** A step is being worked on (a relaunch cannot continue it: it starts again from `retryFrom`). */
  running: boolean
  failure: string | null
  failedAt: LocalStep | null
  agents: LocalAgent[]
  selected: string[]
  /** The owner skipped agents (or none was found): Relo links the app and the command and sets up nothing. */
  skippedAgents: boolean
  /** Set when the owner's own relo command stays in place: the done screen says so. */
  launcherNote: string | null
  retryFrom: LocalStep
}

export function initialLocal(): LocalProgress {
  return {
    step: "starting", waitingForAgents: false, running: false, failure: null, failedAt: null, agents: [], selected: [],
    skippedAgents: false, launcherNote: null, retryFrom: "starting",
  }
}

export const stepTitle = (step: LocalStep): string => SETUP.steps[step]

const rank = (s: LocalStep) => LOCAL_STEPS.indexOf(s)

/** Past detection with nothing found: the row says where to set agents up later. */
export const noAgentsFound = (l: LocalProgress): boolean => l.agents.length === 0 && rank(l.step) >= rank("agents")

/** The agents ticked, in the order Relo shows them. */
export const chosen = (l: LocalProgress): string[] => l.agents.map((a) => a.id).filter((id) => l.selected.includes(id))

export type RowState = "pending" | "active" | "waiting" | "done" | "failed"

export function rowState(l: LocalProgress, step: LocalStep): RowState {
  if (l.failure !== null && l.step === step) return "failed"
  if (l.step === "done" || rank(step) < rank(l.step)) return "done"
  if (step === l.step) return step === "agents" && l.waitingForAgents ? "waiting" : "active"
  return "pending"
}

/** What the agents row says once it is past: the names ticked, "Skipped", or where to set agents up later. */
export function agentsSummary(l: LocalProgress): string {
  if (noAgentsFound(l)) return SETUP.noAgents
  if (l.skippedAgents) return SETUP.skipped
  return l.agents.filter((a) => l.selected.includes(a.id)).map((a) => a.name).join(", ")
}

/** Back button, Skip and Continue are offered by what the screen is doing. */
export type Buttons = "failed" | "done" | "agents" | "working"
export const buttonsFor = (l: LocalProgress): Buttons =>
  l.failure !== null ? "failed" : l.step === "done" ? "done" : l.waitingForAgents ? "agents" : "working"

/** A relaunch cannot resume a run that was in flight: it goes back to the step it would retry from (or waits again). */
export function resumeLocal(l: LocalProgress): LocalProgress {
  if (!l.running) return l
  return { ...l, running: false, waitingForAgents: false, failure: null, failedAt: null, step: l.retryFrom }
}

// ---- Normalising what the settings file holds ----

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const stepOf = (v: unknown, d: LocalStep): LocalStep => (LOCAL_STEPS.includes(v as LocalStep) ? (v as LocalStep) : d)
const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.length > 0 && v.length <= max ? v : null)

export function normalizeLocal(raw: unknown): LocalProgress {
  if (!isObj(raw)) return initialLocal()
  const agents = (Array.isArray(raw.agents) ? raw.agents : []).filter(isObj).flatMap((a) => (text(a.id, 32) && text(a.name, 64) ? [{ id: a.id as string, name: a.name as string }] : []))
  return {
    step: stepOf(raw.step, "starting"),
    waitingForAgents: raw.waitingForAgents === true,
    running: raw.running === true,
    failure: text(raw.failure, 400),
    failedAt: raw.failedAt === null || raw.failedAt === undefined ? null : stepOf(raw.failedAt, "starting"),
    agents,
    selected: (Array.isArray(raw.selected) ? raw.selected : []).filter((s): s is string => typeof s === "string").slice(0, 32),
    skippedAgents: raw.skippedAgents === true,
    launcherNote: text(raw.launcherNote, 200),
    retryFrom: stepOf(raw.retryFrom, "starting"),
  }
}

// ---- Doing the work ----

export interface SetupIO {
  api: LocalApi
  get(): LocalProgress
  patch(p: Partial<LocalProgress>): void
  /** Starts listening for the app's own link to Relo on this PC; called before the link is made so no report is missed. */
  watchAppSignIn(): SignInWatch
}

export interface SignInWatch {
  /** Resolves when the app is signed in to Relo on this PC; rejects with words when it fails or takes too long. */
  done: Promise<void>
  cancel(): void
}

/** The notch's connection states that mean it is signed in (`owner_state`). */
export const isLinked = (state: string): boolean => state === "live" || state === "connecting" || state === "offline" || state === "signedIn"

/**
 * Follows `owner_state` reports from the notch: linked when it is signed in; failed when a sign-in that began ended
 * signed out; failed after `timeoutMs`. `subscribe` returns the unsubscribe.
 */
export function createSignInWatch(subscribe: (cb: (state: string) => void) => () => void, timeoutMs = 45_000, setTimer: typeof setTimeout = setTimeout, clearTimer: typeof clearTimeout = clearTimeout): SignInWatch {
  const failure = "Relo could not link this PC."
  let finish: (error?: string) => void = () => {}
  const done = new Promise<void>((resolve, reject) => {
    let began = false
    let off: () => void = () => {}
    const timer = setTimer(() => finish(failure), timeoutMs)
    finish = (error) => {
      clearTimer(timer)
      off()
      finish = () => {}
      if (error) reject(error)
      else resolve()
    }
    off = subscribe((state) => {
      if (isLinked(state)) finish()
      else if (state === "signingIn") began = true
      else if (began && (state === "signedOut" || state === "needsSignIn")) finish(failure)
    })
  })
  // A watch nobody awaits (cancelled) must not become an unhandled rejection.
  done.catch(() => {})
  return { done, cancel: () => finish("cancelled") }
}

const failureWords = (e: unknown): string => (typeof e === "string" && e ? e : SETUP.genericFailure)

/** The work from `from` on (the Mac's `run(from:)`). Stops early at the agents list, waiting on the owner. */
export async function runLocalSetup(from: LocalStep, io: SetupIO): Promise<void> {
  const { api } = io
  let current: LocalStep = from
  io.patch({ running: true, failure: null, failedAt: null })
  try {
    if (from === "starting") {
      io.patch({ step: "starting", retryFrom: "starting" })
      current = "starting"
      const problem = await api.check()
      if (problem) throw problem
      await api.start()
      const agents = await api.detectAgents()
      const keep = io.get().selected.filter((id) => agents.some((a) => a.id === id))
      io.patch({ agents, selected: keep.length ? keep : agents.map((a) => a.id), step: "agents" })
      current = "agents"
      if (agents.length > 0) {
        io.patch({ waitingForAgents: true, running: false })
        return
      }
      io.patch({ skippedAgents: true })
    }
    // The relo command comes before the agents: their instructions call `relo`.
    if (rank(from) <= rank("command")) {
      io.patch({ step: "command", retryFrom: "command" })
      current = "command"
      const installed = await api.installCommand()
      io.patch({ launcherNote: installed.result === "otherInstalled" ? installed.note : null })
    }
    io.patch({ step: "settingUp", retryFrom: "settingUp" })
    current = "settingUp"
    const skipped = io.get().skippedAgents
    const watch = io.watchAppSignIn()
    try {
      await api.link(skipped ? [] : chosen(io.get()), !skipped)
      await watch.done
    } finally {
      watch.cancel()
    }
    await api.commit()
    io.patch({ step: "done", running: false })
    void api.testCard()
  } catch (e) {
    // A retry resumes where it stopped; the agents list is answered already once past it.
    const retryFrom: LocalStep = current === "command" || current === "settingUp" ? current : "starting"
    io.patch({ failure: failureWords(e), failedAt: current, retryFrom, step: retryFrom, running: false, waitingForAgents: false })
  }
}

/** Try again: resumes from where it stopped. */
export function begin(io: SetupIO): Promise<void> {
  const l = io.get()
  if (l.running) return Promise.resolve()
  return runLocalSetup(l.retryFrom, io)
}

/** Continue on the agents list. */
export function chooseAgents(io: SetupIO): Promise<void> {
  const l = io.get()
  if (!l.waitingForAgents || l.selected.length === 0) return Promise.resolve()
  io.patch({ waitingForAgents: false })
  return runLocalSetup("command", io)
}

/** Skip agents for now. */
export function skipAgents(io: SetupIO): Promise<void> {
  if (!io.get().waitingForAgents) return Promise.resolve()
  io.patch({ waitingForAgents: false, skippedAgents: true })
  return runLocalSetup("command", io)
}

/** Back out of a setup that did not finish: nothing stays half installed. */
export async function abandon(io: SetupIO): Promise<void> {
  if (io.get().running) return
  await io.api.abandon()
}

export function toggleAgent(l: LocalProgress, id: string): LocalProgress {
  return { ...l, selected: l.selected.includes(id) ? l.selected.filter((s) => s !== id) : [...l.selected, id] }
}
