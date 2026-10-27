import { useEffect, useMemo, useSyncExternalStore } from "react"
import { EMPTY, type Presentation } from "../relo/presentation"
import { settingsStore } from "../settings/store"
import { cuePlayer, isQuiet } from "../sound"
import { voiceMoments } from "../voice"
import * as ipc from "../voice/ipc"
import { AlertsController, type AlertsState, type OwnerAlerts, type SpeechLike, type StagedMoments } from "./controller"

const speech: SpeechLike = {
  speak: (id, text) => ipc.tauriBackend.speak(id, text),
  cancel: () => ipc.tauriBackend.cancel(),
  microphoneInUse: () => ipc.tauriBackend.microphoneInUse(),
  async ready() {
    const status = await ipc.status()
    return status !== null && status.model.state === "ready"
  },
  async current() {
    const status = await ipc.status()
    return status && status.state.phase !== "idle" ? status.state.id : null
  },
}

/** The app's one controller, wired to the real cue player, voice and settings. */
export function createAlerts(initial: Presentation): AlertsController {
  return new AlertsController(
    {
      settings: () => settingsStore.get(),
      quiet: () => isQuiet(),
      cues: cuePlayer,
      voice: voiceMoments,
      speech,
      now: Date.now,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    initial,
  )
}

let shared: AlertsController | null = null
/** The one controller of this window (the notch's). `useAlerts` and the non-React callers (`quit`, `launch`) share it. */
export const alerts = (initial: Presentation): AlertsController => (shared ??= createAlerts(initial))

export interface UseAlertsOptions {
  presentation: Presentation
  /** A summary (or snapshot) was fetched; default: the presentation is not the empty one `presentationOf(null)` returns. */
  hasData?: boolean
  /** Set while the onboarding stages its work in the notch: its moments repeat and play as staged (no gap, no voice, no per-event switch). */
  events?: StagedMoments | null
  owner?: OwnerAlerts | null
}

/**
 * See src/alerts/index.ts. Feeds the controller at every change and returns what the notch draws and calls.
 */
export function useAlerts(options: UseAlertsOptions): AlertsState & Pick<AlertsController, "markSeen" | "quiet" | "peekAllowed" | "canPlay" | "playCard" | "interfaceCue" | "launchCue" | "quitSound" | "greetReady"> {
  const { presentation, owner } = options
  const controller = useMemo(() => alerts(presentation), []) // eslint-disable-line react-hooks/exhaustive-deps
  const view = owner?.view
  const staged = options.events?.staged === true
  const hasData = options.hasData ?? presentation !== EMPTY
  useEffect(() => {
    void settingsStore.start()
    void controller.receive({
      presentation,
      hasData,
      connection: view?.connection,
      answers: view?.answers,
      questions: view?.questions,
      spoken: view?.spoken,
      pausedUntil: view?.pausedUntil,
      notices: view?.arrivals,
      staged,
      stagedRowId: options.events?.stagedRowId,
    })
  }, [controller, presentation, hasData, view?.connection, view?.answers, view?.questions, view?.spoken, view?.pausedUntil, view?.arrivals, staged, options.events?.stagedRowId])
  const state = useSyncExternalStore(controller.subscribe, controller.getState)
  return {
    ...state,
    markSeen: controller.markSeen,
    quiet: controller.quiet,
    peekAllowed: controller.peekAllowed,
    canPlay: controller.canPlay,
    playCard: controller.playCard,
    interfaceCue: controller.interfaceCue,
    launchCue: controller.launchCue,
    quitSound: controller.quitSound,
    greetReady: controller.greetReady,
  }
}
