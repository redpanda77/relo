import * as React from "react"

import {
  ACCENT,
  ENERGY,
  HUD_COLORS,
  HudRenderer,
  WAVE_LIFETIME_MS,
  css,
  drawDust,
  drawOrbitPlane,
  type HudArc,
  type HudState,
  type RGB,
  type Wave,
} from "@/lib/hud-render"
import { PlasmaOrb, plasmaStops } from "@/lib/plasma-orb"
import { SIGNAL_CSS, SIGNAL_LABEL, SIGNAL_RAMP, mixShares, type NowMix } from "@/lib/signal"
import { cn } from "@/lib/utils"

export type NowHudProps = {
  today: number
  done: number
  running: number
  needsYou: number
  arcs: HudArc[]
  sentence: string
  /** Today's work by meaning: colors the core, the orbital plane, the dust and the spectrum bar. */
  mix?: NowMix
  /** When the page last synced, and the current time (ms). */
  syncedAt?: number
  now?: number
  syncing?: boolean
  /** Today's agent time, already formatted ("4h 12m"); hidden when absent. */
  agentTime?: string | null
  /** The signed-out Welcome stage: the living deck with the wordmark and no numbers, as on the iPhone. */
  welcome?: { label: string }
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = React.useState(() =>
    typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false
  )
  React.useEffect(() => {
    if (typeof window.matchMedia !== "function") return
    const query = window.matchMedia("(prefers-reduced-motion: reduce)")
    const update = () => setReduced(query.matches)
    update()
    query.addEventListener?.("change", update)
    return () => query.removeEventListener?.("change", update)
  }, [])
  return reduced
}

function useOnline() {
  const [online, setOnline] = React.useState(() => (typeof navigator === "undefined" ? true : navigator.onLine))
  React.useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener("online", update)
    window.addEventListener("offline", update)
    return () => {
      window.removeEventListener("online", update)
      window.removeEventListener("offline", update)
    }
  }, [])
  return online
}

type Centre = { value: number; label: string; state: HudState }

function centreFor(needsYou: number, running: number, today: number, phase: 0 | 1): Centre {
  if (needsYou > 0 && running > 0) {
    return phase === 0
      ? { value: needsYou, label: "Needs you", state: "needsYou" }
      : { value: running, label: "Running", state: "running" }
  }
  if (needsYou > 0) return { value: needsYou, label: "Needs you", state: "needsYou" }
  if (running > 0) return { value: running, label: "Running", state: "running" }
  return { value: today, label: "Today", state: "clear" }
}

const rgb = (color: RGB) => css(color)

/** A corner readout: flat numerals in the meaning's color when lit, muted when zero. */
function Readout({
  label,
  value,
  color,
  lit,
  className,
}: {
  label: string
  value: number
  color: string
  lit: boolean
  className: string
}) {
  return (
    <div aria-hidden="true" className={cn("absolute flex flex-col gap-0.5", className)}>
      <span className="micro" style={lit ? { color } : undefined}>{label}</span>
      <span className="numeral text-2xl leading-none sm:text-3xl" style={{ color: lit ? color : "var(--muted-foreground)" }}>
        {value}
      </span>
    </div>
  )
}

const BAR_GAP = 3

/**
 * Today's proportions by meaning, edge to edge: one thin segmented bar with the meaning names
 * under segments wide enough to hold them. It says what the colors mean without repeating the
 * corner counts.
 */
