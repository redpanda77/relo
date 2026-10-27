// The onboarding as a pure state machine (the Mac's ReloOnboardingFlow screens): Hello, Sound, Where, Server sign-in,
// Agents, Setup, Ready. The component only renders `Progress` and feeds `reduce` events; Progress is saved in
// settings.json so a restart resumes where the owner was.
//
// Two routes after Where: a server (sign in, agents, setup, ready) or this PC (the five local steps, then ready).
import { initialLocal, resumeLocal, type LocalProgress } from "../../local/setup"

export const STAGES = ["hello", "sound", "where", "server", "agents", "setup", "local", "ready"] as const
export type Stage = (typeof STAGES)[number]

export type Place = "local" | "server"
export type SignIn = "idle" | "waiting" | "signedIn"
export type RowStatus = "pending" | "running" | "done" | "failed" | "skipped"

/** The setup row that comes before the agents on a server route: the `relo` command they call (the Mac's "relo" item, ReloOnboardingSetup.swift). */
export const RELO_ROW = "relo"
export const RELO_ROW_NAME = "The relo command"

export interface AgentRow {
  id: string
  name: string
  status: RowStatus
  /** Why it failed, in the owner's words (never the CLI's output). */
  message?: string
}

export interface Progress {
  stage: Stage
  /** Where Relo runs: on this PC (the Mac's default) or on a server of the owner's. */
  place: Place
  origin: string
  signIn: SignIn
  /** Agents the CLI found, in display order. */
  agents: Array<{ id: string; name: string }>
  selected: string[]
  /** One row per selected agent, once Setup starts. */
  rows: AgentRow[]
  /** The local route's five steps: Starting Relo, Choosing your agents, Adding the relo command, Setting up, Done. */
  local: LocalProgress
}

export function initialProgress(): Progress {
  return { stage: "hello", place: "local", origin: "", signIn: "idle", agents: [], selected: [], rows: [], local: initialLocal() }
}

/** The screens a route walks, for the progress dots. */
export function route(place: Place): readonly Stage[] {
  return place === "local" ? ["hello", "sound", "where", "local", "ready"] : ["hello", "sound", "where", "server", "agents", "setup", "ready"]
}

/** A server origin as typed: https (or http on localhost for development), no path, query or credentials; normalised. */
export function normalizeOrigin(raw: string): string | null {
  let text = raw.trim()
  if (!text) return null
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) return null
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null
  if (!url.hostname.includes(".") && !local) return null
  return url.origin
}

/**
 * The server the installer came from: the `--relo-origin` it launched the app with, else its own record
 * (`install-source.json`, read by Rust only in an installed build). Either may fail or be absent; neither is ever an error.
 */
export async function originFromInstaller(flag: () => Promise<{ origin: string } | null>, record: () => Promise<string | null>): Promise<string | null> {
  const fromFlag = await flag().catch(() => null)
  if (fromFlag?.origin) return fromFlag.origin
  return (await record().catch(() => null)) || null
}

export type Event =
  | { type: "continue" }
  | { type: "back" }
  | { type: "choosePlace"; place: Place }
  | { type: "setOrigin"; origin: string }
  /** The Sign in button: the notch got `onboarding_sign_in`. */
  | { type: "signInStarted" }
  | { type: "signInCancelled" }
  /** The notch's `owner_state` event. */
  | { type: "ownerState"; state: string }
  | { type: "agentsDetected"; agents: Array<{ id: string; name: string }> }
  | { type: "toggleAgent"; id: string }
  | { type: "rowStarted"; id: string }
  | { type: "rowFinished"; id: string; ok: boolean; message?: string }
  | { type: "retry"; id: string }
  | { type: "skip"; id: string }
  /** The local setup's own progress (its steps, the agents list, a failure). */
  | { type: "local"; patch: Partial<LocalProgress> }
  /** The local route starts over (the owner went back to Where and chose again). */
  | { type: "localReset" }

/** The notch reports states like live, connecting, offline (signed in) and signedOut, signingIn. */
export function isSignedInState(state: string): boolean {
  return state === "signedIn" || state === "live" || state === "connecting" || state === "offline"
}

export function canContinue(p: Progress): boolean {
  switch (p.stage) {
    case "where":
      return p.place === "local" ? true : normalizeOrigin(p.origin) !== null
    case "local":
      return p.local.step === "done" && p.local.failure === null
    case "server":
      return p.signIn === "signedIn"
    case "setup":
      return setupFinished(p)
    default:
      return true
  }
}

/** Every row is settled (done or skipped); a failed or unfinished row blocks Continue until retried or skipped. */
export function setupFinished(p: Progress): boolean {
  return p.rows.every((r) => r.status === "done" || r.status === "skipped")
}

/** The row Setup should run next: the first pending one, and only while none is running. */
export function nextPending(p: Progress): AgentRow | null {
  if (p.stage !== "setup" || p.rows.some((r) => r.status === "running" || r.status === "failed")) return null
  return p.rows.find((r) => r.status === "pending") ?? null
}

function at(stage: Stage, delta: number): Stage {
  return STAGES[Math.min(STAGES.length - 1, Math.max(0, STAGES.indexOf(stage) + delta))]!
}

