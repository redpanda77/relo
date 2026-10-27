// The closed notch's wings painted on a 2D canvas. A faithful port of `ReloOrbitPainter` and `ReloBarPainter`
// (apps/notch/boringNotch/components/Relo/ReloOrbitWings.swift lines 156-760): the same geometry, constants, easing,
// timings and draw order, with SwiftUI's GraphicsContext mapped to Canvas 2D:
//   .plusLighter -> globalCompositeOperation "lighter"      drawLayer + .blur(3) -> ctx.filter blur(3px)
//   .colorShader(reloWingLight) -> WingLightPass (WebGL)     Path(roundedRect:) -> roundRect
// The notch's black body is drawn by Notch.tsx; this paints only the light and the marks over it, in the notch's own
// frame (its black shape, rounded corners included), and clears nothing it does not own.

import { Ease, referenceSeconds } from "./ease"
import { isPlaying, type OrbitMoment } from "./moments"
import type { OrbitScene, Satellite } from "./scene"
import { CLOSED_METRICS, COLORS } from "./theme"
import { WingLightPass } from "./wing-light"
import type { BarSegment } from "../plan"

type RGB = readonly [number, number, number]

const rgb = (hex: string): RGB => {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
const css = (c: RGB, a = 1): string => `rgba(${c[0]},${c[1]},${c[2]},${a < 0 ? 0 : a > 1 ? 1 : a})`

// Painter colours: ReloOrbitWings.swift:188-193.
const RUN = rgb(COLORS.running)
const NEEDS = rgb(COLORS.signalCoral)
const TURN = rgb(COLORS.signalCoral)
const DONE = rgb(COLORS.done)
const FAILED = rgb(COLORS.problem)
const QUIET = rgb(COLORS.quiet)
const SLATE = rgb(COLORS.info)
const YELLOW = rgb(COLORS.yellow)
const WHITE: RGB = [255, 255, 255]
const BLACK: RGB = [0, 0, 0]

const FONT = `"Inter Variable", system-ui, "Segoe UI", sans-serif`

/** Agents' own marks (Lobe Icons, MIT; the Mac's SourceLogos), as 24-unit paths. */
const LOGO_PATHS = {
  claudeCode:
    "M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z",
  codex:
    "M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z",
  openCode: "M16 6H8v12h8V6zm4 16H4V2h16v20z",
} as const

/** ReloSourceLogo.init?(sourceName:) and `tint` (ReloSourceMark.swift:12-48). */
export function sourceLogo(name: string | null): { path: string; tint: RGB | null } | null {
  switch (name?.trim().toLowerCase()) {
    case "claude code":
    case "claude":
    case "claude-code":
      return { path: LOGO_PATHS.claudeCode, tint: [0xd9, 0x77, 0x57] }
    case "codex":
    case "openai codex":
    case "codex cli":
      return { path: LOGO_PATHS.codex, tint: null }
    case "opencode":
    case "open code":
      return { path: LOGO_PATHS.openCode, tint: null }
    default:
      return null
  }
}

/** A stable 0...1 from an id (FNV-1a, 64 bit), for each satellite's own pace (Swift `unit`, :371-376). */
const unitCache = new Map<string, number>()
export function unit(id: string): number {
  const cached = unitCache.get(id)
  if (cached !== undefined) return cached
  let hash = 0xcbf29ce484222325n
  for (const byte of new TextEncoder().encode(id)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n)
  const value = Number(hash % 10000n) / 10000
  if (unitCache.size > 500) unitCache.clear()
  unitCache.set(id, value)
  return value
}

/** The closed notch's lower outline as a track the beams run along (Swift `EdgeTrack`, :172-228). */
export class EdgeTrack {
  readonly points: Array<[number, number]>
  readonly lengths: number[]
  readonly length: number
  readonly path: Path2D

  constructor(w: number, h: number, top: number, bottom: number, e = 1.2) {
    const x0 = top + e
    const y1 = h - e
    const pts: Array<[number, number]> = [
      [x0, top],
      [x0, h - bottom],
    ]
    const quad = (p0: [number, number], c: [number, number], p1: [number, number]) => {
      for (let i = 1; i <= 8; i++) {
        const t = i / 8
        const u = 1 - t
        pts.push([u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]])
      }
    }
    quad([x0, h - bottom], [x0, y1], [top + bottom, y1])
    pts.push([w - top - bottom, y1])
    quad([w - top - bottom, y1], [w - x0, y1], [w - x0, h - bottom])
    pts.push([w - x0, top])
    this.points = pts
    let total = 0
    const lengths = [0]
    for (let i = 1; i < pts.length; i++) {
      total += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1])
      lengths.push(total)
    }
    this.lengths = lengths
    this.length = total
    const path = new Path2D()
    path.moveTo(pts[0]![0], pts[0]![1])
    for (const p of pts.slice(1)) path.lineTo(p[0], p[1])
    this.path = path
  }

  point(d: number): [number, number] {
    let i = this.lengths.findIndex((l) => l >= d)
    if (i < 0) return this.points[this.points.length - 1]!
    i = Math.max(1, i)
    const span = this.lengths[i]! - this.lengths[i - 1]!
    const f = span > 0 ? (d - this.lengths[i - 1]!) / span : 0
    const a = this.points[i - 1]!
    const b = this.points[i]!
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]
  }
}

