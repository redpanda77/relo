// The live branch of the notch's data: the owner client's state as `useRelo` input. In snapshot mode (`?snapshot=`) it
// does nothing and `useRelo` shows the fixture. Otherwise the app starts once and the notch follows it.

import { useEffect, useMemo, useSyncExternalStore } from "react"
import { isMirrorWindow, mirroredOwner, publishNotchState, serveMirrors, useMirroredState, type MirrorTarget } from "../mirror"
import { snapshotName, type ReloInput } from "../relo/useRelo"
import { createOwnerApp, type OwnerApp, type OwnerView } from "./ownerApp"

let app: OwnerApp | null = null
const ownerApp = (): OwnerApp => (app ??= createOwnerApp())

const NONE: OwnerView = {
  connection: "signedOut", summary: null, spoken: {}, questions: {}, answers: {}, offline: false, problem: null, approval: null, serverOrigin: null, accountEmail: null, pausedUntil: 0,
  failure: null, waitingComputers: [], update: null, updatedLine: null, arrivals: [], peek: null, signInInBrowser: false, updatedAt: null, notices: [],
  cached: false, localStarting: false, localStartFailed: false, local: false,
}
const subscribeNone = () => () => {}
const getNone = () => NONE

export interface Owner {
  /** False in snapshot mode: nothing is connected and nothing is started. */
  enabled: boolean
  view: OwnerView
  /** For `useRelo`. */
  input: ReloInput
  signIn(origin?: string): Promise<void>
  cancelSignIn(): void
  retry(): void
  approveComputer(id: string): void
  declineComputer(id: string): void
  installUpdate(): void
  later(): void
  dismissFailure(): void
  signOut(): void
  switchAccount(): void
  onOpenChange(open: boolean): void
}

/**
 * Mirror notches ("Show on all displays", src/mirror): a mirror window has no owner client and no server connection. It draws the
 * view the main notch broadcasts and sends actions back. The main notch (this branch of `useOwner`) publishes its view on every
 * change and serves the mirrors' actions.
 */
const MIRROR = isMirrorWindow()

const targetOf = (app: OwnerApp): MirrorTarget => ({
  answer: (id, action, option) => app.answer(id, action, option),
  dismissMissed: (id) => app.dismissMissed(id),
  signIn: (origin) => app.signIn(origin),
  cancelSignIn: () => app.cancelSignIn(),
  refresh: () => app.store.refreshNow(),
  approveComputer: (id) => app.approveComputer(id),
  declineComputer: (id) => app.declineComputer(id),
  installUpdate: () => app.installUpdate(),
  later: () => app.later(),
  dismissFailure: () => app.dismissFailure(),
  signOut: () => app.signOut(),
  switchAccount: () => app.switchAccount(),
  viewChanged: (open) => app.viewChanged(open),
})

function useMirrorOwner(): Owner {
  const { view, act } = useMirroredState()
  return useMemo(() => mirroredOwner(view, act), [view, act])
}

export const useOwner: () => Owner = MIRROR ? useMirrorOwner : useMainOwner

function useMainOwner(): Owner {
  const enabled = snapshotName() === null
  const current = enabled ? ownerApp() : null
  const view = useSyncExternalStore(current ? current.subscribe : subscribeNone, current ? current.getView : getNone)
  useEffect(() => {
    void current?.start()
  }, [current])
  // Mirror notches: lend the owner client to them and broadcast its view.
  useEffect(() => (current ? serveMirrors(targetOf(current)) : undefined), [current])
  useEffect(() => {
    if (current) publishNotchState(view)
  }, [current, view])
  return {
    enabled,
    view,
    input: enabled ? { summary: view.summary, questions: view.questions, answers: view.answers, onAnswer: current!.answer, onDismiss: current!.dismissMissed, offline: view.offline } : {},
    signIn: (origin) => current?.signIn(origin) ?? Promise.resolve(),
    cancelSignIn: () => current?.cancelSignIn(),
    retry: () => current?.store.refreshNow(),
    approveComputer: (id) => void current?.approveComputer(id),
    declineComputer: (id) => void current?.declineComputer(id),
    installUpdate: () => void current?.installUpdate(),
    later: () => current?.later(),
    dismissFailure: () => current?.dismissFailure(),
    signOut: () => void current?.signOut(),
    switchAccount: () => void current?.switchAccount(),
    onOpenChange: (open) => current?.viewChanged(open),
  }
}
