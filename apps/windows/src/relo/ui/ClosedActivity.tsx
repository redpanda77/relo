// The closed notch's Relo card, the Mac's ReloClosedActivity + ReloOrbitWings (Orbit): one canvas over the whole closed
// notch. Left: Relo's mark with one satellite per live session. Right: the leading card's plan, lit from within, with +N
// for the rest, or a chip. Both wings are washed with the state's colour; a moment (a step, a question, your turn, a
// finish, a failure) plays its own motion and sends beams up both sides. What leads is the server's Lock Screen focus;
// nothing here decides state. The painting is relo/visual/painter.ts (a port of the Swift painter), the moments
// relo/visual/moments.ts, the sizing relo/visual/scene.ts (`closedWidth` is the width the notch should have).

import { deckColors, deckColorState, type DeckBasis } from "@relo/notification-contracts"
import { useEffect, useRef, useState } from "react"
import { useSettings } from "../../settings/store"
import type { OwnerNotice } from "@relo/owner-client"
import type { NotchEvent } from "../events"
import { isMoving, workingSessionsWithoutCards, type Presentation } from "../presentation"
import { useMoments } from "../visual/moments"
import { paintOrbit, Surfaces } from "../visual/painter"
import { markSide, sceneOf, wingContentWidth, type OrbitScene } from "../visual/scene"
import { CLOSED_METRICS, COLORS, toneLabel } from "../visual/theme"

export { closedWidth, isLive, markSide, wingContentWidth } from "../visual/scene"

/** What drives the glow colour, read off the presentation (the Dashboard's `deckBasis`, which reads the raw summary). */
export function ringBasis(p: Presentation): DeckBasis {
  const running = p.sections.find((s) => s.kind === "running")?.rows ?? []
  if (running.some((r) => isMoving(r.tone)) || workingSessionsWithoutCards(p) > 0) return "moving"
  return (p.sections.find((s) => s.kind === "quiet")?.rows.length ?? 0) > 0 ? "quiet" : "calm"
}

/** The deck palette shared with the server and the Dashboard (orb-palette in @relo/notification-contracts). */
export function ringColors(p: Presentation, offline = false): [string, string, string] {
  const basis = ringBasis(p)
  const state = deckColorState(p.needsYouCount, basis)
  return deckColors({}, state, { quiet: basis === "quiet", offline })
}

/** Frame interval per state: the Mac draws at 30 fps; the slow states need far less (battery). */
function frameMs(scene: OrbitScene, playing: boolean): number {
  if (playing) return 1000 / 30
  if (scene.lead === "rest") return 1000 / 10
  if (scene.lead === "quiet") return 1000 / 10
  return 1000 / 30
}

const SIGN_IN_HINT_MS = 8000
let hintShownThisLaunch = false

export interface ClosedActivityProps {
  presentation: Presentation
  connected: boolean
  /** The line under the closed notch, once per launch for 8 s, when Relo has nothing to show and needs the owner ("Relo · hover here to sign in", or the local repair lines). */
  hint?: string | null
  offline?: boolean
  /** Relo's tab is on screen (the notch open on it): the mark stops breathing for what the owner has now seen (ReloMoments.markSeen). */
  open?: boolean
  /** Alerts are paused or a full-screen app is in front: no moment plays (ReloMoments.quiet). Read at each change. */
  quiet?: () => boolean
  /** New notices (the owner client replaces the array per batch): each makes the mark breathe until Relo's tab is seen. */
  notices?: readonly OwnerNotice[]
  /** The onboarding's staged work is shown: its moments play, and the server's own presentation returns silently. */
  staged?: boolean
  /** The card expands for an update (the peek): the wings fade once its shape starts to move. */
  hidden?: boolean
  /** The events of each new batch, most important first (the peek card's cue). */
  onEvents?: (events: NotchEvent[]) => void
}

