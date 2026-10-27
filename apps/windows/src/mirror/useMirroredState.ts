// What a mirror notch's page uses in place of the owner client: the view the main notch broadcasts, and owner actions that
// travel back to it. See bridge.ts.

import { useEffect, useSyncExternalStore } from "react"
import type { Owner } from "../client/useOwner"
import type { OwnerView } from "../client/ownerApp"
import { createMirrorClient, tauriWire, type MirrorAction, type MirrorClient, type Wire } from "./bridge"

/** Before the main notch has answered: the same picture the main notch has while it starts (no sign-in prompt flashes). */
export const STARTING_VIEW: OwnerView = {
  connection: "starting", summary: null, spoken: {}, questions: {}, answers: {}, offline: false, problem: null, approval: null, serverOrigin: null, accountEmail: null, pausedUntil: 0,
  failure: null, waitingComputers: [], update: null, updatedLine: null, arrivals: [], peek: null, signInInBrowser: false, updatedAt: null, notices: [],
  cached: false, localStarting: false, localStartFailed: false, local: false,
}

let shared: MirrorClient | null = null
const client = (wire: Wire = tauriWire): MirrorClient => (shared ??= createMirrorClient(wire))

/** The mirrored view (STARTING_VIEW until the first broadcast) and the way to send an action to the main notch. */
export function useMirroredState(wire?: Wire): { view: OwnerView; act: (action: MirrorAction) => void } {
  const c = client(wire)
  const view = useSyncExternalStore(c.subscribe, c.getView)
  useEffect(() => c.start(), [c])
  return { view: view ?? STARTING_VIEW, act: c.act }
}

/** An `Owner` whose every action is sent to the main notch (the only window with a server connection). */
export function mirroredOwner(view: OwnerView, act: (action: MirrorAction) => void): Owner {
  return {
    enabled: true,
    view,
    input: {
      summary: view.summary,
      questions: view.questions,
      answers: view.answers,
      offline: view.offline,
      onAnswer: (interactionId, action, optionId) => act({ kind: "answer", interactionId, action, ...(optionId === undefined ? {} : { optionId }) }),
      onDismiss: (interactionId) => act({ kind: "dismiss", interactionId }),
    },
    signIn: (origin) => (act({ kind: "signIn", ...(origin === undefined ? {} : { origin }) }), Promise.resolve()),
    cancelSignIn: () => act({ kind: "cancelSignIn" }),
    retry: () => act({ kind: "retry" }),
    approveComputer: (id) => act({ kind: "approveComputer", id }),
    declineComputer: (id) => act({ kind: "declineComputer", id }),
    installUpdate: () => act({ kind: "installUpdate" }),
    later: () => act({ kind: "later" }),
    dismissFailure: () => act({ kind: "dismissFailure" }),
    signOut: () => act({ kind: "signOut" }),
    switchAccount: () => act({ kind: "switchAccount" }),
    onOpenChange: (open) => {
      if (open) act({ kind: "opened" })
    },
  }
}