function forward(p: Progress): Progress {
  switch (p.stage) {
    case "where":
      if (p.place === "local") return { ...p, stage: "local" }
      return { ...p, stage: "server", signIn: p.signIn === "signedIn" ? "signedIn" : "idle" }
    case "local":
      return { ...p, stage: "ready", rows: [] }
    case "setup":
      return { ...p, stage: "ready" }
    case "server":
      return { ...p, stage: "agents" }
    case "agents": {
      const chosen = p.agents.filter((a) => p.selected.includes(a.id))
      // The relo command comes first, even with no agent chosen: the owner's later agents and the terminal need it.
      const relo: AgentRow = { id: RELO_ROW, name: RELO_ROW_NAME, status: "pending" }
      return { ...p, stage: "setup", rows: [relo, ...chosen.map((a): AgentRow => ({ id: a.id, name: a.name, status: "pending" }))] }
    }
    default:
      return { ...p, stage: at(p.stage, 1) }
  }
}

function backward(p: Progress): Progress {
  if (p.stage === "local") return { ...p, stage: "where" }
  if (p.stage === "ready" && p.place === "local") return { ...p, stage: "local" }
  if (p.stage === "server") return { ...p, stage: "where" }
  // Setup finishes by itself, so going back from Ready lands on Agents (a second Setup runs again only if asked).
  if (p.stage === "ready") return { ...p, stage: "agents", rows: [] }
  if (p.stage === "setup") return { ...p, stage: "agents", rows: [] }
  if (p.stage === "agents") return { ...p, stage: "server" }
  return { ...p, stage: at(p.stage, -1) }
}

const setRow = (p: Progress, id: string, f: (r: AgentRow) => AgentRow): Progress => ({
  ...p,
  rows: p.rows.map((r) => (r.id === id ? f(r) : r)),
})

/** What a failed row says when nothing more specific came back. */
function failureWords(r: AgentRow): string {
  return r.id === RELO_ROW ? "Relo could not add the relo command to this PC." : `Relo could not set up ${r.name}.`
}

export function reduce(p: Progress, e: Event): Progress {
  switch (e.type) {
    case "continue":
      return canContinue(p) ? forward(p) : p
    case "back":
      return backward(p)
    case "choosePlace":
      return { ...p, place: e.place }
    case "setOrigin":
      // A different origin is a different account: the sign-in starts over.
      return { ...p, origin: e.origin, signIn: normalizeOrigin(e.origin) === normalizeOrigin(p.origin) ? p.signIn : "idle" }
    case "signInStarted":
      return p.stage === "server" && normalizeOrigin(p.origin) ? { ...p, signIn: "waiting" } : p
    case "signInCancelled":
      return p.signIn === "waiting" ? { ...p, signIn: "idle" } : p
    case "ownerState": {
      if (p.stage !== "server") return e.state === "signedOut" && p.signIn === "signedIn" ? { ...p, signIn: "idle" } : p
      if (isSignedInState(e.state)) return forward({ ...p, signIn: "signedIn" })
      if (e.state === "signedOut" && p.signIn === "signedIn") return { ...p, signIn: "idle" }
      return p
    }
    case "agentsDetected": {
      // Everything found is ticked, as on the Mac; an owner's earlier unticking of a still-listed agent stays.
      const ids = e.agents.map((a) => a.id)
      const kept = p.selected.filter((id) => ids.includes(id))
      const known = new Set(p.agents.map((a) => a.id))
      const added = ids.filter((id) => !known.has(id))
      return { ...p, agents: e.agents, selected: [...kept, ...added] }
    }
    case "toggleAgent":
      return { ...p, selected: p.selected.includes(e.id) ? p.selected.filter((id) => id !== e.id) : [...p.selected, e.id] }
    case "rowStarted":
      return setRow(p, e.id, (r) => ({ ...r, status: "running", message: undefined }))
    case "rowFinished":
      return setRow(p, e.id, (r) => ({ ...r, status: e.ok ? "done" : "failed", message: e.ok ? undefined : e.message || failureWords(r) }))
    case "retry":
      return setRow(p, e.id, (r) => (r.status === "failed" ? { ...r, status: "pending", message: undefined } : r))
    case "skip": {
      const skipped = setRow(p, e.id, (r) => (r.status === "failed" || r.status === "pending" ? { ...r, status: "skipped", message: undefined } : r))
      // Agents call `relo`: without the command there is nothing for them to set up, so they are skipped with it.
      if (e.id !== RELO_ROW || skipped === p) return skipped
      return { ...skipped, rows: skipped.rows.map((r) => (r.status === "pending" ? { ...r, status: "skipped" } : r)) }
    }
    case "local":
      return { ...p, local: { ...p.local, ...e.patch } }
    case "localReset":
      return { ...p, local: initialLocal() }
  }
}

/** A restart cannot resume a CLI run that was in flight, so a running row goes back to pending. */
export function resume(p: Progress): Progress {
  return { ...p, rows: p.rows.map((r) => (r.status === "running" ? { ...r, status: "pending" } : r)), local: resumeLocal(p.local) }
}

/** Screen position for the progress dots: Hello is the title screen and Ready the end, so six steps in between. */
export function stepIndex(stage: Stage, place: Place = "server"): number {
  return Math.max(0, route(place).indexOf(stage))
}
