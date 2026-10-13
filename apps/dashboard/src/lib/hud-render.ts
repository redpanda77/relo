/**
 * The Now header's canvas: a port of the iPhone app's ReloSignalOrb / ReloParticleField
 * (apps/ios/Sources/ReloApp/ReloAtmosphere.swift) plus the instrument ring around it.
 */

import { mixTotal, rgbOf, signalAt, SIGNAL_RAMP, type NowMix, type RGB, type Signal } from "@/lib/signal"

export type { RGB }
export type HudState = "clear" | "running" | "needsYou"

export type HudArc = {
  /** 0...1; null means the task has no measurable progress and breathes instead. */
  progress: number | null
}

const hex = rgbOf

export const INK = "#05060B"

const MINT = hex(0x34d399)
const EMERALD = hex(0x10b981)
const TEAL = hex(0x2dd4bf)
const CYAN = hex(0x5ce1ff)
const BLUE = hex(0x4d8dff)
const VIOLET = hex(0x8b7cff)
const MAGENTA = hex(0xd65cf0)
const CORAL = hex(0xff6b57)
const AMBER = hex(0xfbbf24)
const ORANGE = hex(0xff8a3d)
const SKY = hex(0x7dd3fc)
const AZURE = hex(0x38bdf8)

export const HUD_COLORS = { MINT, EMERALD, TEAL, CYAN, BLUE, VIOLET, MAGENTA, CORAL, AMBER, ORANGE }

/** Three particle stops sampled across the sphere. */
const PALETTE: Record<HudState, RGB[]> = {
  clear: [EMERALD, MINT, CYAN],
  running: [CYAN, BLUE, VIOLET],
  needsYou: [ORANGE, CORAL, AMBER],
}

/** Seamless loops for the ring's gradient. */
const LOOP: Record<HudState, RGB[]> = {
  clear: [MINT, TEAL, CYAN, EMERALD, MINT],
  running: [CYAN, BLUE, VIOLET, BLUE, CYAN],
  needsYou: [ORANGE, CORAL, AMBER, CORAL, ORANGE],
}

/** The state's three palette colors, for the plasma core when today has no mix. */
export const statePalette = (state: HudState): RGB[] => PALETTE[state]

export const ACCENT: Record<HudState, RGB> = { clear: MINT, running: CYAN, needsYou: ORANGE }
export const ENERGY: Record<HudState, number> = { clear: 0.35, running: 0.7, needsYou: 1 }

/** Each running task's arc stays in the running family (cyan to blue), a different shade each. */
const TASK_RAMPS: RGB[][] = [
  [CYAN, BLUE, CYAN],
  [SKY, AZURE, BLUE],
  [BLUE, CYAN, SKY],
  [AZURE, SKY, CYAN],
]

export const css = (color: RGB, alpha = 1) =>
  `rgba(${Math.round(color[0])},${Math.round(color[1])},${Math.round(color[2])},${alpha})`

export const hexOf = (color: RGB) =>
  "#" + color.map((part) => Math.round(part).toString(16).padStart(2, "0")).join("")

const mixColors = (a: RGB, b: RGB, amount: number): RGB => [
  a[0] + (b[0] - a[0]) * amount,
  a[1] + (b[1] - a[1]) * amount,
  a[2] + (b[2] - a[2]) * amount,
]

function sample(palette: RGB[], position: number): RGB {
  const scaled = Math.min(Math.max(position, 0), 1) * (palette.length - 1)
  const index = Math.min(Math.floor(scaled), palette.length - 2)
  return mixColors(palette[index]!, palette[index + 1]!, scaled - index)
}

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1)
  return t * t * (3 - 2 * t)
}

const TAU = Math.PI * 2

// MARK: deterministic particle field

const MASK = (1n << 64n) - 1n

function generator(seed: bigint) {
  let state = seed
  return () => {
    state = (state * 6364136223846793005n + 1442695040888963407n) & MASK
    return Number(state >> 11n) / 2 ** 53
  }
}

type Particle = { x: number; y: number; z: number; size: number; phase: number; hue: number }

