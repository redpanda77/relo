import * as React from "react"

// Types only: the scene and three.js load in their own chunk.
import type { OrbArc, OrbMotion, OrbScene, OrbTheme } from "@/lib/orb-scene"
import { continueSkeletonBreath, endSkeletonBreath } from "@/app/skeleton-handoff"
import { usePrefersReducedMotion } from "@/lib/motion"
import { LANDING_SIGNALS, LANDING_THEME, type OrbCometLook } from "@/lib/orb-theme"
import { cn } from "@/lib/utils"

/** One comet: one real update, from its origin (a screen-plane angle, radians), about one item. */
export type OrbComet = OrbCometLook & { id: string; from: number }
/** One refresh's comets; a new `key` launches them once. */
export type OrbComets = { key: number; comets: readonly OrbComet[] }

/** A refresh's comets launch 300 ms apart; the page-open catch-up 600 ms after the scene is ready, 350 ms apart. */
const BATCH_GAP_S = 0.3
const CATCH_UP_LEAD_S = 0.6
const CATCH_UP_GAP_S = 0.35

/** Overlays that cover the deck (sheets, dialogs, the drawer): the core rests while one is open. */
const OVERLAY = '[data-slot="sheet-content"],[data-slot="dialog-content"],[data-slot="alert-dialog-content"],[data-vaul-drawer]'

/** The painted core's plasma layers (index.css), bottom to top; the server's first frame paints the same. */
export const PAINTED_LAYERS = ["band1", "band2", "band3", "shade", "vein"] as const

/** An arc held back until its comet lands: absent (a new card grows in then) or at its last progress. */
type Hold = { kind: "absent" } | { kind: "at"; progress: number | null }

/**
 * The Relo core in its deck framing (the same scene as the landing hero, `lib/orb-scene.ts`),
 * filling its box. The scene loads in its own chunk after first paint; until it is ready, and
 * without WebGL, a painted orb in the same colours holds the place. It draws only while on screen
 * and the tab is visible, holds one still frame under reduced motion, and ripples where it is
 * touched. Children sit over the core's centre.
 *
 * With `motion` (Now) every motion means something: the steady motion follows the server's summary,
 * comets fly only for real updates (`comets`, and the page-open `catchUp` once), and an arc that a
 * comet reports waits for that comet to land before it grows in or eases forward. Comet delays run
 * on the scene's own clock, so they hold while the scene is paused (hidden tab, covered, off
 * screen). Without `motion` (sign-in, loading) the core is decorative: a lively plasma and the
 * landing's six-comet stream.
 */
