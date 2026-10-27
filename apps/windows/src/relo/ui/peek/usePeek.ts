// Binds the PeekController to React: one controller for the notch, its gates read from the latest settings and state.

import type { OwnerNotice } from "@relo/owner-client"
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react"
import type { NotchEvent } from "../../events"
import type { Presentation } from "../../presentation"
import { PeekController, type PeekSnapshot } from "./controller"

export interface PeekGates {
  /** Alerts paused from the menu, or a full-screen app in front with "quiet in full screen" on. */
  quiet: boolean
  /** Settings > Alerts > peek. */
  enabled: boolean
  reduceMotion: boolean
}

export interface UsePeek {
  snapshot: PeekSnapshot
  /** Hand the controller the events of each new batch (`ClosedActivity.onEvents`). */
  onEvents: (events: NotchEvent[]) => void
  controller: PeekController
}

export function usePeek(o: {
  gates: PeekGates
  presentation: Presentation
  arrivals: readonly OwnerNotice[]
  /** The pointer is on the notch (Rust's `notch_pointer`). */
  cursorOver: () => boolean
}): UsePeek {
  const gates = useRef(o.gates)
  gates.current = o.gates
  const cursor = useRef(o.cursorOver)
  cursor.current = o.cursorOver
  const controller = useMemo(
    () => new PeekController({ quiet: () => gates.current.quiet, enabled: () => gates.current.enabled, reduceMotion: () => gates.current.reduceMotion, cursorOver: () => cursor.current() }),
    [],
  )
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  useEffect(() => () => controller.dispose(), [controller])
  useEffect(() => controller.closeIfGone(o.presentation), [controller, o.presentation])
  // Notices: each new arrival once (the owner client replaces the array when the batch changes).
  const lastArrivals = useRef<readonly OwnerNotice[]>(o.arrivals)
  useEffect(() => {
    if (o.arrivals === lastArrivals.current) return
    lastArrivals.current = o.arrivals
    controller.receiveNotices([...o.arrivals])
  }, [controller, o.arrivals])
  const onEvents = useCallback((events: NotchEvent[]) => controller.receive(events), [controller])
  return { snapshot, onEvents, controller }
}