const SPHERE: Particle[] = (() => {
  const count = 620
  const golden = Math.PI * (3 - Math.sqrt(5))
  const next = generator(0x52454c4fn)
  return Array.from({ length: count }, (_, index) => {
    const y = 1 - ((index + 0.5) / count) * 2
    const radius = Math.sqrt(1 - y * y)
    const theta = golden * index
    const jitter = 1 + (next() - 0.5) * 0.08
    const x = Math.cos(theta) * radius * jitter
    const z = Math.sin(theta) * radius * jitter
    const hue = Math.min(Math.max((x * 0.6 - y * 0.8 + 1) / 2 + (next() - 0.5) * 0.12, 0), 1)
    const size = 0.55 + Math.pow(next(), 3) * 1.4
    const phase = next() * TAU
    return { x, y: y * jitter, z, size, phase, hue }
  })
})()

const RING: Particle[] = (() => {
  const next = generator(0x52494e47n)
  return Array.from({ length: 170 }, (_, index) => {
    const angle = (index / 170) * TAU + (next() - 0.5) * 0.05
    const radius = 1.3 + (next() - 0.5) * 0.14
    const y = (next() - 0.5) * 0.05
    const size = 0.4 + Math.pow(next(), 2) * 0.8
    const phase = next() * TAU
    return { x: Math.cos(angle) * radius, y, z: Math.sin(angle) * radius, size, phase, hue: index / 170 }
  })
})()

/** A ripple through the particles (ReloOrbWave). Coordinates are in the deck's CSS pixel space; `at` is ms. */
export type Wave = { x: number; y: number; at: number; strength: number }

export const WAVE_LIFETIME_MS = 2600

/** How far a point is shoved away from the wave's origin right now, and how bright it gets. */
export function wavePush(wave: Wave, px: number, py: number, now: number): { dx: number; dy: number; lift: number } {
  const age = (now - wave.at) / 1000
  if (age < 0 || age >= 2.6) return { dx: 0, dy: 0, lift: 0 }
  const dx = px - wave.x
  const dy = py - wave.y
  const distance = Math.max(Math.hypot(dx, dy), 0.001)
  const front = age * 240
  const band = Math.exp(-(((distance - front) / 28) ** 2)) * wave.strength * Math.exp(-age * 1.3)
  const shove = band * 15
  return { dx: (dx / distance) * shove, dy: (dy / distance) * shove, lift: band }
}

export const particleCounts = { sphere: SPHERE.length, ring: RING.length }

export type HudFrame = {
  /** CSS pixels. */
  size: number
  /** Milliseconds on the performance clock. */
  now: number
  /** Seconds of animation; fixed when motion is reduced. */
  time: number
  arcs: HudArc[]
  /** Animated extras (relay rings, flashes) are skipped when motion is reduced. */
  still: boolean
  /** Today's work by meaning; each particle takes the color of its share. Empty: the state palette. */
  mix?: NowMix
  /** Active ripples in deck space, and this canvas's top-left in that space. */
  waves?: Wave[]
  offset?: { x: number; y: number }
}

/** Holds the little bit of state the animation needs between frames. */
export class HudRenderer {
  state: HudState = "clear"
  private previous: HudState | null = null
  private changedAt = -Infinity
  private emittedAt: number | null = null
  private flashAt = -Infinity
  private flashColor: RGB = MINT

  setState(state: HudState, now: number) {
    if (state === this.state) return
    this.previous = this.state
    this.state = state
    this.changedAt = now
  }

  /** One bright relay ring outward. */
  emit(now: number) {
    this.emittedAt = now
  }

  flash(color: RGB, now: number) {
    this.flashAt = now
    this.flashColor = color
  }

  private palette(now: number): RGB[] {
    const progress = Math.min((now - this.changedAt) / 900, 1)
    if (!this.previous || progress >= 1) return PALETTE[this.state]
    const eased = progress * progress * (3 - 2 * progress)
    return PALETTE[this.state].map((color, index) => mixColors(PALETTE[this.previous!][index]!, color, eased))
  }