/** `NotchShape(topCornerRadius:bottomCornerRadius:)` as a Path2D (NotchShape.swift:35-107). */
export function notchBody(w: number, h: number, top: number, bottom: number): Path2D {
  const p = new Path2D()
  p.moveTo(0, 0)
  p.quadraticCurveTo(top, 0, top, top)
  p.lineTo(top, h - bottom)
  p.quadraticCurveTo(top, h, top + bottom, h)
  p.lineTo(w - top - bottom, h)
  p.quadraticCurveTo(w - top, h, w - top, h - bottom)
  p.lineTo(w - top, top)
  p.quadraticCurveTo(w - top, 0, w, 0)
  p.lineTo(0, 0)
  return p
}

export interface PaintParams {
  scene: OrbitScene
  moment: OrbitMoment | null
  /** Each wing's content width and the mark's side, as the sizing lays them out. */
  wing: number
  side: number
  /** The closed notch's size in points. */
  width: number
  height: number
  reduceMotion: boolean
  nowMs: number
}

/** What the painter draws onto: the visible canvas, and an offscreen layer for the light the shader modulates. */
export class Surfaces {
  readonly canvas: HTMLCanvasElement
  readonly ctx: CanvasRenderingContext2D
  readonly light: HTMLCanvasElement
  readonly lightCtx: CanvasRenderingContext2D
  readonly pass: WingLightPass | null
  dpr = 1
  private cacheKey = ""
  private cachedEdge: EdgeTrack | null = null
  private cachedBody: Path2D | null = null

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext("2d")!
    this.light = document.createElement("canvas")
    this.lightCtx = this.light.getContext("2d")!
    let pass: WingLightPass | null = null
    try {
      pass = new WingLightPass()
      if (!pass.available) pass = null
    } catch {
      pass = null
    }
    this.pass = pass
  }

  /** Sizes both canvases for `w` x `h` points at `dpr`; true when it changed. */
  resize(w: number, h: number, dpr: number): boolean {
    const pw = Math.max(1, Math.round(w * dpr))
    const ph = Math.max(1, Math.round(h * dpr))
    this.dpr = dpr
    if (this.canvas.width === pw && this.canvas.height === ph) return false
    this.canvas.width = pw
    this.canvas.height = ph
    this.light.width = pw
    this.light.height = ph
    return true
  }

  geometry(w: number, h: number): { edge: EdgeTrack; body: Path2D } {
    const key = `${w}x${h}`
    if (key !== this.cacheKey || !this.cachedEdge || !this.cachedBody) {
      this.cacheKey = key
      this.cachedEdge = new EdgeTrack(w, h, CLOSED_METRICS.cornerTop, CLOSED_METRICS.cornerBottom)
      this.cachedBody = notchBody(w, h, CLOSED_METRICS.cornerTop, CLOSED_METRICS.cornerBottom)
    }
    return { edge: this.cachedEdge, body: this.cachedBody }
  }

  dispose(): void {
    this.pass?.dispose()
  }
}

interface Seg {
  done: boolean
  current: boolean
  fill: number
}

/** Paints one frame. Mirrors `ReloOrbitPainter.paint` (Swift :277-296). */
export function paintOrbit(surfaces: Surfaces, params: PaintParams): void {
  const { ctx, dpr } = surfaces
  // Whatever a frame leaves behind (a clip, a filter) is undone, so the next clear is always whole.
  ctx.save()
  try {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, surfaces.canvas.width, surfaces.canvas.height)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const geo = surfaces.geometry(params.width, params.height)
    new OrbitPainter(surfaces, params, geo.edge, geo.body).paint()
  } catch (error) {
    console.warn("[relo] closed notch paint failed", error)
    // Reassigning the size resets the whole context state (unbalanced saves, clips, filters).
    surfaces.canvas.width = surfaces.canvas.width
  } finally {
    ctx.restore()
  }
}

class OrbitPainter {
  private readonly scene: OrbitScene
  private readonly moment: OrbitMoment | null
  private readonly wing: number
  private readonly side: number
  private readonly W: number
  private readonly H: number
  private readonly reduce: boolean
  private readonly t: number
  /** Seconds into the moment, while it plays. */
  private readonly s: number | null
  private readonly mid: number
  private readonly rightX: number
  private readonly wingL: [number, number, number, number]
  private readonly wingR: [number, number, number, number]
  private readonly orbitR: number
  private readonly cx: number
  private readonly cy: number
  private readonly ctx: CanvasRenderingContext2D
  private readonly surfaces: Surfaces
  private readonly edge: EdgeTrack
  private readonly body: Path2D

  constructor(surfaces: Surfaces, p: PaintParams, edge: EdgeTrack, body: Path2D) {
    this.surfaces = surfaces
    this.edge = edge
    this.body = body
    this.ctx = surfaces.ctx
    this.scene = p.scene
    this.wing = p.wing
    this.side = p.side
    this.W = p.width
    this.H = p.height
    this.reduce = p.reduceMotion
    this.t = referenceSeconds(p.nowMs)
    if (p.moment && isPlaying(p.moment, p.nowMs, p.reduceMotion)) {
      this.moment = p.moment
      this.s = Math.max(0, (p.nowMs - p.moment.at) / 1000)
    } else {
      this.moment = null
      this.s = null
    }
    const inset = CLOSED_METRICS.cornerBottom
    const top = CLOSED_METRICS.cornerTop
    this.mid = p.height / 2
    const leftX = inset + CLOSED_METRICS.outer
    this.rightX = p.width - inset - CLOSED_METRICS.outer - p.wing
    const housingL = inset + CLOSED_METRICS.outer + p.wing + CLOSED_METRICS.gap
    const rw = Math.max(0, housingL - top)
    this.wingL = [top, 0, rw, p.height]
    this.wingR = [p.width - housingL, 0, rw, p.height]
    this.orbitR = p.side * 0.4
    this.cx = leftX + p.side / 2
    this.cy = p.height / 2
  }