function SpectrumBar({ mix }: { mix: NowMix }) {
  const ref = React.useRef<HTMLDivElement>(null)
  const [width, setWidth] = React.useState(0)
  React.useEffect(() => {
    const element = ref.current
    if (!element) return
    const update = () => setWidth(element.getBoundingClientRect().width)
    update()
    if (typeof ResizeObserver !== "function") return
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const shares = mixShares(mix)
  if (!shares.length) return null
  const usable = width - BAR_GAP * Math.max(shares.length - 1, 0)
  return (
    <div
      ref={ref}
      role="img"
      aria-label={`Today by kind: ${shares
        .map(({ signal, share }) => `${Math.round(share * 100)} percent ${SIGNAL_LABEL[signal].toLowerCase()}`)
        .join(", ")}`}
      className="flex items-start"
      data-hud-spectrum
      style={{ gap: BAR_GAP, minHeight: 22 }}
    >
      {shares.map(({ signal, share }) => {
        const segment = Math.max(usable * share, 4)
        const { light, deep } = SIGNAL_RAMP[signal]
        return (
          <div key={signal} className="flex min-w-0 flex-col gap-1.5" data-signal={signal} style={{ flex: `${share} 1 0`, minWidth: 4 }}>
            <span
              aria-hidden="true"
              className="block h-[3px] rounded-full"
              style={{ background: `linear-gradient(90deg, ${css(light)}, ${css(deep)})` }}
            />
            {segment > 52 ? (
              <span aria-hidden="true" className="micro whitespace-nowrap" style={{ color: SIGNAL_CSS[signal], opacity: 0.85, letterSpacing: "0.12em" }}>
                {SIGNAL_LABEL[signal].toUpperCase()}
              </span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/** Where the data stands, then today's proportions edge to edge. */
function DeckFooter({
  mode,
  at,
  mix,
  agentTime,
}: {
  mode: "live" | "syncing" | "stale" | "offline"
  at: number
  mix: NowMix
  agentTime: string | null
}) {
  const time = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(at)
  const color = mode === "live" ? SIGNAL_CSS.done : mode === "syncing" ? SIGNAL_CSS.running : SIGNAL_CSS.attention
  const text =
    mode === "live" ? `LIVE · SYNCED ${time}` : mode === "syncing" ? "SYNCING" : mode === "stale" ? `STALE · ${time}` : `OFFLINE · ${time}`
  return (
    <div className="relative flex flex-col gap-3 px-1">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <span className="micro inline-flex items-center gap-1.5" style={{ color, letterSpacing: "0.1em" }}>
          <span aria-hidden="true" className="size-1.5 rounded-full" style={{ background: color }} />
          {text}
        </span>
        {agentTime ? (
          <span className="micro tabular-nums" data-hud-agent-time style={{ letterSpacing: "0.1em" }}>
            {`AGENT TIME ${agentTime.toUpperCase()}`}
          </span>
        ) : null}
      </div>
      <SpectrumBar mix={mix} />
    </div>
  )
}

const STAGE_HEIGHT = 330
/** Layer sizes relative to the 330px particle shell (the app: core 300, shell 330, ring 286). */
const CORE_RATIO = 300 / 330
const RING_RATIO = 286 / 330

/**
 * The Now header, edge to edge: a dust field across the deck, an orbital plane of particle streams
 * through it (far half behind the orb, near half in front), the plasma core in today's meaning
 * colors with a particle shell over it, an instrument ring with each running task, and four corner
 * readouts. Touch the deck and a ripple runs through the core, the shell, the plane and the dust.
 */
export function NowHud({
  today,
  done,
  running,
  needsYou,
  arcs,
  sentence,
  mix = {},
  syncedAt,
  now,
  syncing = false,
  agentTime = null,
  welcome,
}: NowHudProps) {
  const dustRef = React.useRef<HTMLCanvasElement>(null)
  const farRef = React.useRef<HTMLCanvasElement>(null)
  const nearRef = React.useRef<HTMLCanvasElement>(null)
  const coreRef = React.useRef<HTMLCanvasElement>(null)
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const ringRef = React.useRef<HTMLCanvasElement>(null)
  const deckRef = React.useRef<HTMLElement>(null)
  const boxRef = React.useRef<HTMLDivElement>(null)
  const wavesRef = React.useRef<Wave[]>([])
  const lastWaveRef = React.useRef(0)
  const pressedRef = React.useRef(false)
  const renderRef = React.useRef<(() => void) | null>(null)
  const [hudRenderer] = React.useState(() => new HudRenderer())
  const [plasma, setPlasma] = React.useState(true)
  const reduced = usePrefersReducedMotion()
  const online = useOnline()
  const alternates = needsYou > 0 && running > 0 && !reduced
  const [phase, setPhase] = React.useState<0 | 1>(0)
  const centre: Centre = welcome
    ? { value: 0, label: welcome.label, state: "running" }
    : centreFor(needsYou, running, today, alternates ? phase : 0)
  const accent = ACCENT[centre.state]
  const live = centre.state !== "clear"
  const mixKey = JSON.stringify(mix)
  // Held in refs so the animation loop always reads the latest without restarting.
  const mixRef = React.useRef<NowMix>(mix)
  const stateRef = React.useRef<HudState>(centre.state)
  React.useEffect(() => {
    mixRef.current = JSON.parse(mixKey) as NowMix
    stateRef.current = centre.state
    // A still frame (reduced motion) has no loop to pick the change up.
    renderRef.current?.()
  }, [mixKey, centre.state])

  React.useEffect(() => {
    if (!alternates) return
    const timer = window.setInterval(() => setPhase((value) => (value === 0 ? 1 : 0)), 3600)
    return () => window.clearInterval(timer)
  }, [alternates])

  React.useEffect(() => {
    hudRenderer.setState(centre.state, performance.now())
  }, [centre.state, hudRenderer])

  /** Adds a ripple at a point in the deck's own coordinates, keeping only the live ones. */
  const addWave = React.useCallback((x: number, y: number, strength: number) => {
    const at = performance.now()
    lastWaveRef.current = at
    wavesRef.current = [...wavesRef.current.filter((wave) => at - wave.at < WAVE_LIFETIME_MS).slice(-7), { x, y, at, strength }]
  }, [])

  const orbCentre = React.useCallback(() => {
    const deck = deckRef.current?.getBoundingClientRect()
    const box = boxRef.current?.getBoundingClientRect()
    if (!deck || !box) return null
    return { x: box.left - deck.left + box.width / 2, y: box.top - deck.top + box.height / 2 }
  }, [])

  // New activity sends a ring and a wave outward; finished work also flashes the ticks green.
  const previous = React.useRef({ today, done })
  React.useEffect(() => {
    const before = previous.current
    previous.current = { today, done }
    if (reduced) return
    const at = performance.now()
    const origin = orbCentre()
    if (done > before.done) {
      hudRenderer.flash(HUD_COLORS.MINT, at)
      hudRenderer.emit(at)
      if (origin) addWave(origin.x, origin.y, 1.4)
    } else if (today > before.today) {
      hudRenderer.flash(accent, at)
      hudRenderer.emit(at)
      if (origin) addWave(origin.x, origin.y, 1.2)
    }
  }, [today, done, reduced, accent, hudRenderer, addWave, orbCentre])

  const arcsKey = arcs.map((arc) => arc.progress ?? "n").join(",")

  React.useEffect(() => {
    const canvas = canvasRef.current
    const ring = ringRef.current
    const dust = dustRef.current
    const far = farRef.current
    const near = nearRef.current
    const core = coreRef.current
    const box = boxRef.current
    const deck = deckRef.current
    if (!canvas || !ring || !box || !deck) return
    const context = canvas.getContext("2d")
    const ringContext = ring.getContext("2d")
    if (!context || !ringContext) return
    const dustContext = dust?.getContext("2d") ?? null
    const farContext = far?.getContext("2d") ?? null
    const nearContext = near?.getContext("2d") ?? null
    const hud = hudRenderer
    // The plasma core is WebGL; without it the particle shell is the whole sphere.
    const orb = core ? PlasmaOrb.create(core, () => setPlasma(false)) : null
    if (core && !orb) setPlasma(false)

    let size = 0
    let coreSize = 0
    let ringSize = 0
    let deckWidth = 0
    let frame = 0
    const origin = performance.now()
    let visible = typeof document === "undefined" || document.visibilityState !== "hidden"
    const currentArcs = arcsKey ? arcsKey.split(",").map((part): HudArc => ({ progress: part === "n" ? null : Number(part) })) : []

    const render = () => {
      if (!size) return
      const now = performance.now()
      // Reduced motion: one still frame at the app's resting time, and no ripples.
      const time = reduced ? 11 : 11 + (now - origin) / 1000
      const waves = reduced ? [] : wavesRef.current
      const deckRect = deck.getBoundingClientRect()
      const boxRect = box.getBoundingClientRect()
      const offsetX = boxRect.left - deckRect.left
      const offsetY = boxRect.top - deckRect.top
      hud.draw(context, {
        size,
        time,
        now,
        arcs: currentArcs,
        still: reduced,
        mix: mixRef.current,
        waves,
        offset: { x: offsetX, y: offsetY },
      })
      hud.drawRing(ringContext, { size: ringSize, time, now, arcs: currentArcs, still: reduced })
      if (orb && coreSize) {
        // The latest ripple also warps the plasma, in the core canvas's own coordinates.
        const wave = waves.at(-1)
        const inset = (size - coreSize) / 2
        orb.draw({
          time: reduced ? 9 : (now - origin) / 1000,
          energy: ENERGY[stateRef.current],
          stops: plasmaStops(mixRef.current, stateRef.current),
          touch: wave ? { x: wave.x - offsetX - inset, y: wave.y - offsetY - inset } : { x: 0, y: 0 },
          touchAge: wave ? (now - wave.at) / 1000 : -1,
        })
      }
      if (deckWidth) {
        const common = { width: deckWidth, height: STAGE_HEIGHT, now, state: stateRef.current, mix: mixRef.current, waves }
        const planeTime = reduced ? 4 : (now - origin) / 1000
        const planes = { ...common, time: planeTime, arcs: currentArcs, center: { x: deckWidth / 2, y: STAGE_HEIGHT / 2 } }
        if (farContext) drawOrbitPlane(farContext, { ...planes, half: "far" })
        if (nearContext) drawOrbitPlane(nearContext, { ...planes, half: "near" })
        if (dustContext && dust) {
          drawDust(dustContext, { ...common, height: deck.getBoundingClientRect().height, time: reduced ? 5 : (now - origin) / 1000 })
        }
      }
    }
    renderRef.current = () => render()

    const fit = (element: HTMLCanvasElement | null, ctx: CanvasRenderingContext2D | null, width: number, height: number, ratio: number) => {
      if (!element || !ctx || width <= 0 || height <= 0) return
      element.width = Math.round(width * ratio)
      element.height = Math.round(height * ratio)
      element.style.width = `${width}px`
      element.style.height = `${height}px`
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    }
    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      const next = Math.round(box.getBoundingClientRect().width)
      if (next > 0) {
        size = next
        coreSize = Math.round(next * CORE_RATIO)
        ringSize = Math.round(next * RING_RATIO)
        fit(canvas, context, size, size, ratio)
        fit(ring, ringContext, ringSize, ringSize, ratio)
        orb?.resize(coreSize, coreSize, ratio)
      }
      const rect = deck.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        deckWidth = rect.width
        fit(far, farContext, rect.width, STAGE_HEIGHT, ratio)
        fit(near, nearContext, rect.width, STAGE_HEIGHT, ratio)
        fit(dust, dustContext, rect.width, rect.height, ratio)
      }
      render()
    }
    // 30 fps is plenty for slow effects and halves the work; nothing draws while the deck is
    // scrolled out of view or the tab is hidden (battery).
    let lastDrawn = 0
    let onScreen = true
    const loop = (now: number) => {
      if (now - lastDrawn >= 1000 / 30 - 1) {
        lastDrawn = now
        render()
      }
      frame = window.requestAnimationFrame(loop)
    }
    const play = () => {
      window.cancelAnimationFrame(frame)
      if (!reduced && visible && onScreen) frame = window.requestAnimationFrame(loop)
    }
    const onVisibility = () => {
      visible = document.visibilityState !== "hidden"
      play()
    }

    resize()
    // The one authored entrance: the signal announces itself once.
    if (!reduced) hud.emit(performance.now())
    play()
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null
    observer?.observe(box)
    observer?.observe(deck)
    document.addEventListener("visibilitychange", onVisibility)
    const viewport = typeof IntersectionObserver === "function"
      ? new IntersectionObserver(([entry]) => { onScreen = entry?.isIntersecting ?? true; play() })
      : null
    viewport?.observe(deck)
    return () => {
      viewport?.disconnect()
      window.cancelAnimationFrame(frame)
      renderRef.current = null
      observer?.disconnect()
      document.removeEventListener("visibilitychange", onVisibility)
      orb?.dispose()
    }
  }, [reduced, arcsKey, hudRenderer])

  const pointerAt = (event: React.PointerEvent) => {
    const rect = deckRef.current?.getBoundingClientRect()
    return rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : null
  }
  // Press the deck and a strong ripple runs through the core and the dust; drag to keep stirring.
  const onPointerDown = (event: React.PointerEvent) => {
    if (reduced) return
    pressedRef.current = true
    const point = pointerAt(event)
    if (point) addWave(point.x, point.y, 1.3)
  }
  const onPointerMove = (event: React.PointerEvent) => {
    if (reduced || !pressedRef.current) return
    if (performance.now() - lastWaveRef.current <= 140) return
    const point = pointerAt(event)
    if (point) addWave(point.x, point.y, 0.65)
  }
  const release = () => {
    pressedRef.current = false
  }

  const accentCss = rgb(accent)
  const ramp: Record<HudState, RGB> = { clear: HUD_COLORS.MINT, running: HUD_COLORS.BLUE, needsYou: HUD_COLORS.CORAL }
  const fast = centre.state === "needsYou"
  const syncMode = syncing ? "syncing" : !online ? "offline" : syncedAt != null && now != null && now - syncedAt > 5 * 60_000 ? "stale" : "live"
  const layer = "pointer-events-none absolute top-0 left-0"

  return (
    <section
      ref={deckRef}
      aria-label={welcome ? "Relo" : "Now overview"}
      className="relative w-full touch-pan-y select-none"
      data-now-hud
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={release}
      onPointerCancel={release}
      onPointerLeave={release}
    >
      {welcome ? null : (
        <p className="sr-only" role="status">
          {`${today} today, ${done} done, ${running} running, ${needsYou} need you. ${sentence}`}
        </p>
      )}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          maskImage: "linear-gradient(to bottom, #000 0%, #000 82%, transparent 100%)",
          WebkitMaskImage: "linear-gradient(to bottom, #000 0%, #000 82%, transparent 100%)",
        }}
      >
        <div
          className="absolute inset-0"
          data-hud-glow
          style={{
            background: `radial-gradient(ellipse 60% 52% at 50% ${STAGE_HEIGHT / 2}px, ${css(accent, 0.16)} 0%, ${css(accent, 0.05)} 55%, transparent 100%)`,
            transition: "background 900ms ease",
          }}
        />
        <canvas ref={dustRef} className="absolute inset-0 block" data-hud-dust />
      </div>
      <div className="relative w-full" style={{ height: STAGE_HEIGHT }}>
        <canvas ref={farRef} aria-hidden="true" className={cn(layer, "block")} data-hud-plane="far" />
        <div
          ref={boxRef}
          className="absolute top-1/2 left-1/2 aspect-square w-[min(330px,94vw)] -translate-x-1/2 -translate-y-1/2"
        >
          <canvas
            ref={coreRef}
            aria-hidden="true"
            className={cn("pointer-events-none absolute top-1/2 left-1/2 block -translate-x-1/2 -translate-y-1/2", !plasma && "hidden")}
            data-hud-core
          />
          <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none absolute top-0 left-0 block" style={{ opacity: plasma ? 0.75 : 1 }} />
        </div>
        <canvas ref={nearRef} aria-hidden="true" className={cn(layer, "block")} data-hud-plane="near" />
        <canvas
          ref={ringRef}
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-1/2 block -translate-x-1/2 -translate-y-1/2"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-1/2 flex w-40 -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center text-center"
          data-hud-centre={centre.label}
        >
          {welcome ? (
            <span className="wordmark wordmark-glow text-[3.75rem]">relo</span>
          ) : (
          <span
            key={centre.label}
            className={cn("hud-number numeral text-6xl leading-none sm:text-7xl", live && !reduced && (fast ? "hud-breathe-fast" : "hud-breathe"))}
            style={{
              backgroundImage: live
                ? `linear-gradient(180deg, #ffffff 0%, ${rgb(ramp[centre.state])} 100%)`
                : "none",
              color: live ? "transparent" : "#ffffff",
              ["--glow" as string]: css(accent, 0.7),
            }}
          >
            {centre.value}
          </span>
          )}
          <span className="mt-2 flex items-center gap-2">
            <span
              className={cn("ink-dot", live && !reduced && "breathe")}
              style={{ ["--tone" as string]: accentCss }}
            />
            <span className="micro hud-center" style={{ color: accentCss }}>{centre.label}</span>
          </span>
        </div>
        {welcome ? null : (<>
        <Readout label="Today" value={today} color="#ffffff" lit className="top-1 left-3 sm:left-4" />
        <Readout label="Done" value={done} color={SIGNAL_CSS.done} lit={done > 0} className="top-1 right-3 items-end text-right sm:right-4" />
        <Readout label="Running" value={running} color={SIGNAL_CSS.running} lit={running > 0} className="bottom-1 left-3 sm:left-4" />
        <Readout label="Needs you" value={needsYou} color={SIGNAL_CSS.needsYou} lit={needsYou > 0} className="right-3 bottom-1 items-end text-right sm:right-4" />
        </>)}
      </div>
      {syncedAt != null ? (
        <div className="relative mt-4">
          <DeckFooter mode={syncMode} at={syncedAt} mix={mix} agentTime={agentTime} />
        </div>
      ) : null}
    </section>
  )
}