  draw(ctx: CanvasRenderingContext2D, frame: HudFrame) {
    const { size, time, now, still } = frame
    const mix = frame.mix && mixTotal(frame.mix) > 0 ? frame.mix : null
    const waves = (frame.waves ?? []).filter((wave) => now - wave.at < WAVE_LIFETIME_MS)
    const offset = frame.offset ?? { x: 0, y: 0 }
    const ripple = (x: number, y: number): [number, number, number] => {
      if (!waves.length) return [x, y, 0]
      let mx = x
      let my = y
      let lift = 0
      for (const wave of waves) {
        const push = wavePush(wave, x + offset.x, y + offset.y, now)
        mx += push.dx
        my += push.dy
        lift += push.lift
      }
      return [mx, my, Math.min(lift, 1)]
    }
    /** A particle's color: its meaning's ramp when a mix is known, else the state palette. */
    const tint = (particle: Particle): RGB => {
      const signal = mix ? signalAt(mix, particle.phase / TAU) : null
      if (!signal) return sample(palette, particle.hue)
      const { light, deep } = SIGNAL_RAMP[signal]
      return mixColors(light, deep, particle.hue)
    }
    const cx = size / 2
    const cy = size / 2
    ctx.clearRect(0, 0, size, size)

    const extent = (size / 2) * (262 / 276)
    const radius = extent * 0.6
    const palette = this.palette(now)
    const energy = ENERGY[this.state]
    const mid = sample(palette, 0.5)

    // Ambient body light.
    const body = ctx.createRadialGradient(cx, cy, radius * 0.2, cx, cy, radius * 1.5)
    body.addColorStop(0, css(mid, 0.3 + 0.16 * energy))
    body.addColorStop(0.55, css(mid, 0.1 + 0.06 * energy))
    body.addColorStop(1, css(mid, 0))
    ctx.fillStyle = body
    ctx.beginPath()
    ctx.arc(cx, cy, radius * 1.5, 0, TAU)
    ctx.fill()

    // Dark lens so the count reads over the front particles.
    const lensGradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 0.95)
    lensGradient.addColorStop(0, "rgba(5,6,11,0.85)")
    lensGradient.addColorStop(1, "rgba(5,6,11,0)")
    ctx.fillStyle = lensGradient
    ctx.beginPath()
    ctx.arc(cx, cy, radius, 0, TAU)
    ctx.fill()

    ctx.save()
    ctx.globalCompositeOperation = "lighter"
    const spin = time * (0.16 + 0.14 * energy)
    const tilt = 0.38 + Math.sin(time * 0.11) * 0.06
    const sinSpin = Math.sin(spin)
    const cosSpin = Math.cos(spin)
    const sinTilt = Math.sin(tilt)
    const cosTilt = Math.cos(tilt)
    const scale = radius / 96

    const project = (x: number, y: number, z: number): [number, number, number] => {
      const perspective = 3.4 / (3.4 - z)
      return [cx + x * radius * perspective, cy + y * radius * perspective, (z + 1) / 2]
    }
    const dot = (x: number, y: number, r: number, color: string) => {
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(x, y, Math.max(r, 0.1), 0, TAU)
      ctx.fill()
    }

    for (const particle of SPHERE) {
      const breathe = 1 + 0.035 * Math.sin(time * (0.9 + energy) + particle.phase * 3)
      const px = particle.x * breathe
      const py = particle.y * breathe
      const pz = particle.z * breathe
      const rx = px * cosSpin + pz * sinSpin
      const rz0 = -px * sinSpin + pz * cosSpin
      const ry = py * cosTilt - rz0 * sinTilt
      const rz = py * sinTilt + rz0 * cosTilt
      const [px0, py0, depth] = project(rx, ry, rz)
      const [x, y, lift] = ripple(px0, py0)
      const distance = Math.hypot(px0 - cx, py0 - cy) / radius
      const lens =
        (rz > 0 ? 0.22 + 0.78 * smoothstep(0.3, 0.82, distance) : 1) * smoothstep(0.18, 0.52, distance)
      const twinkle = 0.72 + 0.28 * Math.sin(time * (1.6 + particle.phase) + particle.phase * 7)
      const alpha = Math.min(1, (0.1 + 0.9 * Math.pow(depth, 1.5)) * lens * twinkle * (1 + 1.4 * lift))
      if (alpha < 0.004) continue
      const r = particle.size * (0.5 + 0.8 * depth) * scale * (1 + 0.6 * lift)
      const color = tint(particle)
      if (particle.size > 1.25 && depth > 0.55) {
        const glow = r * 3.2
        const g = ctx.createRadialGradient(x, y, 0, x, y, glow)
        g.addColorStop(0, css(color, alpha * 0.35))
        g.addColorStop(1, css(color, 0))
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(x, y, glow, 0, TAU)
        ctx.fill()
      }
      dot(x, y, r, css(color, alpha))
    }