  paint(): void {
    const { moment, s, scene } = this
    if (moment && s !== null) {
      switch (moment.kind) {
        case "step":
          this.running(s, moment.bar)
          break
        case "needs":
          this.needs(s)
          break
        case "turn":
          this.turn(s, moment.rowID)
          break
        case "done":
          this.done(s, moment.bar)
          break
        case "failed":
          this.failed(s)
          break
        case "started":
          this.started(s, moment.rowID, moment.bar)
          break
      }
      return
    }
    switch (scene.lead) {
      case "running":
        if ((scene.bar ?? []).length === 0) this.prePlan()
        else this.running(null, scene.bar)
        break
      case "needs":
        this.needs(null)
        break
      case "turn":
        this.turn(9, scene.leadID ?? "")
        break
      case "done":
        this.done(9, scene.bar)
        break
      case "failed":
        this.failed(9)
        break
      case "quiet":
        this.quietState()
        break
      case "rest":
        this.rest()
        break
    }
  }

  // MARK: States

  private running(step: number | null, bar: BarSegment[] | null): void {
    const { t, scene } = this
    const breath = (this.reduce ? 0.3 : 0.32 + 0.16 * Math.sin(t * 1.5)) + (scene.unseen ? 0.25 : 0)
    const flash = step !== null ? Ease.decay(step, 0, 2.6) : 0
    this.glow(RUN, 0.4 + 0.35 * flash, 0.4 + 0.9 * flash)
    // The step that just finished is the last done one.
    let flashIndex: number | null = null
    if (bar) for (let i = bar.length - 1; i >= 0; i--) if (bar[i]!.state === "done") { flashIndex = i; break }
    this.rightWing(bar, RUN, { flashIndex, flash })
    this.orbit({ pulse: Math.max(breath, 0.3 + 0.7 * flash), coreGrow: 0.24 * flash })
    if (step !== null) this.beams(Ease.seg(step, 0, 1.5), RUN)
  }

  /** The mark itself pulses coral and sends rings; its satellites keep circling; beams repeat. */
  private needs(arrival: number | null): void {
    const { t, side } = this
    const p = this.reduce ? 0.8 : 0.6 + 0.4 * Math.sin(t * 3)
    this.rim(NEEDS, 0.3 + 0.35 * p)
    this.glow(NEEDS, 0.35 + 0.2 * p)
    this.chip("Answer", NEEDS, { scale: 1 + 0.04 * p })
    this.orbit({ core: NEEDS, pulse: p, coreGrow: 0.09, leadColor: NEEDS })
    if (!this.reduce) {
      // One ring per beat, eased out and thinning as it spreads.
      const e = (t % 1.8) / 1.8
      this.ring(side * 0.2 + Ease.out(e) * side * 0.72, NEEDS, 0.5 * Math.pow(1 - e, 1.5), 1.1 - 0.5 * e)
    }
    this.beams(Ease.seg(arrival ?? t % 2.8, 0, 1.9), NEEDS)
  }