export function OrbStage({
  theme = LANDING_THEME,
  motion,
  arcs = [],
  comets,
  catchUp = [],
  interactive = true,
  className,
  style,
  children,
}: {
  theme?: OrbTheme
  /** The steady motion from the server's summary; absent for a decorative stage. */
  motion?: OrbMotion
  /** Each task's arc on the inner ring. */
  arcs?: readonly OrbArc[]
  /** The latest refresh's comets (one per real update). */
  comets?: OrbComets
  /** What happened since the owner looked, launched once when the scene is first ready. */
  catchUp?: readonly OrbComet[]
  interactive?: boolean
  className?: string
  style?: React.CSSProperties
  children?: React.ReactNode
}) {
  const boxRef = React.useRef<HTMLDivElement>(null)
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const sceneRef = React.useRef<OrbScene | null>(null)
  const [mode, setMode] = React.useState<"loading" | "ready" | "painted">("loading")
  const [launched, setLaunched] = React.useState(0)
  const reduced = usePrefersReducedMotion()
  const decorative = !motion

  // The latest inputs, read when the scene arrives and pushed on every change after.
  const themeKey = JSON.stringify(theme)
  const motionKey = motion ? JSON.stringify(motion) : ""
  const arcsKey = JSON.stringify(arcs)
  const inputs = React.useRef({ theme, motion, arcs: [...arcs] as OrbArc[], catchUp })
  React.useEffect(() => {
    inputs.current.theme = JSON.parse(themeKey) as OrbTheme
    sceneRef.current?.setTheme(inputs.current.theme)
  }, [themeKey])
  React.useEffect(() => {
    if (!motionKey) return
    inputs.current.motion = JSON.parse(motionKey) as OrbMotion
    sceneRef.current?.setMotion(inputs.current.motion)
  }, [motionKey])

  // Arcs a comet reports wait for it: held while it flies, released when it lands.
  const held = React.useRef(new Map<string, Hold>())
  const pushed = React.useRef(new Map<string, number | null>())
  const pushArcs = React.useCallback(() => {
    const shown = inputs.current.arcs.flatMap((arc): OrbArc[] => {
      const hold = held.current.get(arc.id)
      if (!hold) return [arc]
      return hold.kind === "absent" ? [] : [{ ...arc, progress: hold.progress }]
    })
    for (const arc of shown) pushed.current.set(arc.id, arc.progress)
    sceneRef.current?.setArcs(shown)
  }, [])

  // Comets that arrive before the scene does wait for it, with their delays (scene time).
  const queue = React.useRef<{ comet: OrbComet; delay: number }[]>([])
  const fire = React.useCallback(
    (comet: OrbComet, delay: number) => {
      const scene = sceneRef.current
      if (!scene) {
        queue.current.push({ comet, delay })
        return
      }
      const release = () => {
        if (held.current.delete(comet.id)) pushArcs()
      }
      const flew = scene.pulse(comet.color, {
        kind: comet.kind,
        strength: comet.impact,
        size: comet.size,
        trailScale: comet.trailScale,
        from: comet.from,
        delay,
        onLand: release,
      })
      if (flew) setLaunched((count) => count + 1)
      else release()
    },
    [pushArcs]
  )
  const launch = React.useCallback(
    (list: readonly OrbComet[], gap: number, lead = 0) => {
      // Reduced motion: no comets; arcs jump to the truth.
      if (reduced) return
      list.forEach((comet, index) => {
        if (comet.arc === "grow") held.current.set(comet.id, { kind: "absent" })
        else if (comet.arc === "advance" && pushed.current.has(comet.id)) {
          held.current.set(comet.id, { kind: "at", progress: pushed.current.get(comet.id) ?? null })
        }
        fire(comet, lead + index * gap)
      })
    },
    [fire, reduced]
  )

  // Each refresh's comets once per key, then the arcs (held where a comet reports them).
  const lastKey = React.useRef(comets?.key)
  React.useEffect(() => {
    inputs.current.arcs = JSON.parse(arcsKey) as OrbArc[]
    if (comets && comets.key !== lastKey.current) {
      lastKey.current = comets.key
      launch(comets.comets, BATCH_GAP_S)
    }
    pushArcs()
  }, [arcsKey, comets, launch, pushArcs])

  const caughtUp = React.useRef(false)
  React.useEffect(() => {
    const canvas = canvasRef.current
    const box = boxRef.current
    if (!canvas || !box) return
    let disposed = false
    let offscreen = false
    let covered = false
    let observer: IntersectionObserver | undefined
    const apply = () => sceneRef.current?.setPaused(offscreen || covered || document.hidden)
    // The deck rests under a sheet or dialog: the portal mounts straight under <body>.
    const overlays = new MutationObserver(() => {
      const next = document.querySelector(OVERLAY) !== null
      if (next !== covered) {
        covered = next
        apply()
      }
    })
    overlays.observe(document.body, { childList: true })
    const fail = () => {
      sceneRef.current?.dispose()
      sceneRef.current = null
      if (!disposed) setMode("painted")
    }
    import("@/lib/orb-scene")
      .then(({ createOrbScene, supportsWebGL }) => {
        if (disposed) return
        if (!supportsWebGL()) return fail()
        const scene = createOrbScene(canvas, {
          framing: "deck",
          reducedMotion: reduced,
          theme: inputs.current.theme,
          motion: inputs.current.motion,
          signals: decorative ? LANDING_SIGNALS : undefined,
          onReady: () => {
            if (disposed) return
            setMode("ready")
            // The page-open catch-up, once: what happened since the owner looked, then calm.
            if (!caughtUp.current) {
              caughtUp.current = true
              launch(inputs.current.catchUp, CATCH_UP_GAP_S, CATCH_UP_LEAD_S)
            }
          },
          onLost: fail,
        })
        sceneRef.current = scene
        pushArcs()
        for (const { comet, delay } of queue.current.splice(0)) fire(comet, delay)
        if (typeof IntersectionObserver === "function") {
          observer = new IntersectionObserver(([entry]) => {
            offscreen = !(entry?.isIntersecting ?? true)
            apply()
          })
          observer.observe(box)
        }
        apply()
      })
      .catch(fail)
    document.addEventListener("visibilitychange", apply)
    const holds = held.current
    return () => {
      disposed = true
      observer?.disconnect()
      overlays.disconnect()
      document.removeEventListener("visibilitychange", apply)
      sceneRef.current?.dispose()
      sceneRef.current = null
      // Comets in flight go with the scene: their arcs show the truth.
      holds.clear()
    }
  }, [reduced, decorative, launch, fire, pushArcs])

  // The painted core taking over from the server's (skeleton-handoff.ts): on the skeleton's beat
  // from its first frame, so its opacity does not snap; the breath ends once the scene is ready.
  const paintedRef = React.useRef<HTMLSpanElement>(null)
  React.useLayoutEffect(() => {
    if (mode !== "loading") return endSkeletonBreath()
    continueSkeletonBreath(paintedRef.current)
  }, [mode])

  const pressed = React.useRef(0)
  const onPointerDown = (event: React.PointerEvent) => {
    if (!interactive || reduced) return
    if (sceneRef.current?.touch(event.clientX, event.clientY)) pressed.current = performance.now()
  }
  const onPointerMove = (event: React.PointerEvent) => {
    if (!pressed.current || performance.now() - pressed.current < 140) return
    if (sceneRef.current?.touch(event.clientX, event.clientY)) pressed.current = performance.now()
  }
  const release = () => {
    pressed.current = 0
  }

  const [c1, c2, c3] = theme.colors
  return (
    <div
      ref={boxRef}
      className={cn("orb-stage", className)}
      data-orb-stage={mode}
      data-orb-motion={motion?.mode ?? "decorative"}
      data-orb-comets={decorative ? undefined : launched}
      style={{ ...style, ["--orb-1" as string]: c1, ["--orb-2" as string]: c2, ["--orb-3" as string]: c3 }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={release}
      onPointerCancel={release}
      onPointerLeave={release}
    >
      <span ref={paintedRef} aria-hidden="true" className="orb-stage-painted">
        {PAINTED_LAYERS.map((layer) => (
          <i key={layer} data-layer={layer} />
        ))}
      </span>
      <canvas ref={canvasRef} aria-hidden="true" />
      {children ? <div className="orb-stage-centre">{children}</div> : null}
    </div>
  )
}
