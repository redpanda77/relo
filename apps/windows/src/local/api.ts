// The app's bridge to local mode (apps/windows/src-tauri/src/local): commands and the `local_state` event. Everything is
// a no-op outside Tauri (tests, a plain browser), where local mode is simply off and not carried by the build.
import { invoke } from "@tauri-apps/api/core"
import { emit, listen } from "@tauri-apps/api/event"
import { useSyncExternalStore } from "react"

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window

export type LocalPhase = "off" | "starting" | "running" | "failed" | "foreign" | "stopped"

/** Rust's `LocalState` (flow.rs): where Relo on this PC stands. */
export interface LocalState {
  /** The owner runs Relo on this PC. */
  mode: boolean
  /** This build carries the server. */
  bundled: boolean
  phase: LocalPhase
  /** Why it did not start, in words for the owner. */
  reason: string | null
  port: number | null
  /** "0.2.32", never the build. */
  version: string | null
}

export const OFF: LocalState = { mode: false, bundled: false, phase: "off", reason: null, port: null, version: null }

export interface LocalAgent {
  id: string
  name: string
}

export interface InstallCommandResult {
  result: "written" | "otherInstalled"
  note: string | null
}

/** Everything the setup needs from Rust, so a test can stand in for it. */
export interface LocalApi {
  /** Why local setup cannot go ahead here (also "this build does not carry the server"), or null. */
  check(): Promise<string | null>
  /** Starts Relo and waits until it answers; rejects with the words of why not. */
  start(): Promise<void>
  detectAgents(): Promise<LocalAgent[]>
  installCommand(): Promise<InstallCommandResult>
  /** Invite, join into the `local` profile, and hands the notch the sign-in code. */
  link(agents: string[], setUp: boolean): Promise<void>
  /** Local mode is on from now on. */
  commit(): Promise<void>
  testCard(): Promise<void>
  /** Backing out of a setup that did not finish. */
  abandon(): Promise<void>
}

const words = (e: unknown): string => (typeof e === "string" ? e : e instanceof Error ? e.message : "Relo could not finish setting up on this PC.")

export const localApi: LocalApi = {
  check: () => (inTauri ? invoke<string | null>("local_check") : Promise.resolve("This build of Relo does not carry the server.")),
  async start() {
    if (!inTauri) throw "This build of Relo does not carry the server."
    try {
      await invoke("local_start")
    } catch (e) {
      throw words(e)
    }
  },
  detectAgents: () => (inTauri ? invoke<LocalAgent[]>("local_detect_agents").catch(() => []) : Promise.resolve([])),
  async installCommand() {
    try {
      return await invoke<InstallCommandResult>("local_install_command")
    } catch (e) {
      throw words(e)
    }
  },
  async link(agents, setUp) {
    try {
      await invoke("local_link", { agents, setUp })
    } catch (e) {
      throw words(e)
    }
  },
  async commit() {
    await invoke("local_commit")
  },
  testCard: () => (inTauri ? invoke<void>("local_test_card").catch(() => {}) : Promise.resolve()),
  async abandon() {
    if (inTauri) await invoke("local_abandon").catch(() => {})
  },
}

// ---- Commands outside the setup ----

export const localStateGet = (): Promise<LocalState> => (inTauri ? invoke<LocalState>("local_state_get").catch(() => OFF) : Promise.resolve(OFF))

/** "Try again" after Relo could not start. Resolves to what went wrong, or null when it runs. */
export async function localRetryStart(): Promise<string | null> {
  try {
    await localApi.start()
    return null
  } catch (e) {
    return words(e)
  }
}

/** "Repair": start if needed and link the app again, asking nothing. Resolves to what went wrong, or null. */
export const localRepair = (): Promise<string | null> => (inTauri ? invoke<string | null>("local_repair").catch(words) : Promise.resolve(null))
export const localSetUpAgents = (agents: string[]): Promise<string | null> => (inTauri ? invoke<string | null>("local_set_up_agents", { agents }).catch(words) : Promise.resolve(null))
export const localLeave = (ignoringProblems = false): Promise<string | null> => (inTauri ? invoke<string | null>("local_leave", { ignoringProblems }).catch(words) : Promise.resolve(null))
export const localUninstall = (deleteData: boolean): Promise<string | null> => (inTauri ? invoke<string | null>("local_uninstall", { deleteData }).catch(words) : Promise.resolve(null))
export const localRemoteHost = (): Promise<string | null> => (inTauri ? invoke<string | null>("local_remote_host").catch(() => null) : Promise.resolve(null))
export const localShowLogs = (): Promise<void> => (inTauri ? invoke<void>("local_show_logs").catch(() => {}) : Promise.resolve())

// ---- Events ----

export function onLocalState(cb: (state: LocalState) => void): () => void {
  if (!inTauri) return () => {}
  const p = listen<LocalState>("local_state", (e) => cb(e.payload))
  return () => void p.then((off) => off())
}

/** What Rust hands the notch to sign in with. The verifier is the app's own secret and goes nowhere else. */
export interface LocalSignIn {
  origin: string
  code: string
  verifier: string
}

export function onLocalSignIn(cb: (signIn: LocalSignIn) => void): () => void {
  if (!inTauri) return () => {}
  const p = listen<LocalSignIn>("local_sign_in", (e) => cb(e.payload))
  return () => void p.then((off) => off())
}

/** The notch tells the settings window where the app's own link stands (`owner_state`). */
export function reportOwnerState(state: string, extra: { approval?: "waiting" | "approved" | null; problem?: string | null } = {}): void {
  if (inTauri) void emit("owner_state", { state, approval: extra.approval ?? null, problem: extra.problem ?? null }).catch(() => {})
}

/** After `local_updated` (the server was brought up to the app's release): the agents' files were refreshed or not. */
export function onLocalUpdated(cb: (u: { version: string | null; agents: "refreshed" | "failed" }) => void): () => void {
  if (!inTauri) return () => {}
  const p = listen<{ version: string | null; agents: "refreshed" | "failed" }>("local_updated", (e) => cb(e.payload))
  return () => void p.then((off) => off())
}

// ---- The live state, for any window ----

let current: LocalState = OFF
let started = false
const listeners = new Set<() => void>()

function set(next: LocalState) {
  if (JSON.stringify(next) === JSON.stringify(current)) return
  current = next
  listeners.forEach((l) => l())
}

function start() {
  if (started) return
  started = true
  onLocalState(set)
  if (inTauri) void localStateGet().then(set)
}

/** `const local = useLocalState()`: Relo on this PC as it stands, live in any window. */
export function useLocalState(): LocalState {
  return useSyncExternalStore(
    (cb) => {
      start()
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
    () => current,
  )
}

/** Whether Relo runs on this PC right now, for code outside React (the tray). */
export function localModeNow(): boolean {
  start()
  return current.mode
}

/** Test seam. */
export function setLocalStateForTest(state: LocalState): void {
  current = state
  listeners.forEach((l) => l())
}
