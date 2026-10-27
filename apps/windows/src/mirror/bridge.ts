// The state bridge between the main notch and its mirrors ("Show on all displays", src-tauri/src/mirrors.rs).
//
// One window owns the server connection: the main notch (label `notch`) runs the owner client. A mirror (label `notch-<monitor>`)
// never connects: it draws the view the main notch broadcasts and sends the owner's actions back.
//
//   main notch   publishNotchState(view)  ->  event `notch_state` {view}       ->  mirror  useMirroredState()
//   main notch   serves                   <-  event `mirror_action` {action}   <-  mirror  act(action)
//   mirror       on start                 ->  event `mirror_hello`             ->  main notch answers with the latest state
//
// The view is the owner client's `OwnerView` (what the notch draws: Now summary, questions, answers, connection, peek,
// notices). Nothing secret is in it: no keys, tokens or ciphertext.

import { emit, listen } from "@tauri-apps/api/event"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { inTauri } from "../bridge"
import type { AnswerAction } from "../relo/answers"
import type { OwnerView } from "../client/ownerApp"
import { cuePlayer } from "../sound"
import { tauriBackend } from "../voice/ipc"

export const STATE_EVENT = "notch_state"
export const ACTION_EVENT = "mirror_action"
export const HELLO_EVENT = "mirror_hello"
/** Mirror windows are labelled `notch-<monitor>` (mirrors.rs); the main notch is exactly `notch`. */
export const MIRROR_PREFIX = "notch-"

export interface Wire {
  emit(name: string, payload: unknown): void
  listen(name: string, cb: (payload: unknown) => void): Promise<() => void>
}

export const tauriWire: Wire = {
  emit: (name, payload) => void emit(name, payload).catch(() => {}),
  listen: (name, cb) => listen(name, (e) => cb(e.payload)),
}

/** What an owner action in a mirror asks the main notch to do. */
export type MirrorAction =
  | { kind: "answer"; interactionId: string; action: AnswerAction; optionId?: string }
  | { kind: "dismiss"; interactionId: string }
  | { kind: "signIn"; origin?: string }
  | { kind: "cancelSignIn" }
  | { kind: "retry" }
  | { kind: "approveComputer"; id: string }
  | { kind: "declineComputer"; id: string }
  | { kind: "installUpdate" }
  | { kind: "later" }
  | { kind: "dismissFailure" }
  | { kind: "signOut" }
  | { kind: "switchAccount" }
  | { kind: "opened" }

/** The part of the owner client the main notch lends to mirrors. */
export interface MirrorTarget {
  answer(interactionId: string, action: AnswerAction, optionId?: string): void
  dismissMissed(interactionId: string): unknown
  signIn(origin?: string): unknown
  cancelSignIn(): void
  refresh(): void
  approveComputer(id: string): unknown
  declineComputer(id: string): unknown
  installUpdate(): unknown
  later(): void
  dismissFailure(): void
  signOut(): unknown
  switchAccount(): unknown
  viewChanged(open: boolean): void
}

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length < 4096

/** Runs one action on the owner client; false when it is not one (a mirror cannot make the main notch do anything else). */
export function performAction(target: MirrorTarget, raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false
  const a = raw as Record<string, unknown>
  switch (a.kind) {
    case "answer":
      if (!str(a.interactionId) || typeof a.action !== "string") return false
      target.answer(a.interactionId, a.action as AnswerAction, typeof a.optionId === "string" ? a.optionId : undefined)
      return true
    case "dismiss":
      if (!str(a.interactionId)) return false
      void target.dismissMissed(a.interactionId)
      return true
    case "signIn":
      void target.signIn(typeof a.origin === "string" ? a.origin : undefined)
      return true
    case "cancelSignIn":
      target.cancelSignIn()
      return true
    case "retry":
      target.refresh()
      return true
    case "approveComputer":
      if (!str(a.id)) return false
      void target.approveComputer(a.id)
      return true
    case "declineComputer":
      if (!str(a.id)) return false
      void target.declineComputer(a.id)
      return true
    case "installUpdate":
      void target.installUpdate()
      return true
    case "later":
      target.later()
      return true
    case "dismissFailure":
      target.dismissFailure()
      return true
    case "signOut":
      void target.signOut()
      return true
    case "switchAccount":
      void target.switchAccount()
      return true
    case "opened":
      target.viewChanged(true) // a closed mirror says nothing: the main notch's own open state stays its own
      return true
    default:
      return false
  }
}

// ---- The main notch ----

export interface MirrorHost {
  /** Broadcast the view (only while `enabled()`, and always remembered for a mirror that says hello). */
  publish(view: OwnerView): void
  /** Start serving mirrors' actions and hellos against `target`; returns the stop function. */
  attach(target: MirrorTarget): () => void
}

export function createMirrorHost(wire: Wire, enabled: () => boolean): MirrorHost {
  let latest: OwnerView | null = null
  const send = () => {
    if (latest) wire.emit(STATE_EVENT, { view: latest })
  }
  return {
    publish(view) {
      latest = view
      if (enabled()) send()
    },
    attach(target) {
      const offs: Array<Promise<() => void>> = [
        wire.listen(ACTION_EVENT, (p) => {
          const action = (p as { action?: unknown } | null)?.action
          performAction(target, action)
        }),
        wire.listen(HELLO_EVENT, send),
      ]
      return () => offs.forEach((p) => void p.then((off) => off()).catch(() => {}))
    },
  }
}

// ---- A mirror ----

export interface MirrorClient {
  subscribe(cb: () => void): () => void
  /** The latest broadcast view, or null before the first. */
  getView(): OwnerView | null
  /** Starts listening and asks the main notch for the current state. */
  start(): () => void
  act(action: MirrorAction): void
}

export function createMirrorClient(wire: Wire): MirrorClient {
  let view: OwnerView | null = null
  const listeners = new Set<() => void>()
  let started = false
  return {
    subscribe(cb) {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
    getView: () => view,
    start() {
      if (started) return () => {}
      started = true
      const off = wire.listen(STATE_EVENT, (p) => {
        const next = (p as { view?: OwnerView } | null)?.view
        if (!next || typeof next !== "object") return
        view = next
        listeners.forEach((l) => l())
      })
      void off.then(() => wire.emit(HELLO_EVENT, {})).catch(() => {})
      return () => {
        started = false
        void off.then((f) => f()).catch(() => {})
      }
    },
    act: (action) => wire.emit(ACTION_EVENT, { action }),
  }
}

// ---- Which window is this ----

/** True in a mirror window: its label is `notch-<monitor>` (or the page is opened with `?mirror=1`, for headless checks). */
export function isMirrorWindow(): boolean {
  try {
    if (typeof location !== "undefined" && new URLSearchParams(location.search).get("mirror") === "1") return true
    return inTauri && getCurrentWindow().label.startsWith(MIRROR_PREFIX)
  } catch {
    return false
  }
}

/** A mirror makes no sound of its own (the main notch plays the cues and speaks): its player and voice are muted. */
export function silenceMirror(): void {
  const no = () => false
  Object.assign(cuePlayer, { preload: async () => {}, play: no, preview: no, playFor: () => null, playStep: no, playOwnerAct: no })
  Object.assign(tauriBackend, { speak: async () => {}, cancel: async () => {} })
}