    // Orbital ring: slower, opposite drift, tilted steeply across the sphere.
    const orbit = -time * (0.1 + 0.08 * energy)
    const sinOrbit = Math.sin(orbit)
    const cosOrbit = Math.cos(orbit)
    const ringTilt = 1.18
    const roll = -0.32
    for (const particle of RING) {
      const ox = particle.x * cosOrbit - particle.z * sinOrbit
      const oz = particle.x * sinOrbit + particle.z * cosOrbit
      const ty = particle.y * Math.cos(ringTilt) - oz * Math.sin(ringTilt)
      const tz = particle.y * Math.sin(ringTilt) + oz * Math.cos(ringTilt)
      const rx = ox * Math.cos(roll) - ty * Math.sin(roll)
      const ry = ox * Math.sin(roll) + ty * Math.cos(roll)
      const [rpx, rpy, depth] = project(rx, ry, tz)
      const [x, y, lift] = ripple(rpx, rpy)
      const alpha = Math.min(1, (0.08 + 0.62 * depth) * (0.6 + 0.4 * Math.sin(time * 2 + particle.phase)) * (1 + lift))
      dot(x, y, particle.size * (0.5 + 0.6 * depth) * scale, css(tint(particle), alpha))
    }

    // Relay rings: a faint ambient one every few seconds, a bright one on new activity.
    const relay = (progress: number, strength: number) => {
      if (progress <= 0 || progress >= 1) return
      const ringRadius = radius * (1.02 + progress * 0.58)
      const fade = Math.pow(1 - progress, 1.6) * strength
      const count = 96
      for (let index = 0; index < count; index++) {
        const angle = (index / count) * TAU + progress * 0.6
        const wobble = 1 + 0.02 * Math.sin(angle * 5 + time * 3)
        dot(
          cx + Math.cos(angle) * ringRadius * wobble,
          cy + Math.sin(angle) * ringRadius * wobble,
          (1.4 - progress * 0.6) * scale,
          css(sample(palette, index / count), fade)
        )
      }
    }
    if (!still) {
      relay((time / 5.5) % 1, 0.28 * energy)
      if (this.emittedAt != null) {
        const progress = (now - this.emittedAt) / 1900
        if (progress >= 1) this.emittedAt = null
        else relay(progress, 0.95)
      }
    }
    ctx.restore()
  }

  /** The tick ring, hairline circle and one luminous arc per running task, on its own square canvas. */
  drawRing(ctx: CanvasRenderingContext2D, frame: HudFrame) {
    const { size, time, now, still, arcs } = frame
    const cx = size / 2
    const cy = size / 2
    ctx.clearRect(0, 0, size, size)
    const outer = size / 2 - 2
    const loop = LOOP[this.state]
    const flash = still ? 0 : Math.max(0, 1 - (now - this.flashAt) / 900)

    // 120 fine ticks, slowly turning, with a light sweep; a flash lights them in the flash colour.
    const rotation = time * 0.05
    const sweep = (time * 0.35) % TAU
    for (let index = 0; index < 120; index++) {
      const angle = rotation + (index / 120) * TAU
      const major = index % 10 === 0
      const length = major ? 9 : 5
      let distance = Math.abs((((angle - sweep) % TAU) + TAU) % TAU)
      if (distance > Math.PI) distance = TAU - distance
      const lit = Math.max(0, 1 - distance / 0.7)
      const alpha = Math.min(1, (major ? 0.34 : 0.17) + lit * 0.6 + flash * 0.7)
      const color = flash > 0 ? mixColors(sample(loop, index / 120), this.flashColor, Math.min(1, flash * 1.2)) : sample(loop, index / 120)
      ctx.strokeStyle = css(color, alpha)
      ctx.lineWidth = major ? 1.2 : 0.8
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(angle) * (outer - length), cy + Math.sin(angle) * (outer - length))
      ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer)
      ctx.stroke()
    }

    // Hairline circle, looped through the state's colours.
    const circle = outer - 16
    let stroke: CanvasGradient
    if (typeof ctx.createConicGradient === "function") {
      stroke = ctx.createConicGradient(-Math.PI / 2 + time * 0.08, cx, cy)
    } else {
      stroke = ctx.createLinearGradient(cx - circle, cy - circle, cx + circle, cy + circle)
    }
    loop.forEach((color, index) => stroke.addColorStop(index / (loop.length - 1), css(color, 0.55)))
    ctx.strokeStyle = stroke
    ctx.lineWidth = 0.75
    ctx.beginPath()
    ctx.arc(cx, cy, circle, 0, TAU)
    ctx.stroke()

    // One luminous arc per running task, each with its own ramp.
    const sphere = (size / 2) * (262 / 276) * 0.6
    arcs.slice(0, 5).forEach((arc, index) => {
      const r = circle - 9 - index * 7
      if (r < sphere * 1.05) return
      const ramp = TASK_RAMPS[index % TASK_RAMPS.length]!
      const start = -Math.PI / 2
      const fraction =
        arc.progress == null
          ? 0.3 + 0.12 * Math.sin(time * 0.9 + index)
          : Math.min(1, Math.max(0.02, arc.progress))
      const end = start + fraction * TAU
      ctx.lineCap = "round"
      ctx.lineWidth = 1
      ctx.strokeStyle = "rgba(255,255,255,0.07)"
      ctx.beginPath()
      ctx.arc(cx, cy, r, 0, TAU)
      ctx.stroke()

      const gradient = ctx.createLinearGradient(cx - r, cy, cx + r, cy)
      gradient.addColorStop(0, css(ramp[0]!))
      gradient.addColorStop(0.55, css(ramp[1]!))
      gradient.addColorStop(1, css(ramp[2]!))
      const headColor = ramp[2]!

      ctx.save()
      ctx.globalCompositeOperation = "lighter"
      ctx.strokeStyle = gradient
      ctx.shadowColor = css(headColor, 0.95)
      ctx.shadowBlur = 14
      ctx.lineWidth = 4
      ctx.globalAlpha = 0.55
      ctx.beginPath()
      ctx.arc(cx, cy, r, start, end)
      ctx.stroke()
      ctx.restore()

      ctx.strokeStyle = gradient
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(cx, cy, r, start, end)
      ctx.stroke()

      ctx.save()
      ctx.fillStyle = "#ffffff"
      ctx.shadowColor = css(headColor)
      ctx.shadowBlur = 12
      ctx.beginPath()
      ctx.arc(cx + Math.cos(end) * r, cy + Math.sin(end) * r, 2.6, 0, TAU)
      ctx.fill()
      ctx.restore()
    })
  }
}