  /** A start: the core gathers and pulses once, a ring leaves it, the satellite spirals out; the plan draws in. */
  private started(s: number, rowID: string, bar: BarSegment[] | null): void {
    const { ctx, side, scene, t } = this
    const gather = Ease.seg(s, 0, 0.3)
    const burst = Ease.decay(s, 0.3, 3.2)
    this.glow(RUN, 0.25 + 0.15 * gather + 0.55 * burst)
    // The plan draws in from the left, behind a bright head.
    const drawn = Ease.inOut(Ease.seg(s, 0.5, 1.4))
    if (drawn > 0) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(this.rightX - 4, 0, (this.wing + 8) * drawn, this.H)
      ctx.clip()
      this.rightWing(bar ?? scene.bar, RUN, { live: drawn >= 1 })
      ctx.restore()
      if (drawn < 1 && !this.reduce) {
        const ox = this.rightX + this.wing * drawn
        this.radial(ox, this.mid, 0, 6, [[0, css(WHITE, 0.75)], [0.5, css(RUN, 0.35)], [1, css(RUN, 0)]], "lighter")
      }
    }
    // The core draws in a little, then pulses once as the satellite leaves it.
    const coreGrow = -0.12 * Ease.inOut(gather) * (1 - Ease.seg(s, 0.3, 0.45)) + 0.3 * burst * Ease.spring(Ease.seg(s, 0.3, 0.8))
    this.orbit({ core: RUN, pulse: 0.25 + 0.75 * burst, coreGrow, skip: rowID })
    const rip = Ease.seg(s, 0.3, 1.2)
    if (rip > 0 && rip < 1) this.ring(side * 0.2 + Ease.out(rip) * side * 0.9, RUN, 0.5 * Math.pow(1 - rip, 1.4), 1.1 - 0.6 * rip)
    // The new satellite: born at the core, spiralling out to the very point of its orbit where it carries on.
    const sats = scene.satellites
    const index = sats.findIndex((x) => x.id === rowID)
    const target = index >= 0 ? this.angleOf(sats[index]!, index, sats.length, false) : -Math.PI / 2 + t * 1.5
    const out = Ease.out(Ease.seg(s, 0.3, 1.3))
    if (s >= 0.3) {
      const a = target - (1 - out) * 3.4
      const r = 0.15 + 0.85 * out
      if (!this.reduce) {
        for (let k = 1; k <= 10; k++) {
          const back = Ease.out(Ease.clamp(Ease.seg(s, 0.3, 1.3) - k * 0.025))
          this.dot(this.onOrbit(target - (1 - back) * 3.4 - k * 0.05, 0.15 + 0.85 * back), 1.5 - 0.06 * k, RUN, 0.3 * Math.pow(1 - k / 11, 1.5))
        }
      }
      this.dot(this.onOrbit(a, r), 2, RUN)
    }
    this.beams(Ease.seg(s, 0.4, 1.9), RUN)
  }

  /** Its satellite glides to the top and settles; the plan gives way to the chip; amber beams rise. */
  private turn(s: number, rowID: string): void {
    const settle = Ease.out(Ease.seg(s, 0, 1.1))
    const breathe = this.reduce ? 0 : Ease.seg(s, 1.1, 1.6) * Math.sin((s - 1.1) * 2.6)
    const sweep = Ease.seg(s, 0.9, 2.4)
    this.rim(TURN, 0.12 + 0.2 * Math.sin(sweep * Math.PI))
    this.glow(TURN, 0.15 + 0.3 * settle + 0.1 * breathe)
    this.rightWing(this.scene.bar, RUN, { alpha: 1 - Ease.seg(s, 0.2, 0.7) })
    const slide = Ease.outBack(Ease.seg(s, 0.7, 1.3))
    this.chip("Your turn", TURN, { alpha: Ease.seg(s, 0.7, 1.0), dx: -14 * (1 - slide) })
    const corePulse = Ease.decay(s, 1.1, 2.2) * Ease.spring(Ease.seg(s, 1.1, 1.6))
    this.orbit({ core: s < 1.1 ? RUN : TURN, pulse: corePulse + 0.2 * Math.max(0, breathe), skip: rowID })
    const target = -Math.PI / 2
    const start = target - 3.2
    const angle = start + (target - start) * settle
    if (!this.reduce && settle < 1) {
      for (let k = 1; k <= 7; k++) {
        const b = angle - k * 0.14 * (1 - settle)
        this.dot(this.onOrbit(b), 1.5, TURN, 0.3 - k * 0.04)
      }
    }
    const p = this.onOrbit(angle)
    p[1] -= 0.6 * breathe
    this.dot(p, 5.5, TURN, 0.18 * (0.6 + 0.4 * breathe) * settle)
    this.dot(p, 2.3 + 0.35 * breathe, TURN)
    this.beams(sweep, TURN)
  }

  /** The satellite spirals in, the mark pops mint and draws the one check, a ripple spreads, the bar sweeps full. */
  private done(s: number, bar: BarSegment[] | null): void {
    const { side, t } = this
    const inT = Ease.inOut(Ease.seg(s, 0, 1.0))
    const land = Ease.seg(s, 1.0, 1.9)
    const flash = Ease.decay(s, 1.0, 1.8)
    this.glow(s < 1 ? RUN : DONE, s < 1 ? 0.4 : 0.3 + 0.9 * flash)
    this.rightWing(bar ?? [], RUN, { live: s < 0.5, full: Ease.inOut(Ease.seg(s, 0.5, 1.3)), hidesMore: true })
    const landed = s >= 1
    this.orbit({
      core: landed ? DONE : RUN,
      pulse: flash * 0.8,
      coreGrow: landed ? 0.7 * Ease.spring(land) : 0,
      skip: this.moment?.rowID ?? this.scene.leadID,
    })
    if (!landed) {
      const angle = t * 1.5 + inT * 5
      const r = 1 - inT
      for (let k = 1; k <= 6; k++) {
        const b = angle - k * 0.16
        const rk = 1 - Ease.inOut(Ease.clamp(Ease.seg(s, 0, 1.0) - k * 0.02))
        this.dot(this.onOrbit(b, rk), 1.5, DONE, 0.28 - k * 0.04)
      }
      this.dot(this.onOrbit(angle, r), 2.2, DONE)
    } else {
      this.drawCheckOnCore(Ease.out(Ease.seg(s, 1.25, 1.8)))
      const rip = Ease.seg(s, 1.0, 2.0)
      if (rip < 1) this.ring(side * 0.25 + Ease.out(rip) * side * 1.2, DONE, 0.7 * (1 - rip), 1.4 * (1 - rip) + 0.3)
    }
    this.beams(Ease.seg(s, 1.0, 2.5), DONE)
  }

  /** The satellite trembles, drops out of orbit and pools; the plan gives way to a shaking chip; the edge flashes twice. */
  private failed(s: number): void {
    const { ctx, H } = this
    const flash = Math.max(Ease.decay(s, 0.75, 9), 0.8 * Ease.decay(s, 1.05, 9))
    this.rim(FAILED, 0.95 * flash)
    this.glow(s < 0.75 ? RUN : FAILED, s < 0.75 ? 0.4 : 0.25 + 0.7 * Ease.decay(s, 0.75, 1.4))
    this.rightWing(this.scene.bar, RUN, { alpha: 1 - Ease.seg(s, 0.55, 0.8) })
    const e = s - 0.8
    const shake = e > 0 ? Math.sin(e * 42) * 3.2 * Math.exp(-e * 5.5) : 0
    this.chip("Failed", FAILED, { alpha: Ease.seg(s, 0.75, 0.95), dx: shake, scale: 0.9 + 0.1 * Ease.outBack(Ease.seg(s, 0.75, 1.0)) })
    this.orbit({ core: s < 0.75 ? RUN : FAILED, pulse: 0.9 * Ease.decay(s, 0.75, 2.5), skip: this.moment?.rowID ?? this.scene.leadID })
    const p = this.onOrbit(Math.PI * 0.2)
    let alpha = 1
    if (s < 0.7) {
      p[0] += Math.sin(s * 70) * 1.4 * Ease.seg(s, 0.1, 0.7)
    } else {
      const fall = s - 0.7
      p[1] = Math.min(H - 2.5, p[1] + 45 * fall * fall)
      p[0] += fall * 6
      alpha = 1 - Ease.seg(s, 1.1, 1.9)
      if (p[1] >= H - 2.5) {
        const pool = Ease.seg(s, 1.0, 2.2)
        ctx.save()
        ctx.beginPath()
        ctx.rect(...this.wingL)
        ctx.clip()
        ctx.fillStyle = css(FAILED, 0.45 * (1 - pool))
        ctx.beginPath()
        ctx.ellipse(p[0], H - 2.9 + 1.4, (4 + pool * 20) / 2, 1.4, 0, 0, Math.PI * 2)
        ctx.fill()
        ctx.restore()
      }
    }
    if (alpha > 0) this.dot(p, 2.1, FAILED, alpha)
    this.beams(Ease.seg(s, 0.75, 2.2), FAILED)
  }

  private quietState(): void {
    this.rightWing(this.scene.bar, QUIET, { alpha: 0.45, live: false })
    this.orbit({ core: QUIET, pulse: 0, quiet: true })
  }

  /** Nothing live: a pilot light, one small slate dot breathing over seven seconds. */
  private rest(): void {
    const breath = this.reduce ? 0.5 : 0.5 + 0.5 * Math.sin((this.t * 2 * Math.PI) / 7)
    this.radial(this.cx, this.cy, 1, 6, [[0, css(SLATE, 0.22 * breath)], [1, css(SLATE, 0)]], "lighter")
    this.dot([this.cx, this.cy], 2.4, SLATE, 0.45 + 0.3 * breath)
  }

  /** A session works but has no plan yet: the orbit says so, the right wing says who (harness mark, live waveform). */
  private prePlan(): void {
    const { ctx, t, mid } = this
    const breath = this.reduce ? 0.3 : 0.32 + 0.16 * Math.sin(t * 1.5)
    this.glow(RUN, 0.4)
    this.orbit({ pulse: breath })
    const right = this.rightX + this.wing
    let x = right
    const logo = sourceLogo(this.scene.source)
    if (logo) {
      ctx.save()
      ctx.translate(right - 11, mid - 5.5)
      ctx.scale(11 / 24, 11 / 24)
      ctx.fillStyle = logo.tint ? css(logo.tint) : css(WHITE, 0.8)
      ctx.fill(new Path2D(logo.path), "evenodd")
      ctx.restore()
      x -= 17
    }
    for (let k = 0; k < 4; k++) {
      const h = this.reduce ? 5 : 3 + 6 * (0.5 + 0.5 * Math.sin(t * 4.2 + k * 1.3))
      const bx = x - 3 - (3 - k) * 3.6
      ctx.fillStyle = css(RUN)
      ctx.beginPath()
      ctx.roundRect(bx, mid - h / 2, 2, h, 1)
      ctx.fill()
    }
  }

  // MARK: Pieces

  private onOrbit(angle: number, scale = 1): [number, number] {
    return [this.cx + Math.cos(angle) * this.orbitR * scale, this.cy + Math.sin(angle) * this.orbitR * scale]
  }

  private dot(p: readonly [number, number], r: number, color: RGB, alpha = 1): void {
    if (alpha <= 0) return
    const { ctx } = this
    ctx.fillStyle = css(color, alpha)
    ctx.beginPath()
    ctx.arc(p[0], p[1], Math.max(0, r), 0, Math.PI * 2)
    ctx.fill()
  }

  /** A radial gradient disc of radius `end` (SwiftUI radialGradient: stops between startRadius and endRadius). */
  private radial(x: number, y: number, start: number, end: number, stops: Array<[number, string]>, blend: GlobalCompositeOperation = "source-over", target: CanvasRenderingContext2D = this.ctx): void {
    const g = target.createRadialGradient(x, y, start, x, y, end)
    for (const [o, c] of stops) g.addColorStop(o, c)
    target.save()
    target.globalCompositeOperation = blend
    target.fillStyle = g
    target.beginPath()
    target.arc(x, y, end, 0, Math.PI * 2)
    target.fill()
    target.restore()
  }

  /** The mark and the satellites that keep circling; `skip` leaves out the one a moment is about. */
  private orbit(o: { core?: RGB; pulse: number; coreGrow?: number; leadColor?: RGB; skip?: string | null; quiet?: boolean }): void {
    const { ctx, cx, cy, orbitR, side, scene } = this
    const core = o.core ?? RUN
    const pulse = o.pulse
    const coreR = side * 0.165 * (1 + (o.coreGrow ?? 0))
    ctx.strokeStyle = css(WHITE, 0.09)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(cx, cy, orbitR, 0, Math.PI * 2)
    ctx.stroke()
    if (scene.locked) {
      // This Mac is not approved yet: the work is real but private here (SF lock.fill, yellow).
      const k = Math.max(8, side * 0.42)
      ctx.save()
      ctx.translate(cx, cy)
      ctx.fillStyle = css(YELLOW)
      ctx.strokeStyle = css(YELLOW)
      ctx.lineWidth = k * 0.13
      ctx.lineCap = "round"
      ctx.beginPath()
      ctx.roundRect(-k * 0.38, -k * 0.1, k * 0.76, k * 0.56, k * 0.12)
      ctx.fill()
      ctx.beginPath()
      ctx.moveTo(-k * 0.22, -k * 0.1)
      ctx.lineTo(-k * 0.22, -k * 0.22)
      ctx.arc(0, -k * 0.22, k * 0.22, Math.PI, 0)
      ctx.lineTo(k * 0.22, -k * 0.1)
      ctx.stroke()
      ctx.restore()
    } else {
      if (pulse > 0) {
        const hr = coreR + 3 + 4 * pulse
        this.radial(cx, cy, coreR * 0.5, hr, [[0, css(core, 0.55 * pulse)], [1, css(core, 0)]], "lighter")
      }
      const r = coreR * (1 + 0.2 * pulse)
      this.dot([cx, cy], r, core)
    }
    const sats = scene.satellites
    sats.forEach((sat, i) => {
      if (sat.id === o.skip) return
      const dim = !!o.quiet || sat.quiet
      const color = dim ? QUIET : (sat.id === scene.leadID ? o.leadColor : undefined) ?? RUN
      const alpha = dim ? 0.45 : 1
      const base = this.angleOf(sat, i, sats.length, dim)
      if (!this.reduce) {
        // A tail of close, shrinking dots that reads as one soft streak, and a faint halo on the head.
        for (let k = 1; k <= 12; k++) {
          const f = k / 13
          this.dot(this.onOrbit(base - k * 0.055 * (0.6 + 0.4 * sat.pace)), 1.55 - 0.65 * f, color, 0.32 * Math.pow(1 - f, 1.6) * alpha)
        }
        const h = this.onOrbit(base)
        this.radial(h[0], h[1], 1.5, 3.6, [[0, css(color, 0.3 * alpha)], [1, css(color, 0)]], "lighter")
      }
      this.dot(this.onOrbit(base), 2, color, alpha)
    })
  }

  /** Where a satellite is on its orbit now: its own pace (tuned) and its share of the circle (Swift :378-384). */
  private angleOf(sat: Satellite, i: number, count: number, dim: boolean): number {
    // Each satellite keeps its own pace (from its id), so they drift like bodies in orbit, never in step.
    const own = 0.72 + 0.56 * unit(sat.id)
    const speed = dim ? 0.15 * own : 1.5 * sat.pace * own
    return (this.reduce ? 0 : this.t * speed) + (i * 2 * Math.PI) / Math.max(1, count)
  }

  private drawCheckOnCore(draw: number): void {
    if (draw <= 0) return
    const { ctx, cx, cy, side } = this
    const k = side / 20
    const a = [cx - 2.4 * k, cy] as const
    const b = [cx - 0.7 * k, cy + 1.8 * k] as const
    const c = [cx + 2.6 * k, cy - 1.8 * k] as const
    const l1 = Math.hypot(b[0] - a[0], b[1] - a[1])
    const l2 = Math.hypot(c[0] - b[0], c[1] - b[1])
    const d = draw * (l1 + l2)
    ctx.beginPath()
    ctx.moveTo(a[0], a[1])
    if (d <= l1) ctx.lineTo(a[0] + ((b[0] - a[0]) * d) / l1, a[1] + ((b[1] - a[1]) * d) / l1)
    else {
      ctx.lineTo(b[0], b[1])
      const f = (d - l1) / l2
      ctx.lineTo(b[0] + (c[0] - b[0]) * f, b[1] + (c[1] - b[1]) * f)
    }
    ctx.strokeStyle = css(BLACK, 0.8)
    ctx.lineWidth = 1.4 * k
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
    ctx.stroke()
  }

  /** A ring spreading from the mark, inside the left wing only. */
  private ring(radius: number, color: RGB, alpha: number, width = 1.2): void {
    if (alpha <= 0) return
    const { ctx } = this
    ctx.save()
    ctx.beginPath()
    ctx.rect(...this.wingL)
    ctx.clip()
    ctx.strokeStyle = css(color, alpha)
    ctx.lineWidth = width
    ctx.beginPath()
    ctx.arc(this.cx, this.cy, Math.max(0, radius), 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }

  /**
   * The state's light in each wing, lit as a surface: strongest at the notch's outer edge and diffusing toward the
   * camera (a little brighter low), pooled in the outer corner along the notch's curve, with a thin line on the bottom
   * edge. A slow noise flows through it from the outer edges inward (WebGL pass: the light layer only).
   * `left` / `right` are the strengths for each wing (0 leaves it out).
   */
  private glow(color: RGB, left: number, right: number = left): void {
    if (left <= 0.001 && right <= 0.001) return
    const { ctx, surfaces, W, H, body, edge } = this
    const lctx = surfaces.lightCtx
    lctx.setTransform(surfaces.dpr, 0, 0, surfaces.dpr, 0, 0)
    lctx.clearRect(0, 0, W, H)
    const wings: Array<[[number, number, number, number], number, boolean]> = [
      [this.wingL, left, true],
      [this.wingR, right, false],
    ]
    for (const [rect, strength, isLeft] of wings) {
      if (strength <= 0.001) continue
      const [rx, ry, rw, rh] = rect
      const inner = isLeft ? rx + rw : rx
      const outerEdge = isLeft ? rx : rx + rw
      // The lit layer, into the offscreen canvas.
      lctx.save()
      lctx.clip(body)
      lctx.beginPath()
      lctx.rect(rx, ry, rw, rh)
      lctx.clip()
      lctx.globalCompositeOperation = "source-over"
      const lin = lctx.createLinearGradient(outerEdge, 0, inner, 0)
      lin.addColorStop(0, css(color, 0.62 * strength))
      lin.addColorStop(0.3, css(color, 0.3 * strength))
      lin.addColorStop(0.65, css(color, 0.08 * strength))
      lin.addColorStop(1, css(color, 0))
      lctx.fillStyle = lin
      lctx.fillRect(rx, ry, rw, rh)
      // destinationIn: the light fades toward the top (black to black .55, from the bottom up).
      lctx.globalCompositeOperation = "destination-in"
      const vert = lctx.createLinearGradient(0, H, 0, 0)
      vert.addColorStop(0, "rgba(0,0,0,1)")
      vert.addColorStop(1, "rgba(0,0,0,0.55)")
      lctx.fillStyle = vert
      lctx.fillRect(rx, ry, rw, rh)
      lctx.globalCompositeOperation = "lighter"
      const rad = lctx.createRadialGradient(outerEdge + (isLeft ? 4 : -4), H - 2, 0, outerEdge + (isLeft ? 4 : -4), H - 2, rw * 0.55)
      rad.addColorStop(0, css(color, 0.45 * strength))
      rad.addColorStop(0.5, css(color, 0.12 * strength))
      rad.addColorStop(1, css(color, 0))
      lctx.fillStyle = rad
      lctx.fillRect(rx, ry, rw, rh)
      lctx.restore()
      // The thin line on the bottom edge (not shaded).
      ctx.save()
      ctx.clip(body)
      ctx.beginPath()
      ctx.rect(rx, ry, rw, rh)
      ctx.clip()
      ctx.globalCompositeOperation = "lighter"
      ctx.globalAlpha = Math.min(1, 1.3 * strength)
      const fade = ctx.createLinearGradient(outerEdge, 0, inner, 0)
      fade.addColorStop(0, css(color, 1))
      fade.addColorStop(0.35, css(color, 0.6))
      fade.addColorStop(0.85, css(color, 0))
      ctx.strokeStyle = fade
      ctx.lineWidth = 1
      ctx.stroke(edge.path)
      ctx.restore()
    }
    // Shade the layer (reduce motion keeps it still), then composite with plus-lighter.
    const shaded = this.reduce ? null : surfaces.pass?.shade(surfaces.light, { w: W, h: H }, this.t % 1000)
    ctx.save()
    ctx.globalCompositeOperation = "lighter"
    ctx.drawImage(shaded ?? surfaces.light, 0, 0, W, H)
    ctx.restore()
  }

  /** Light along the notch's own edge, inside the black. */
  private rim(color: RGB, alpha: number): void {
    if (alpha <= 0.01) return
    const { ctx, edge } = this
    ctx.save()
    ctx.filter = "blur(3px)"
    ctx.strokeStyle = css(color, alpha * 0.85)
    ctx.lineWidth = 2
    ctx.stroke(edge.path)
    ctx.restore()
  }

  /** Two lights leave the bottom centre together, run outward and climb both sides; p is 0...1. */
  private beams(p: number, color: RGB): void {
    if (this.reduce || p <= 0 || p >= 1) return
    const { ctx, edge, W, H } = this
    const half = edge.length / 2
    const d = Ease.inOut(p) * half
    const alpha = Math.sin(p * Math.PI)
    ctx.save()
    ctx.globalCompositeOperation = "lighter"
    for (const dir of [1, -1]) {
      const head = half + dir * d
      // Dots close enough to read as one tapered line, and a small bloom at the head.
      for (let k = 0; k < 48; k++) {
        const at = head - dir * k * 0.7
        if (at < 0 || at > edge.length) continue
        const f = k / 48
        const pt = edge.point(at)
        const r = 1.45 - 0.95 * f
        ctx.fillStyle = css(color, Math.pow(1 - f, 1.4) * 0.9 * alpha)
        ctx.beginPath()
        ctx.arc(pt[0], pt[1], r, 0, Math.PI * 2)
        ctx.fill()
      }
      if (head >= 0 && head <= edge.length) {
        const o = edge.point(head)
        this.radial(o[0], o[1], 0, 4.5, [[0, css(WHITE, 0.55 * alpha)], [0.5, css(color, 0.25 * alpha)], [1, css(color, 0)]], "lighter")
      }
    }
    if (p < 0.25) {
      // a flat flare where they leave, along the edge
      const f = 1 - p / 0.25
      const ox = W / 2
      const oy = H - 1
      const g = ctx.createRadialGradient(ox, oy, 0, ox, oy, 20)
      g.addColorStop(0, css(WHITE, 0.5 * f))
      g.addColorStop(0.5, css(color, 0.4 * f))
      g.addColorStop(1, css(color, 0))
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.ellipse(ox, oy, 20, 3.5, 0, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }

  private chip(text: string, color: RGB, o: { alpha?: number; dx?: number; scale?: number } = {}): void {
    const alpha = o.alpha ?? 1
    if (alpha <= 0) return
    const { ctx } = this
    ctx.save()
    ctx.font = `700 10px ${FONT}`
    const w = ctx.measureText(text).width + 12
    const h = 15
    const cx = this.rightX + this.wing - w / 2 + (o.dx ?? 0)
    ctx.translate(cx, this.mid)
    const sc = o.scale ?? 1
    ctx.scale(sc, sc)
    ctx.beginPath()
    ctx.roundRect(-w / 2, -h / 2, w, h, h / 2)
    ctx.fillStyle = css(color, 0.17 * alpha)
    ctx.fill()
    ctx.strokeStyle = css(color, 0.32 * alpha)
    ctx.lineWidth = 0.75
    ctx.stroke()
    ctx.fillStyle = css(color, alpha)
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillText(text, 0, 0.5)
    ctx.restore()
  }

  /** The lead's plan with +N for the rest; `hidesMore` leaves out +N (a finish is about the one card). */
  private rightWing(
    bar: BarSegment[] | null,
    color: RGB,
    o: { alpha?: number; live?: boolean; flashIndex?: number | null; flash?: number; full?: number; hidesMore?: boolean } = {},
  ): void {
    const alpha = o.alpha ?? 1
    if (alpha <= 0.01) return
    const { ctx, scene } = this
    const showMore = scene.more > 0 && !o.hidesMore
    const width = showMore ? this.wing - 16 : this.wing
    ctx.save()
    ctx.globalAlpha = alpha
    this.planBar(this.rightX, this.mid - 1.5, width, bar ?? [], color, o.live ?? true, o.flashIndex ?? null, o.flash ?? 0, o.full ?? 0)
    if (showMore) {
      ctx.font = `600 8.5px ${FONT}`
      ctx.fillStyle = css(WHITE, 0.5)
      ctx.textAlign = "right"
      ctx.textBaseline = "middle"
      ctx.fillText(`+${scene.more}`, this.rightX + this.wing, this.mid + 0.5)
    }
    ctx.restore()
  }

  // MARK: The plan bar (ReloBarPainter.planBar, Swift :638-728)

  private planBar(x: number, y: number, w: number, input: BarSegment[], color: RGB, live: boolean, flashIndex: number | null, flash: number, full: number): void {
    const { ctx, t } = this
    const h = 3
    const track = css(WHITE, 0.13)
    // A long plan reads as one continuous bar; a finish with no plan sweeps a single one.
    const long = input.length > CLOSED_METRICS.maxSegments
    let segments: Seg[] = long
      ? [
          {
            done: input.every((s) => s.state === "done"),
            current: input.some((s) => s.state === "current"),
            fill: input.reduce((a, s) => a + (s.state === "done" ? 1 : s.fill), 0) / input.length,
          },
        ]
      : input.map((s) => ({ done: s.state === "done", current: s.state === "current", fill: s.fill }))
    if (segments.length === 0 && full > 0) segments = [{ done: false, current: false, fill: 0 }]
    if (segments.length === 0) {
      ctx.fillStyle = track
      ctx.beginPath()
      ctx.roundRect(x, y, w, h, h / 2)
      ctx.fill()
      if (live && !this.reduce) {
        const lx = x + ((t * 0.5) % 1.3) * w
        this.lightWindow(x, y, w, h, lx, 12, 0.45, color)
      }
      return
    }
    const gap = long ? 0 : 3
    const segW = (w - gap * (segments.length - 1)) / segments.length
    segments.forEach((segment, i) => {
      const sx = x + i * (segW + gap)
      ctx.fillStyle = track
      ctx.beginPath()
      ctx.roundRect(sx, y, segW, h, h / 2)
      ctx.fill()
      const f = segment.done ? 1 : segment.fill
      if (f <= 0) return
      const fw = Math.max(h, segW * f)
      const current = segment.current
      const flashing = i === flashIndex && flash > 0
      const fillPath = () => {
        ctx.beginPath()
        ctx.roundRect(sx, y, fw, h, h / 2)
      }
      if (flashing) {
        ctx.save()
        ctx.shadowColor = css(color, flash)
        ctx.shadowBlur = 4.5 * this.surfaces.dpr * 1.5 // SwiftUI .shadow(radius: 4.5): shadowBlur is in device pixels
        ctx.fillStyle = css(color)
        fillPath()
        ctx.fill()
        ctx.restore()
        ctx.fillStyle = css(WHITE, 0.75 * flash)
        fillPath()
        ctx.fill()
      } else if (current && live && f < 1) {
        const g = ctx.createLinearGradient(sx, y, sx + fw, y)
        g.addColorStop(0, css(color, 0.4))
        g.addColorStop(1, css(color))
        ctx.fillStyle = g
        fillPath()
        ctx.fill()
      } else {
        ctx.fillStyle = css(color)
        fillPath()
        ctx.fill()
      }
      if (!(current && live && f < 1)) return
      const head = sx + fw
      if (!this.reduce) {
        // One soft pass across the filled part, then a rest (the iPhone's LiveSweep rhythm).
        const local = (t % 2.8) / 1.9
        if (local < 1) this.lightWindow(sx, y, fw, h, sx - 10 + Ease.inOut(local) * (fw + 20), 11, 0.42, WHITE)
      }
      const b = this.reduce ? 0.6 : 0.55 + 0.14 * Math.sin(t * 1.8)
      this.radial(head, y + h / 2, 0, 5, [[0, css(WHITE, b)], [0.4, css(color, 0.5 * b)], [1, css(color, 0)]], "lighter")
    })
    if (full > 0) {
      // a mint sweep to full, over the bar
      ctx.save()
      ctx.beginPath()
      ctx.rect(x, y - 1, w * full, h + 2)
      ctx.clip()
      ctx.fillStyle = css(DONE)
      segments.forEach((_, i) => {
        ctx.beginPath()
        ctx.roundRect(x + i * (segW + gap), y, segW, h, h / 2)
        ctx.fill()
      })
      ctx.restore()
      if (full < 1) this.radial(x + w * full, y + h / 2, 0, 6, [[0, css(WHITE, 0.8)], [1, css(DONE, 0)]], "lighter")
    }
  }

  private lightWindow(cx: number, cy: number, cw: number, ch: number, lx: number, half: number, alpha: number, tint: RGB): void {
    const { ctx } = this
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(cx, cy, cw, ch, ch / 2)
    ctx.clip()
    ctx.globalCompositeOperation = "lighter"
    // soft: tint 0, white .35a at .3, white a at .5, white .35a at .7, tint 0
    const g = ctx.createLinearGradient(lx - half, 0, lx + half, 0)
    g.addColorStop(0, css(tint, 0))
    g.addColorStop(0.3, css(WHITE, alpha * 0.35))
    g.addColorStop(0.5, css(WHITE, alpha))
    g.addColorStop(0.7, css(WHITE, alpha * 0.35))
    g.addColorStop(1, css(tint, 0))
    ctx.fillStyle = g
    ctx.fillRect(lx - half, cy, 2 * half, ch)
    ctx.restore()
  }
}