export function ClosedActivity({ presentation, connected, hint: hintText = null, offline = false, open = false, quiet, notices, staged = false, hidden = false, onEvents }: ClosedActivityProps) {
  const { settings } = useSettings()
  const reduceMotion = settings.reduceMotion || (typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches)
  // The first summary is a baseline that still announces the questions already waiting: the listener is attached before it.
  const [listening, setListening] = useState(false)
  const quietRef = useRef(quiet)
  quietRef.current = quiet
  const { controller, snapshot } = useMoments(presentation, connected && listening, { quiet: () => quietRef.current?.() ?? false }, staged)
  const root = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [hint, setHint] = useState(false)
  const live = presentation.focus !== null || workingSessionsWithoutCards(presentation) > 0

  // The latest inputs, read by the frame loop without re-creating it.
  const input = useRef({ presentation, snapshotUnseen: snapshot.unseen, reduceMotion, hidden, offline })
  input.current = { presentation, snapshotUnseen: snapshot.unseen, reduceMotion, hidden, offline }
  const kick = useRef<() => void>(() => {})

  useEffect(() => {
    setListening(true)
    return onEvents ? controller.onEvents(onEvents) : undefined
  }, [controller, onEvents])

  // A moment the owner has not seen waits until Relo's tab is on screen (ReloMoments.markSeen); hovering does not clear it.
  useEffect(() => {
    if (open) controller.markSeen()
  }, [open, controller])
  // A notice (no sound of its own) makes the mark breathe until Relo's tab is seen (ReloMoments.noticeMoment); the first array is the baseline.
  const lastNotices = useRef(notices)
  useEffect(() => {
    if (notices === lastNotices.current) return
    lastNotices.current = notices
    if (notices && notices.length > 0) controller.noticed()
  }, [notices, controller])

  // Signed out or in need of a repair: say once per launch, for a few seconds, how to start (ReloClosedActivity.flashSignInHint).
  useEffect(() => {
    if (!hintText || live || hintShownThisLaunch) return
    hintShownThisLaunch = true
    setHint(true)
    // The 8 s run on their own clock: a change of the line or of the wings does not cut or restart them.
    setTimeout(() => setHint(false), SIGN_IN_HINT_MS)
  }, [hintText, live])

  // The frame loop: paints at the state's rate, only while visible, and once (on change) with reduced motion.
  useEffect(() => {
    const el = canvas.current
    const box = root.current
    if (!el || !box) return
    const surfaces = new Surfaces(el)
    let timer: ReturnType<typeof setTimeout> | undefined
    let raf = 0
    let scene: OrbitScene | null = null
    let sceneAt = 0
    let sceneKey: Presentation | null = null
    let sceneUnseen = false
    const paint = () => {
      raf = 0
      const cur = input.current
      const now = Date.now()
      const w = box.offsetWidth
      const h = box.offsetHeight
      if (w < 2 || h < 2) return
      surfaces.resize(w, h, window.devicePixelRatio || 1)
      // Satellite pace follows how recent the work is: a coarse clock is enough.
      if (!scene || sceneKey !== cur.presentation || sceneUnseen !== cur.snapshotUnseen || now - sceneAt > 2000) {
        scene = sceneOf(cur.presentation, cur.snapshotUnseen, now)
        sceneAt = now
        sceneKey = cur.presentation
        sceneUnseen = cur.snapshotUnseen
      }
      const side = markSide(h)
      const moment = controller.active(cur.reduceMotion)
      paintOrbit(surfaces, {
        scene,
        moment,
        wing: wingContentWidth(cur.presentation, side),
        side,
        width: w,
        height: h,
        reduceMotion: cur.reduceMotion,
        nowMs: now,
      })
      schedule(frameMs(scene, moment !== null))
    }
    const stopped = () => document.hidden || input.current.hidden || input.current.reduceMotion
    const schedule = (ms: number) => {
      clearTimeout(timer)
      if (stopped()) return
      timer = setTimeout(() => {
        raf = requestAnimationFrame(paint)
      }, ms)
    }
    kick.current = () => {
      clearTimeout(timer)
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(paint)
    }
    kick.current()
    const resize = new ResizeObserver(() => kick.current())
    resize.observe(box)
    const onVisibility = () => kick.current()
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      clearTimeout(timer)
      cancelAnimationFrame(raf)
      resize.disconnect()
      document.removeEventListener("visibilitychange", onVisibility)
      surfaces.dispose()
    }
  }, [controller])

  // Anything that changes what is drawn repaints at once (and restarts the loop after a pause).
  useEffect(() => {
    kick.current()
  }, [presentation, snapshot, reduceMotion, hidden, offline, settings.notchHeight])

  if (!settings.closedActivity) return null
  const lead = presentation.focus
  const label = lead ? `Relo · ${toneLabel(lead.tone)}${snapshot.unseen ? ", new" : ""}` : "Relo"
  return (
    <div
      ref={root}
      className="rv-closed"
      data-hidden={hidden || undefined}
      data-offline={offline || undefined}
      role="img"
      aria-label={label}
      style={{ ["--rv-info" as string]: COLORS.info, ["--rv-outer" as string]: `${CLOSED_METRICS.cornerBottom}px` }}
    >
      <canvas ref={canvas} className="rv-canvas" />
      {hintText && !live && hint ? <div className="rv-hint">{hintText}</div> : null}
    </div>
  )
}