/** The ramp of the nth running task, for legends and tests. */
export const taskRamp = (index: number) => TASK_RAMPS[index % TASK_RAMPS.length]!

// MARK: deck dust (ReloDeckField)

type Mote = { x: number; y: number; speed: number; size: number; phase: number; slot: number }

/** 150 motes in two parallax depths, deterministic. */
export const MOTES: Mote[] = (() => {
  const next = generator(0x44454bn)
  return Array.from({ length: 150 }, () => {
    const far = next() < 0.6
    return {
      x: next(),
      y: next(),
      speed: far ? 0.004 + next() * 0.004 : 0.01 + next() * 0.008,
      size: far ? 0.5 + next() * 0.5 : 0.9 + next() * 0.9,
      phase: next() * TAU,
      slot: next(),
    }
  })
})()

/** Faint dust across the whole deck, drifting upward, tinted by today's meanings, stirred by waves. */
export function drawDust(
  ctx: CanvasRenderingContext2D,
  frame: { width: number; height: number; time: number; now: number; state: HudState; mix?: NowMix; waves?: Wave[] }
) {
  const { width, height, time, now, state } = frame
  const mix = frame.mix && mixTotal(frame.mix) > 0 ? frame.mix : null
  const waves = (frame.waves ?? []).filter((wave) => now - wave.at < WAVE_LIFETIME_MS)
  ctx.clearRect(0, 0, width, height)
  for (const mote of MOTES) {
    const y = (((mote.y - time * mote.speed) % 1) + 1) % 1
    let px = mote.x * width + Math.sin(time * 0.3 + mote.phase) * 6
    let py = y * height
    let lift = 0
    for (const wave of waves) {
      const push = wavePush(wave, px, py, now)
      px += push.dx * 0.8
      py += push.dy * 0.8
      lift += push.lift
    }
    lift = Math.min(lift, 1)
    // Fade near the deck's top and bottom so the field has no hard edge.
    const edge = Math.max(0, Math.min(y / 0.18, (1 - y) / 0.25, 1))
    const twinkle = 0.55 + 0.45 * Math.sin(time * 1.3 + mote.phase * 5)
    const signal = mix ? signalAt(mix, mote.slot) : null
    const color = signal ? SIGNAL_RAMP[signal].light : ACCENT[state]
    const alpha = edge * twinkle * (mote.size > 1 ? 0.42 : 0.26) * (1 + 1.5 * lift)
    const r = mote.size * (1 + 0.5 * lift)
    ctx.fillStyle = css(color, Math.min(alpha, 1))
    ctx.beginPath()
    ctx.arc(px, py, r, 0, TAU)
    ctx.fill()
  }
}

