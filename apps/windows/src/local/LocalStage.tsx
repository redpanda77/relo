// The local route's onboarding screen with its behaviour: it starts the setup when it opens (and again after a relaunch
// resumed it), follows the notch's report that the app is linked, and backs out cleanly.
import { useEffect, useMemo, useRef } from "react"
import { broadcast, onEvent } from "../settings/ipc"
import { localApi } from "./api"
import { LocalSetupView, type LocalSetupActions } from "./LocalSetupView"
import { mockAuto, mocked, mockSubscribe } from "./mock"
import { abandon, begin, chooseAgents, createSignInWatch, skipAgents, toggleAgent, type LocalProgress, type SetupIO } from "./setup"

/** The notch reports where the app's own link stands (`owner_state`), the settings window listens. */
const subscribeOwnerState = (cb: (state: string) => void): (() => void) => onEvent<{ state: string }>("owner_state", (p) => cb(p.state))

export function makeSetupIO(get: () => LocalProgress, patch: (p: Partial<LocalProgress>) => void): SetupIO {
  return {
    api: {
      ...localApi,
      // The app may be signed in to a server of the owner's: it leaves first, so nothing there keeps this PC's device.
      async link(agents, setUp) {
        broadcast("local_sign_out")
        return localApi.link(agents, setUp)
      },
    },
    get,
    patch,
    watchAppSignIn: () => createSignInWatch(mocked ? mockSubscribe : subscribeOwnerState),
  }
}

export function LocalStage({ l, get, patch, onBack, onNext }: { l: LocalProgress; get: () => LocalProgress; patch: (p: Partial<LocalProgress>) => void; onBack: () => void; onNext: () => void }) {
  const io = useMemo(() => makeSetupIO(get, patch), [get, patch])
  // Starts once when the screen opens; a relaunch put an interrupted run back to its step, and this starts it again.
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    const now = get()
    if (!now.running && !now.waitingForAgents && now.failure === null && now.step !== "done") void begin(io)
  }, [io, get])

  useEffect(() => {
    if (!mockAuto || !l.waitingForAgents) return
    const t = window.setTimeout(() => void chooseAgents(io), 1200)
    return () => window.clearTimeout(t)
  }, [l.waitingForAgents, io])

  const actions: LocalSetupActions = {
    tryAgain: () => void begin(io),
    chooseAgents: () => void chooseAgents(io),
    skipAgents: () => void skipAgents(io),
    toggleAgent: (id) => patch({ selected: toggleAgent(get(), id).selected }),
    back: () => {
      void abandon(io)
      onBack()
    },
    next: onNext,
  }
  return <LocalSetupView l={l} actions={actions} />
}