// MARK: orbital plane (ReloOrbitPlane)

type Grain = { angle: number; lane: number; speed: number; size: number; phase: number; slot: number }

/** 420 grains on the plane, deterministic. */
export const GRAINS: Grain[] = (() => {
  const next = generator(0x4f524254n)
  return Array.from({ length: 420 }, () => {
    const angle = next() * TAU
    const lane = Math.pow(next(), 1.6) * (next() < 0.5 ? -1 : 1)
    return { angle, lane, speed: 0.05 + next() * 0.07, size: 0.5 + Math.pow(next(), 3) * 1.6, phase: next() * TAU, slot: next() }
  })
})()

export type PlaneFrame = {
  half: "far" | "near"
  /** CSS pixels: the plane spans the whole deck. */
  width: number
  height: number
  time: number
  now: number
  state: HudState
  mix?: NowMix
  /** One entry per running task (progress or null). */
  arcs: HudArc[]
  waves?: Wave[]
  /** The orb's center in deck space. */
  center: { x: number; y: number }
}

const PLANE_TILT = -0.11

/** Where an angle on the plane lands, and its depth (sin > 0 is the near side). */
export function planePoint(angle: number, lane: number, rx: number, ry: number, center: { x: number; y: number }) {
  const x = Math.cos(angle) * rx * (1 + lane * 0.05)
  const y = Math.sin(angle) * ry * (1 + lane * 0.35)
  const cos = Math.cos(PLANE_TILT)
  const sin = Math.sin(PLANE_TILT)
  return { x: center.x + x * cos - y * sin, y: center.y + x * sin + y * cos, depth: Math.sin(angle) }
}

/**
 * A wide tilted ring of particle streams through the deck, edge to edge, drawn in two halves
 * around the orb: the far half behind it, the near half in front. Running tasks ride it as comets.
 */
export function drawOrbitPlane(ctx: CanvasRenderingContext2D, frame: PlaneFrame) {
  const { half, width, height, time, now, state, arcs, center } = frame
  const mix = frame.mix && mixTotal(frame.mix) > 0 ? frame.mix : null
  const waves = (frame.waves ?? []).filter((wave) => now - wave.at < WAVE_LIFETIME_MS)
  const rx = width * 0.78
  // On very wide decks the plane stays inside the stage instead of being cropped.
  const ry = Math.min(rx * 0.15, 120)
  const near = half === "near"
  const accent = ACCENT[state]
  const energy = ENERGY[state]
  ctx.clearRect(0, 0, width, height)
  ctx.save()
  ctx.globalCompositeOperation = "lighter"

  // The plane's faint body: two hairline ellipses that fade toward the edges.
  const gradient = ctx.createLinearGradient(0, center.y, width, center.y)
  gradient.addColorStop(0, css(accent, 0))
  gradient.addColorStop(0.33, css(accent, 0.5))
  gradient.addColorStop(0.67, css(accent, 0.5))
  gradient.addColorStop(1, css(accent, 0))
  ctx.strokeStyle = gradient
  ctx.lineWidth = 0.6
  for (const lane of [-0.6, 0.6]) {
    ctx.beginPath()
    let first = true
    for (let step = 0; step <= 240; step++) {
      const point = planePoint((step / 240) * TAU, lane, rx, ry, center)
      if (near !== point.depth > 0) {
        first = true
        continue
      }
      if (first) {
        ctx.moveTo(point.x, point.y)
        first = false
      } else ctx.lineTo(point.x, point.y)
    }
    ctx.stroke()
  }

  // Particle streams flowing around the plane, left to right across the front.
  const colors = new Map<Signal, string>()
  const accentCss = css(accent)
  for (const grain of GRAINS) {
    const angle = grain.angle + time * grain.speed * (0.6 + 0.6 * energy)
    const placed = planePoint(angle, grain.lane, rx, ry, center)
    if (near !== placed.depth > 0) continue
    let { x, y } = placed
    let lift = 0
    for (const wave of waves) {
      const push = wavePush(wave, x, y, now)
      x += push.dx
      y += push.dy
      lift += push.lift
    }
    lift = Math.min(lift, 1)
    const nearness = (placed.depth + 1) / 2
    const edgeFade = Math.min(1, Math.max(0, Math.min(x, width - x) / 70))
    const twinkle = 0.6 + 0.4 * Math.sin(time * 2.1 + grain.phase)
    const alpha = (0.26 + 0.74 * nearness) * twinkle * edgeFade * (1 + 1.2 * lift)
    if (alpha < 0.004) continue
    const signal = mix ? signalAt(mix, grain.slot) : null
    let fill = accentCss
    if (signal) {
      fill = colors.get(signal) ?? css(SIGNAL_RAMP[signal].light)
      colors.set(signal, fill)
    }
    const r = grain.size * (0.6 + 0.7 * nearness) * (1 + 0.5 * lift)
    ctx.globalAlpha = Math.min(alpha, 1)
    ctx.fillStyle = fill
    ctx.beginPath()
    ctx.arc(x, y, r, 0, TAU)
    ctx.fill()
  }
  ctx.globalAlpha = 1

  // Running tasks ride the plane: a comet with a tail, placed by progress.
  arcs.slice(0, 4).forEach((arc, index) => {
    const base = -Math.PI / 2 + (arc.progress ?? (time * 0.08) % 1) * TAU
    const angle = base + index * 0.9 + time * 0.05
    const head = planePoint(angle, 0, rx, ry, center)
    if (near !== head.depth > 0) return
    const ramp = TASK_RAMPS[index % TASK_RAMPS.length]!
    for (let step = 0; step < 18; step++) {
      const point = planePoint(angle - step * 0.012, 0, rx, ry, center)
      const r = 2.6 - step * 0.12
      ctx.fillStyle = css(ramp[step < 6 ? 0 : 1]!, Math.max(0, 0.9 - step * 0.045))
      ctx.beginPath()
      ctx.arc(point.x, point.y, r, 0, TAU)
      ctx.fill()
    }
    const glow = ctx.createRadialGradient(head.x, head.y, 0, head.x, head.y, 9)
    glow.addColorStop(0, css(ramp[0]!, 0.8))
    glow.addColorStop(1, css(ramp[0]!, 0))
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(head.x, head.y, 9, 0, TAU)
    ctx.fill()
  })
  ctx.restore()
}
