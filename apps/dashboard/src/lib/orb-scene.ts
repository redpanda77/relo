/**
 * The Relo core, one scene for two framings. A plasma sphere in the meaning colours sits inside
 * slow instrument rings; signals stream in from the dark along curved paths, each in the colour of
 * what it reports, and land on the core as a ripple. Dust drifts around it. The pointer tilts the
 * whole instrument.
 *
 * - `hero` (the landing): the core right of the copy on wide screens, above it on phones; scrolling
 *   only eases it back (no scroll story). Its comet stream is decorative and never stops.
 * - `deck` (Now, sign-in, loading): the core centred and sized to its canvas. On Now every motion
 *   means something (`lib/orb-theme.ts`): colour says whether anything needs the owner; the steady
 *   motion (`setMotion`: plasma churn, surface displacement, ring rotation, dust, the halo's breath)
 *   says whether anything is moving and how much; a comet (`pulse`) says something just happened,
 *   one per real server update, and parks once it lands; arcs say how far along each task is. A
 *   deck given decorative `signals` (sign-in, loading) streams them like the hero.
 */

import * as THREE from "three"
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js"
import { OutputPass } from "three/addons/postprocessing/OutputPass.js"
import { RenderPass } from "three/addons/postprocessing/RenderPass.js"
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js"
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js"

import { beatPhase } from "@/lib/heartbeat"
import { canBakePlasma, createPlasmaBake, PLASMA_FIELD } from "@/lib/orb-plasma"
import { DECORATIVE_MOTION, LANDING_THEME } from "@/lib/orb-theme"

export type OrbFraming = "hero" | "deck"

/** The core's colours (bright, middle, accent, as CSS hex) and the halo's extra brightness (needs you). */
export type OrbTheme = { colors: readonly [string, string, string]; glow?: number }

/** A decorative comet stream (sign-in, loading, the hero): how many at once and their colours. */
export type OrbSignals = { count: number; colors: readonly string[] }

/**
 * The deck's steady motion, from the server's summary (`orbMotion` in lib/orb-theme.ts). The scene
 * eases toward it (time constant about 1.5 s), never snaps.
 */
export type OrbMotion = {
  /** How much is moving, 0...1. */
  level: number
  mode: "calm" | "moving" | "quiet" | "offline"
  /** The mode the summary alone gives (offline aside): what the colour follows. */
  basis: "calm" | "moving" | "quiet"
  /** The halo's breath: its depth (0...1) and period (ms; the heartbeat is 4000). */
  breath: { depth: number; period: number }
  /** Ring rotation, × each ring's base speed (0 stands still). */
  ringSpeed: number
  /** Surface displacement amplitude (world units on a 1.25 sphere). */
  displacement: number
  /** Plasma churn rate (× the landing's). */
  plasmaRate: number
  /** Dust drift (radians per second; 0 stands still). */
  dust: number
}

/** What a comet reports: it sets the comet's landing (needs you spikes the plasma, finished work lifts the halo). */
export type OrbPulseKind = "activity" | "needsYou" | "done" | "failed"

export type OrbPulseOptions = {
  kind?: OrbPulseKind
  /** How bright it lands (default by kind: needs you 1.6, failed 0.9, else 1). */
  strength?: number
  /** Head size (1 = a full comet). */
  size?: number
  /** Trail length (1 = full). */
  trailScale?: number
  /** Where it comes from: a screen-plane angle in radians (0 = right, π/2 = above); random when absent. */
  from?: number
  /** Seconds of scene time before it launches (scene time holds while the scene is paused). */
  delay?: number
  /** Called once when it lands (or would have, if it is displaced). */
  onLand?: () => void
}

/** One task's arc on the inner ring, keyed by its work so it keeps its shown progress. */
export type OrbArc = {
  id: string
  /** 0...1, or null without steps (a short bright segment). */
  progress: number | null
  /** CSS hex; cyan when absent. */
  color?: string
  /** Opacity (quiet work 0.35, offline 0.5). */
  alpha?: number
  /** A light sweeping along the arc every 2.4 s (moving work). */
  glint?: boolean
}

export type OrbScene = {
  /** 0 at the top of the page, 1 once the hero has scrolled away (hero only). */
  setScroll(progress: number): void
  setPaused(paused: boolean): void
  setTheme(theme: OrbTheme): void
  /** The steady motion (deck only); eased. */
  setMotion(motion: OrbMotion): void
  /** A decorative comet stream (never on Now). */
  setSignals(signals: OrbSignals): void
  /**
   * Sends one comet in, in this colour: one real update arriving. Returns false when nothing flies
   * (reduced motion).
   */
  pulse(color: string, options?: OrbPulseOptions): boolean
  /** Spikes the plasma's energy to `level` (default 1.3), decaying back over about a second. */
  boost(level?: number): void
  /** Each task's arc on the inner ring; arcs ease toward new progress, grow in and fade out. */
  setArcs(arcs: readonly OrbArc[]): void
  /** Ripples the plasma where a viewport point lands on the core; false when it misses. */
  touch(clientX: number, clientY: number): boolean
  dispose(): void
}

/** Every steady motion eases with this time constant (seconds). */
export const MOTION_TAU = 1.5

/** One exponential easing step toward `target` (time constant `tau` seconds). */
export function easeToward(current: number, target: number, delta: number, tau = MOTION_TAU): number {
  if (delta <= 0) return current
  const next = current + (target - current) * (1 - Math.exp(-delta / tau))
  return Math.abs(target - next) < 1e-5 ? target : next
}

/** The motion as drawn: every channel eases on its own toward the target. */
export type ShownMotion = { plasmaRate: number; displacement: number; ringSpeed: number; dust: number; depth: number; period: number; level: number }

export function shownMotion(motion: OrbMotion): ShownMotion {
  return {
    plasmaRate: motion.plasmaRate,
    displacement: motion.displacement,
    ringSpeed: motion.ringSpeed,
    dust: motion.dust,
    depth: motion.breath.depth,
    period: motion.breath.period,
    level: motion.level,
  }
}

/** One easing step of every channel; `delta` 0 keeps it, Infinity (reduced motion) jumps. */
export function easeMotion(shown: ShownMotion, target: OrbMotion, delta: number): ShownMotion {
  if (!Number.isFinite(delta)) return shownMotion(target)
  const goal = shownMotion(target)
  return {
    plasmaRate: easeToward(shown.plasmaRate, goal.plasmaRate, delta),
    displacement: easeToward(shown.displacement, goal.displacement, delta),
    ringSpeed: easeToward(shown.ringSpeed, goal.ringSpeed, delta),
    dust: easeToward(shown.dust, goal.dust, delta),
    depth: easeToward(shown.depth, goal.depth, delta),
    period: easeToward(shown.period, goal.period, delta),
    level: easeToward(shown.level, goal.level, delta),
  }
}

/** A comet slot's flight: launched at `start` (scene seconds), lands after `duration`. */
export type CometSlot = { start: number; duration: number }
/** A resting slot's start: it never flies until something launches it. */
export const PARKED = 1e9

/** A slot at rest (parked, or its flight is over and not yet re-launched). */
export function isResting(slot: CometSlot, now: number): boolean {
  return slot.start >= PARKED || now - slot.start >= slot.duration
}

/** The slots whose comets land at `now` (not parked, flight complete). */
export function landedSlots(slots: readonly CometSlot[], now: number): number[] {
  const landed: number[] = []
  slots.forEach((slot, index) => {
    if (slot.start < PARKED && now - slot.start >= slot.duration) landed.push(index)
  })
  return landed
}

/** The slots flying at `now`. */
export function flyingSlots(slots: readonly CometSlot[], now: number): number[] {
  const flying: number[] = []
  slots.forEach((slot, index) => {
    if (slot.start < PARKED && now > slot.start && now - slot.start < slot.duration) flying.push(index)
  })
  return flying
}

/**
 * What a slot does once its comet lands: a decorative stream re-launches it (slots under the live
 * count); otherwise it parks until a real update launches it again. Now's deck streams none.
 */
export function afterLanding(slot: number, active: number): "respawn" | "park" {
  return slot < active ? "respawn" : "park"
}

/**
 * The slot a new comet takes: a resting one first; when every slot is busy, the one closest to
 * landing, which lands at once (`displaced`) so its update is never lost.
 */
export function pickCometSlot(slots: readonly CometSlot[], now: number): { slot: number; displaced: boolean } {
  const resting = slots.findIndex((slot) => isResting(slot, now))
  if (resting >= 0) return { slot: resting, displaced: false }
  let slot = 0
  let most = -Infinity
  slots.forEach((entry, index) => {
    const progress = (now - entry.start) / entry.duration
    if (progress > most) {
      most = progress
      slot = index
    }
  })
  return { slot, displaced: true }
}

/** A comet's default impact by what it reports. */
export function kindImpact(kind: OrbPulseKind): number {
  return kind === "needsYou" ? 1.6 : kind === "failed" ? 0.9 : 1
}

const MEANING = ["#5ce1ff", "#34d399", "#ff8a3d", "#8b7cff", "#d65cf0"] as const
const MAX_HITS = 6
const MAX_ARCS = 6

const NOISE = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
float fbm(vec3 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int octave = 0; octave < 4; octave++) {
    value += amplitude * snoise(p);
    p = p * 2.02 + vec3(11.7, 3.1, 7.9);
    amplitude *= 0.5;
  }
  return value;
}
`

const ORB_VERTEX = /* glsl */ `
uniform float uTime;
// Surface displacement: how much the core's skin moves (deck: the motion level; hero 0.035).
uniform float uDisplace;
varying vec3 vNormal;
varying vec3 vObject;
varying vec3 vView;
${NOISE}
void main() {
  vec3 p = position;
  float n = snoise(normalize(p) * 1.8 + vec3(uTime * 0.18));
  p += normal * n * uDisplace;
  vObject = normalize(position);
  vec4 world = modelMatrix * vec4(p, 1.0);
  vNormal = normalize(mat3(modelMatrix) * normal);
  vView = normalize(cameraPosition - world.xyz);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`

const ORB_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform vec3 uC0;
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uC3;
uniform vec4 uHits[${MAX_HITS}];
uniform vec3 uHitColors[${MAX_HITS}];
varying vec3 vNormal;
varying vec3 vObject;
varying vec3 vView;
#ifdef BAKED_FIELD
// The field baked at two plasma times (lib/orb-plasma.ts), blended to now.
uniform samplerCube uFieldA;
uniform samplerCube uFieldB;
uniform float uFieldMix;
#else
${NOISE}
${PLASMA_FIELD}
#endif
void main() {
  vec3 p = vObject;
#ifdef BAKED_FIELD
  float field = mix(textureCube(uFieldA, p).r, textureCube(uFieldB, p).r, uFieldMix);
#else
  float field = plasmaField(p, uTime);
#endif
  float f = clamp(field * 0.6 + 0.5, 0.0, 1.0);

  vec3 color = mix(uC0, uC2, smoothstep(0.2, 0.5, f));
  color = mix(color, uC1, smoothstep(0.5, 0.72, f));
  color = mix(color, uC3, smoothstep(0.78, 0.95, f) * 0.8);

  // Bright filaments where the field crosses zero, like the app's plasma veins.
  float vein = pow(1.0 - abs(field - 0.05), 22.0);
  float facing = max(dot(normalize(vNormal), normalize(vView)), 0.0);
  float rim = pow(1.0 - facing, 2.6);

  vec3 lit = color * (0.08 + 0.75 * f * f) + vein * mix(uC1, vec3(1.0), 0.35) * 0.5;
  lit += rim * mix(uC1, uC3, 0.5) * 0.85;
  // A darker heart keeps the core calm.
  lit *= mix(0.55, 1.0, smoothstep(0.55, 0.0, facing - 0.35));

  for (int i = 0; i < ${MAX_HITS}; i++) {
    vec4 hit = uHits[i];
    if (hit.w < 0.0 || hit.w > 2.4) continue;
    float d = acos(clamp(dot(p, hit.xyz), -1.0, 1.0));
    float front = hit.w * 1.1;
    float band = exp(-pow((d - front) / 0.07, 2.0)) * exp(-hit.w * 1.6);
    float flash = exp(-d * 9.0) * exp(-hit.w * 5.0);
    lit += uHitColors[i] * (band * 1.6 + flash * 2.4);
  }
  gl_FragColor = vec4(lit, 1.0);
}
`

const HALO_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uColor2;
uniform float uTime;
// The UI's 4 s heartbeat (0...1, deck only) and a moment's lift (finished work).
uniform float uBreath;
uniform float uBoost;
varying vec2 vUv;
void main() {
  vec2 c = vUv - 0.5;
  float r = length(c) * 2.0;
  float a = atan(c.y, c.x);
  float glow = exp(-max(r - 0.32, 0.0) * 7.0) * smoothstep(1.0, 0.5, r);
  vec3 color = mix(uColor, uColor2, 0.5 + 0.5 * sin(a * 2.0 + uTime * 0.25));
  gl_FragColor = vec4(color * glow * 0.11 * (1.0 + uBreath * 0.22 + uBoost), 1.0);
}
`

const POINTS_VERTEX = /* glsl */ `
attribute float aAlpha;
attribute float aSize;
attribute vec3 aColor;
uniform float uPixelRatio;
uniform float uTime;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float depth = max(-mv.z, 0.001);
  gl_PointSize = min(aSize * uPixelRatio * (8.0 / depth), 28.0 * uPixelRatio);
  gl_Position = projectionMatrix * mv;
  // Fade anything drifting close to the lens instead of letting it blow up into haze.
  vAlpha = aAlpha * smoothstep(2.5, 5.0, depth);
  vColor = aColor;
}
`

const POINTS_FRAGMENT = /* glsl */ `
varying float vAlpha;
varying vec3 vColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float soft = smoothstep(0.5, 0.0, d);
  gl_FragColor = vec4(vColor * (soft * soft * 1.6 + smoothstep(0.12, 0.0, d) * 1.4) * vAlpha, 1.0);
}
`

type Signal = {
  curve: THREE.CubicBezierCurve3
  color: THREE.Color
  start: number
  duration: number
  /** The landing direction on the core. */
  target: THREE.Vector3
  /** How bright it lands (1 for ambient comets), and what it reports. */
  impact: number
  kind: OrbPulseKind
  /** Head size and trail length (1 = full). */
  size: number
  trailScale: number
  onLand?: () => void
}

function random(min: number, max: number) {
  return min + Math.random() * (max - min)
}

function linear(hex: string) {
  return new THREE.Color(hex)
}

export function supportsWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas")
    const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl")
    // Release the probe at once; browsers cap live contexts.
    context?.getExtension("WEBGL_lose_context")?.loseContext()
    return Boolean(context)
  } catch {
    return false
  }
}

export function createOrbScene(
  canvas: HTMLCanvasElement,
  options: {
    reducedMotion: boolean
    framing?: OrbFraming
    theme?: OrbTheme
    /** Deck only: the steady motion (decorative when absent). */
    motion?: OrbMotion
    /** A decorative comet stream; a deck without one streams nothing until `pulse`. */
    signals?: OrbSignals
    onReady?: () => void
    onLost?: () => void
  }
): OrbScene {
  const framing = options.framing ?? "hero"
  const deck = framing === "deck"
  const compact = window.matchMedia("(max-width: 767px)").matches
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    // The deck is transparent so the core sits in the page's own sky (its glow adds to the page);
    // the hero paints its own ink.
    alpha: deck,
  })
  // The deck is a companion to the work beside it: a lighter buffer (and 30 fps below) than the hero.
  const pixelRatio = Math.min(window.devicePixelRatio || 1, deck ? 1.25 : compact ? 1.5 : 1.75)
  renderer.setPixelRatio(pixelRatio)

  const scene = new THREE.Scene()
  // The ink canvas, colour-managed like everything else (a raw clear colour would be encoded twice).
  if (deck) renderer.setClearColor(0x000000, 0)
  else scene.background = linear("#08080d")
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100)
  camera.position.set(0, 0, 9)

  // Everything that tilts with the pointer.
  const rig = new THREE.Group()
  scene.add(rig)
  const core = new THREE.Group()
  rig.add(core)

  const palette = MEANING.map(linear)

  const theme = options.theme ?? LANDING_THEME
  // The colours ease toward their targets, so a new mix or state washes through the plasma.
  const target = { c1: linear(theme.colors[0]), c2: linear(theme.colors[1]), c3: linear(theme.colors[2]), glow: theme.glow ?? 0 }
  let glow = target.glow
  // The deck's steady motion: the target from the page, and what is drawn now (eased toward it).
  let motionTarget = options.motion ?? DECORATIVE_MOTION
  let motion = shownMotion(motionTarget)
  const orbUniforms = {
    uTime: { value: 0 },
    uDisplace: { value: deck ? motion.displacement : 0.035 },
    uC0: { value: linear("#14123a") },
    uC1: { value: target.c1.clone() },
    uC2: { value: target.c2.clone() },
    uC3: { value: target.c3.clone() },
    uHits: { value: Array.from({ length: MAX_HITS }, () => new THREE.Vector4(0, 0, 1, -1)) },
    uHitColors: { value: Array.from({ length: MAX_HITS }, () => new THREE.Color()) },
  }
  // The plasma field baked into cube maps where the GPU can render half floats; else evaluated live.
  const plasma = canBakePlasma(renderer) ? createPlasmaBake(renderer, NOISE) : null
  const orb = new THREE.Mesh(
    new THREE.SphereGeometry(1.25, compact ? 96 : 160, compact ? 96 : 160),
    new THREE.ShaderMaterial({
      uniforms: plasma ? { ...orbUniforms, ...plasma.uniforms } : orbUniforms,
      vertexShader: ORB_VERTEX,
      fragmentShader: ORB_FRAGMENT,
      defines: plasma ? { BAKED_FIELD: "" } : {},
    })
  )
  core.add(orb)

  const haloUniforms = {
    uColor: { value: target.c1.clone() },
    uColor2: { value: target.c3.clone() },
    uTime: { value: 0 },
    uBreath: { value: 0 },
    uBoost: { value: 0 },
  }
  const halo = new THREE.Mesh(
    new THREE.PlaneGeometry(7.5, 7.5),
    new THREE.ShaderMaterial({
      uniforms: haloUniforms,
      vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
      fragmentShader: HALO_FRAGMENT,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  )
  halo.position.z = -0.6
  core.add(halo)

  // Instrument rings: hairlines with tick marks, each on its own slow axis.
  const rings: THREE.Object3D[] = []
  const ringSpecs = [
    { radius: 1.75, tilt: [1.15, 0.2, 0], speed: 0.05, opacity: 0.35, ticks: 120 },
    { radius: 2.3, tilt: [1.35, -0.5, 0.3], speed: -0.03, opacity: 0.22, ticks: 0 },
    { radius: 2.95, tilt: [1.05, 0.65, -0.2], speed: 0.018, opacity: 0.14, ticks: 72 },
  ] as const
  for (const spec of ringSpecs) {
    const group = new THREE.Group()
    group.rotation.set(spec.tilt[0], spec.tilt[1], spec.tilt[2])
    const points: THREE.Vector3[] = []
    for (let i = 0; i <= 256; i++) {
      const a = (i / 256) * Math.PI * 2
      points.push(new THREE.Vector3(Math.cos(a) * spec.radius, Math.sin(a) * spec.radius, 0))
    }
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({
        color: linear("#b9c4ff"),
        transparent: true,
        opacity: spec.opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    )
    group.add(line)
    if (spec.ticks) {
      const ticks: THREE.Vector3[] = []
      for (let i = 0; i < spec.ticks; i++) {
        const a = (i / spec.ticks) * Math.PI * 2
        const long = i % 10 === 0 ? 0.11 : 0.045
        ticks.push(
          new THREE.Vector3(Math.cos(a) * spec.radius, Math.sin(a) * spec.radius, 0),
          new THREE.Vector3(Math.cos(a) * (spec.radius + long), Math.sin(a) * (spec.radius + long), 0)
        )
      }
      group.add(
        new THREE.LineSegments(
          new THREE.BufferGeometry().setFromPoints(ticks),
          new THREE.LineBasicMaterial({
            color: linear("#c9d2ff"),
            transparent: true,
            opacity: spec.opacity * 0.9,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
          })
        )
      )
    }
    group.userData.speed = spec.speed
    rings.push(group)
    core.add(group)
  }

  // Progress arcs: glowing points along the inner ring, one sector per task, keyed by its work.
  const arcPerTask = 90
  const arcGeometry = new THREE.BufferGeometry()
  const arcPositions = new Float32Array(MAX_ARCS * arcPerTask * 3)
  const arcAlpha = new Float32Array(MAX_ARCS * arcPerTask)
  const arcSize = new Float32Array(MAX_ARCS * arcPerTask).fill(3.2)
  const arcColor = new Float32Array(MAX_ARCS * arcPerTask * 3)
  arcGeometry.setAttribute("position", new THREE.BufferAttribute(arcPositions, 3))
  arcGeometry.setAttribute("aAlpha", new THREE.BufferAttribute(arcAlpha, 1))
  arcGeometry.setAttribute("aSize", new THREE.BufferAttribute(arcSize, 1))
  arcGeometry.setAttribute("aColor", new THREE.BufferAttribute(arcColor, 3))
  // What is drawn now: each arc eases its progress, tint and opacity toward its target, grows in
  // (weight 0 → 1, its sector opening) and fades out when its work leaves. Nothing snaps.
  type ShownArc = {
    id: string
    progress: number
    goal: number
    color: THREE.Color
    goalColor: THREE.Color
    alpha: number
    goalAlpha: number
    glint: number
    goalGlint: number
    weight: number
    leaving: boolean
  }
  let arcShown: ShownArc[] = []
  let arcsDirty = true
  const CYAN = linear("#5ce1ff")
  /** No steps: a short bright segment, so the task still shows as live. */
  function arcGoal(progress: number | null) {
    return progress == null ? 0.18 : Math.min(Math.max(progress, 0.02), 1)
  }
  function setArcs(arcs: readonly OrbArc[]) {
    const known = new Map(arcShown.map((arc) => [arc.id, arc]))
    const ids = new Set<string>()
    const next: ShownArc[] = []
    for (const arc of arcs.slice(0, MAX_ARCS)) {
      ids.add(arc.id)
      const goalColor = arc.color ? linear(arc.color) : CYAN.clone()
      const goal = arcGoal(arc.progress)
      const goalAlpha = arc.alpha ?? 1
      const goalGlint = arc.glint ? 1 : 0
      const before = known.get(arc.id)
      if (before) {
        Object.assign(before, { goal, goalColor, goalAlpha, goalGlint, leaving: false })
        next.push(before)
      } else {
        // New work grows in from nothing; a still scene takes the targets at once.
        const still = options.reducedMotion
        next.push({
          id: arc.id,
          progress: still ? goal : 0,
          goal,
          color: goalColor.clone(),
          goalColor,
          alpha: goalAlpha,
          goalAlpha,
          glint: goalGlint,
          goalGlint,
          weight: still ? 1 : 0,
          leaving: false,
        })
      }
    }
    // Work that left keeps its place while its arc fades out (at once under reduced motion).
    if (!options.reducedMotion) {
      arcShown.forEach((arc, index) => {
        if (ids.has(arc.id)) return
        arc.leaving = true
        next.splice(Math.min(index, next.length), 0, arc)
      })
    }
    arcShown = next.slice(0, MAX_ARCS)
    if (options.reducedMotion) {
      for (const arc of arcShown) {
        Object.assign(arc, { progress: arc.goal, alpha: arc.goalAlpha, glint: 0 })
        arc.color.copy(arc.goalColor)
      }
    }
    arcsDirty = true
    if (options.reducedMotion) {
      drawArcs()
      if (started) render()
    }
  }
  function easeArcs(delta: number) {
    if (!arcShown.length) {
      if (arcsDirty) drawArcs()
      return
    }
    // Arcs follow their progress a little faster than the steady motion (a step reads as a step).
    const ease = 1 - Math.exp(-delta * 4)
    let moving = arcsDirty
    for (const arc of arcShown) {
      const weight = arc.leaving ? 0 : 1
      const before = [arc.progress, arc.alpha, arc.glint, arc.weight]
      arc.progress = easeToward(arc.progress, arc.goal, delta, 0.25)
      arc.alpha = easeToward(arc.alpha, arc.goalAlpha, delta)
      arc.glint = easeToward(arc.glint, arc.goalGlint, delta)
      arc.weight = easeToward(arc.weight, weight, delta, 0.5)
      if (!arc.color.equals(arc.goalColor)) {
        arc.color.lerp(arc.goalColor, ease)
        if (Math.abs(arc.color.r - arc.goalColor.r) + Math.abs(arc.color.g - arc.goalColor.g) + Math.abs(arc.color.b - arc.goalColor.b) < 1e-3) arc.color.copy(arc.goalColor)
        moving = true
      }
      if (before.some((value, index) => value !== [arc.progress, arc.alpha, arc.glint, arc.weight][index])) moving = true
      // The glint sweeps continuously: a moving arc redraws every frame.
      if (arc.glint > 0.001) moving = true
    }
    const gone = arcShown.filter((arc) => arc.leaving && arc.weight < 0.002)
    if (gone.length) arcShown = arcShown.filter((arc) => !gone.includes(arc))
    if (moving || gone.length) drawArcs()
  }
  /** The glint's period: one sweep along each moving arc every 2.4 s. */
  const GLINT_PERIOD = 2.4
  function drawArcs() {
    arcsDirty = false
    const radius = ringSpecs[0].radius
    const total = arcShown.reduce((sum, arc) => sum + arc.weight, 0)
    const gap = 0.12 * Math.min(Math.max(total - 1, 0), 1)
    const glintAt = (elapsed % GLINT_PERIOD) / GLINT_PERIOD
    arcAlpha.fill(0)
    let start = Math.PI / 2
    arcShown.forEach((arc, task) => {
      const sector = (Math.PI * 2 * arc.weight) / Math.max(total, 1)
      const length = Math.max(sector - gap * 2, 0) * arc.progress
      const from = start - gap
      start -= sector
      for (let i = 0; i < arcPerTask; i++) {
        const index = task * arcPerTask + i
        const along = i / (arcPerTask - 1)
        const a = from - along * length
        arcPositions.set([Math.cos(a) * radius, Math.sin(a) * radius, 0], index * 3)
        const shine = arc.glint * Math.exp(-Math.pow((along - glintAt) / 0.07, 2))
        arcAlpha[index] = ((0.55 + 0.45 * (i / arcPerTask)) * arc.alpha + shine * 1.1) * Math.min(arc.weight * 2, 1)
        arcSize[index] = 3.2 + shine * 3
        arcColor.set([arc.color.r, arc.color.g, arc.color.b], index * 3)
      }
    })
    for (const name of ["position", "aAlpha", "aSize", "aColor"]) arcGeometry.attributes[name]!.needsUpdate = true
  }

  // Dust: a deep shell of faint points.
  const dustCount = compact ? 900 : 2200
  const dustGeometry = new THREE.BufferGeometry()
  const dustPositions = new Float32Array(dustCount * 3)
  const dustAlpha = new Float32Array(dustCount)
  const dustSize = new Float32Array(dustCount)
  const dustColor = new Float32Array(dustCount * 3)
  const dustTwinkle = new Float32Array(dustCount)
  for (let i = 0; i < dustCount; i++) {
    const r = random(3.2, 14)
    const theta = random(0, Math.PI * 2)
    const phi = Math.acos(random(-1, 1))
    dustPositions.set(
      [r * Math.sin(phi) * Math.cos(theta), r * Math.sin(phi) * Math.sin(theta) * 0.7, Math.min(r * Math.cos(phi) - 3, 2)],
      i * 3
    )
    dustAlpha[i] = random(0.15, 0.7)
    dustTwinkle[i] = random(0, Math.PI * 2)
    dustSize[i] = random(0.6, 2.2)
    const tone = Math.random() < 0.82 ? linear("#c8ceff") : palette[Math.floor(random(0, palette.length))]!
    dustColor.set([tone.r, tone.g, tone.b], i * 3)
  }
  dustGeometry.setAttribute("position", new THREE.BufferAttribute(dustPositions, 3))
  dustGeometry.setAttribute("aAlpha", new THREE.BufferAttribute(dustAlpha, 1))
  dustGeometry.setAttribute("aSize", new THREE.BufferAttribute(dustSize, 1))
  dustGeometry.setAttribute("aColor", new THREE.BufferAttribute(dustColor, 3))
  const pointsUniforms = { uPixelRatio: { value: pixelRatio }, uTime: { value: 0 } }
  const pointsMaterial = new THREE.ShaderMaterial({
    uniforms: pointsUniforms,
    vertexShader: POINTS_VERTEX,
    fragmentShader: POINTS_FRAGMENT,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const dust = new THREE.Points(dustGeometry, pointsMaterial)
  scene.add(dust)
  const arcPoints = new THREE.Points(arcGeometry, pointsMaterial)
  arcPoints.frustumCulled = false
  rings[0]!.add(arcPoints)

  // Signals: comets with trails, from the dark to the core.
  const signalCount = compact ? 9 : 16
  // How many comets stream on their own: the hero keeps every slot busy in the meaning colours; a
  // decorative deck streams its count; Now's deck streams none (a comet there is a real update).
  let activeSignals = deck ? Math.min(options.signals?.count ?? 0, signalCount) : signalCount
  let signalPalette = options.signals?.colors.length ? options.signals.colors.map(linear) : palette
  const trail = 64
  const signalGeometry = new THREE.BufferGeometry()
  const signalPositions = new Float32Array(signalCount * trail * 3)
  const signalAlpha = new Float32Array(signalCount * trail)
  const signalSize = new Float32Array(signalCount * trail)
  const signalColor = new Float32Array(signalCount * trail * 3)
  signalGeometry.setAttribute("position", new THREE.BufferAttribute(signalPositions, 3))
  signalGeometry.setAttribute("aAlpha", new THREE.BufferAttribute(signalAlpha, 1))
  signalGeometry.setAttribute("aSize", new THREE.BufferAttribute(signalSize, 1))
  signalGeometry.setAttribute("aColor", new THREE.BufferAttribute(signalColor, 3))
  const signalPoints = new THREE.Points(signalGeometry, pointsMaterial)
  signalPoints.frustumCulled = false
  core.add(signalPoints)

  const up = new THREE.Vector3(0, 1, 0)
  function spawn(now: number, delay: number, from?: number): Signal {
    // Land on the visible face, so every impact reads as a hit rather than a pass behind the edge;
    // a comet with an origin lands on the side it came from.
    const target =
      from == null
        ? new THREE.Vector3(random(-0.85, 0.85), random(-0.6, 0.6), random(0.55, 1)).normalize()
        : new THREE.Vector3(Math.cos(from) * 0.6 + random(-0.2, 0.2), Math.sin(from) * 0.45 + random(-0.15, 0.15), random(0.7, 1)).normalize()
    const angle = from ?? random(0, Math.PI * 2)
    const distance = random(7, 11)
    const start = new THREE.Vector3(Math.cos(angle) * distance, Math.sin(angle) * distance * 0.55, random(-4, 2))
    const swirl = random(0.6, 1.3) * (Math.random() < 0.5 ? -1 : 1)
    const c1 = start.clone().multiplyScalar(0.55).applyAxisAngle(up, swirl * 0.6)
    c1.z += random(-1, 2)
    const c2 = target.clone().multiplyScalar(3.2).applyAxisAngle(new THREE.Vector3(0, 0, 1), swirl)
    // Just outside the displaced surface (radius 1.25 plus up to ~0.04 of bumps), so the head stays visible to contact.
    const end = target.clone().multiplyScalar(1.31)
    return {
      curve: new THREE.CubicBezierCurve3(start, c1, c2, end),
      color: signalPalette[Math.floor(random(0, signalPalette.length))]!.clone(),
      start: now + delay,
      duration: random(3.2, 6),
      target,
      impact: 1,
      kind: "activity",
      size: 1,
      trailScale: 1,
    }
  }
  const signals: Signal[] = Array.from({ length: signalCount }, (_, i) => {
    const signal = spawn(0, i * random(0.3, 0.9))
    if (i >= activeSignals) signal.start = PARKED
    return signal
  })
  let nextHit = 0
  const point = new THREE.Vector3()
  const hitPoint = new THREE.Vector3()

  /** A comet reaches the core: a ripple where it hit, its landing moment, and its callback. */
  function landSignal(signal: Signal) {
    const slot = nextHit++ % MAX_HITS
    // The orb spins inside the core: express the impact in its own frame so the ripple starts where the comet hit.
    hitPoint.copy(signal.target).applyAxisAngle(up, -orb.rotation.y)
    orbUniforms.uHits.value[slot]!.set(hitPoint.x, hitPoint.y, hitPoint.z, 0)
    orbUniforms.uHitColors.value[slot]!.copy(signal.color).multiplyScalar(signal.impact)
    land(signal.kind)
    const onLand = signal.onLand
    signal.onLand = undefined
    onLand?.()
  }

  function updateSignals(now: number) {
    for (const s of landedSlots(signals, now)) {
      landSignal(signals[s]!)
      // A decorative stream re-launches its slot; everything else parks until the next real update.
      if (afterLanding(s, activeSignals) === "park") {
        signals[s] = spawn(now, 0)
        signals[s]!.start = PARKED
      } else {
        signals[s] = spawn(now, deck ? random(0.6, 4) : random(0.2, 2.4))
      }
    }
    for (let s = 0; s < signals.length; s++) {
      const signal = signals[s]!
      const raw = (now - signal.start) / signal.duration
      for (let i = 0; i < trail; i++) {
        const index = s * trail + i
        const t = Math.pow(Math.min(Math.max(raw, 0), 1), 1.7) - i * 0.0075 * signal.trailScale
        if (raw <= 0 || t < 0 || raw >= 1) {
          signalAlpha[index] = 0
          continue
        }
        signal.curve.getPoint(t, point)
        signalPositions.set([point.x, point.y, point.z], index * 3)
        const fade = 1 - i / trail
        signalAlpha[index] = fade * fade * Math.min(raw * 5, 1)
        signalSize[index] = i === 0 ? 11 * signal.size : 6 * fade + 0.8
        signalColor.set([signal.color.r, signal.color.g, signal.color.b], index * 3)
      }
    }
    signalGeometry.attributes.position!.needsUpdate = true
    signalGeometry.attributes.aAlpha!.needsUpdate = true
    signalGeometry.attributes.aSize!.needsUpdate = true
    signalGeometry.attributes.aColor!.needsUpdate = true
  }

  // Over a transparent canvas, glow must add light to the page without writing opacity: an additive
  // material that wrote alpha would darken the page around it (a dark box around the core).
  if (deck) {
    scene.traverse((object) => {
      const materials = (object as THREE.Mesh).material
      for (const material of Array.isArray(materials) ? materials : materials ? [materials] : []) {
        if (material.blending !== THREE.AdditiveBlending) continue
        material.blending = THREE.CustomBlending
        material.blendEquation = THREE.AddEquation
        material.blendSrc = THREE.SrcAlphaFactor
        material.blendDst = THREE.OneFactor
        material.blendSrcAlpha = THREE.ZeroFactor
        material.blendDstAlpha = THREE.OneFactor
      }
    })
  }

  const composer = new EffectComposer(renderer)
  composer.setPixelRatio(pixelRatio)
  composer.addPass(new RenderPass(scene, camera))
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), compact ? 0.65 : 0.8, 0.12, 0.42)
  composer.addPass(bloom)
  const output = new OutputPass()
  composer.addPass(output)
  // Last, in display colour: bloom's blur spreads the core's opacity into a haze that would dim the
  // page around it. Only the solid body stays opaque; the glow's opacity is its brightest channel, so
  // over the page it adds light (a premultiplied canvas cannot hold more colour than opacity).
  if (deck) {
    composer.addPass(
      new ShaderPass({
        uniforms: { tDiffuse: { value: null } },
        vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
        fragmentShader:
          "uniform sampler2D tDiffuse; varying vec2 vUv; void main(){ vec4 c = texture2D(tDiffuse, vUv); gl_FragColor = vec4(c.rgb, clamp(max(smoothstep(0.9, 1.0, c.a), max(c.r, max(c.g, c.b))), 0.0, 1.0)); }",
      })
    )
  }

  // Hero: the core sits right of the copy on wide screens and above it on phones. Deck: centred,
  // the camera dollied so the sphere fills a steady share of the canvas whatever its size.
  let deckDistance = 9
  function layout() {
    const width = canvas.clientWidth || window.innerWidth
    const height = canvas.clientHeight || window.innerHeight
    renderer.setSize(width, height, false)
    composer.setSize(width, height)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    if (deck) {
      // The sphere fills 64% of the stage height (70% of its width when narrower), between the corner
      // readouts; index.css paints the fallback core at the same size and feathers outside it.
      const sphere = Math.min(height * 0.64, width * 0.7)
      deckDistance = Math.max((2.5 * height) / (sphere * 2 * Math.tan(THREE.MathUtils.degToRad(19))), 4.4)
      core.position.set(0, 0, 0)
      core.scale.setScalar(1)
      if (options.reducedMotion && started) render()
      return
    }
    // Same breakpoint as the CSS (the viewport, scrollbar included), not the canvas width.
    const wide = window.matchMedia("(min-width: 1024px)").matches
    // A fixed world offset drifts off screen on narrow-aspect windows: scale it with the aspect.
    core.position.set(wide ? 2.35 * Math.min(1, camera.aspect / 1.6) : 0, wide ? 0.1 : 1.05, 0)
    core.scale.setScalar(wide ? 1 : Math.min(0.95, Math.max(0.68, width / 620)))
    // setSize clears the buffer; a still scene must draw its frame again.
    if (options.reducedMotion && started) render()
  }
  const resize = new ResizeObserver(() => layout())

  const pointer = { x: 0, y: 0, tx: 0, ty: 0 }
  function onPointer(event: PointerEvent) {
    pointer.tx = (event.clientX / window.innerWidth) * 2 - 1
    pointer.ty = (event.clientY / window.innerHeight) * 2 - 1
  }
  window.addEventListener("pointermove", onPointer, { passive: true })

  let scroll = 0
  let paused = false
  let frame = 0
  let disposed = false
  const clock = new THREE.Clock()
  let elapsed = 0
  let orbTime = 0
  // The deck's own clocks for what only moves while work does: the orb's spin, the halo's swirl,
  // the dust's drift and the breath's phase (the hero's run on `elapsed`).
  let orbSpin = 0
  let haloTime = 0
  let dustAngle = 0
  let breathPhase = (performance.now() % 4000) / 4000
  let ready = false
  let started = false
  // Moments: an energy spike (needs you) and a halo lift (finished work), each decaying on its own.
  let spike = 0
  let haloLift = 0
  function boost(level = 1.3) {
    spike = Math.max(spike, level - motion.level)
  }
  function land(kind: OrbPulseKind) {
    if (kind === "needsYou") boost(1.3)
    else if (kind === "done") haloLift = Math.max(haloLift, 0.4)
  }

  function render() {
    // Under reduced motion nothing advances: no ring spin, ripples, tilt or dolly.
    const delta = options.reducedMotion ? 0 : Math.min(clock.getDelta(), 0.05)
    elapsed += delta
    // Colours and motion ease toward their targets (time constant MOTION_TAU); a still scene jumps.
    const ease = options.reducedMotion ? 1 : 1 - Math.exp(-delta / MOTION_TAU)
    motion = easeMotion(motion, motionTarget, options.reducedMotion ? Infinity : delta)
    glow = options.reducedMotion ? target.glow : easeToward(glow, target.glow, delta)
    // A spike fades as exp(-2.5 t) (about 1.2 s); the halo lift in about 0.9 s.
    spike *= Math.exp(-delta * 2.5)
    haloLift *= Math.exp(-delta * 3.4)
    haloUniforms.uBoost.value = haloLift + glow
    if (deck && !options.reducedMotion) {
      // The halo breathes at the motion's depth and period. On the 4 s heartbeat its phase settles
      // onto the document clock (lib/heartbeat.ts), so it breathes with the page's dots.
      breathPhase = (breathPhase + (delta * 1000) / motion.period) % 1
      if (Math.abs(motion.period - 4000) < 40) {
        const beat = beatPhase()
        const drift = ((beat - breathPhase + 1.5) % 1) - 0.5
        breathPhase = (breathPhase + drift * (1 - Math.exp(-delta / MOTION_TAU)) + 1) % 1
      }
      haloUniforms.uBreath.value = motion.depth * (0.5 - 0.5 * Math.cos(2 * Math.PI * breathPhase))
    }
    orbUniforms.uC1.value.lerp(target.c1, ease)
    orbUniforms.uC2.value.lerp(target.c2, ease)
    orbUniforms.uC3.value.lerp(target.c3, ease)
    haloUniforms.uColor.value.lerp(target.c1, ease)
    haloUniforms.uColor2.value.lerp(target.c3, ease)
    // The plasma churns at the motion's rate (a landing's spike on top); the hero at its own pace.
    orbTime += delta * (deck ? motion.plasmaRate + spike * 0.9 : 1)
    if (deck) orbUniforms.uDisplace.value = motion.displacement
    // The orb's spin and the halo's swirl slow with the churn, so a calm core is still.
    const spin = Math.min(motion.plasmaRate + spike * 0.9, 1)
    orbSpin += delta * spin
    haloTime += delta * spin
    dustAngle += delta * motion.dust
    easeArcs(delta)
    orbUniforms.uTime.value = orbTime
    plasma?.update(orbTime)
    haloUniforms.uTime.value = deck ? haloTime : elapsed
    pointsUniforms.uTime.value = elapsed
    for (const hit of orbUniforms.uHits.value) if (hit.w >= 0) hit.w += delta
    if (!options.reducedMotion) updateSignals(elapsed)

    if (!options.reducedMotion) {
      pointer.x += (pointer.tx - pointer.x) * 0.04
      pointer.y += (pointer.ty - pointer.y) * 0.04
    }
    rig.rotation.y = pointer.x * (deck ? 0.12 : 0.22)
    rig.rotation.x = pointer.y * (deck ? 0.08 : 0.14)
    orb.rotation.y = (deck ? orbSpin : elapsed) * 0.06
    // Rings turn at the motion's speed on the deck (still when nothing moves); always on the hero.
    for (const ring of rings) ring.rotation.z += (ring.userData.speed as number) * delta * 6 * (deck ? motion.ringSpeed : 1)
    dust.rotation.y = deck ? dustAngle : elapsed * 0.012
    if (deck) {
      camera.position.set(0, 0, deckDistance)
      camera.lookAt(0, 0, 0)
    } else {
      const dolly = options.reducedMotion ? 0 : scroll
      camera.position.z = 9 + dolly * 2.2
      camera.position.y = -dolly * 1.2
      camera.lookAt(0, -dolly * 0.6, 0)
    }

    composer.render(delta)
    if (!ready) {
      ready = true
      options.onReady?.()
    }
  }

  // The deck draws at most 30 frames a second (it sits beside work being read); the hero keeps 60.
  // A resting deck (nothing moving, nothing landing, the pointer still) keeps drifting and breathing
  // at 20: its motions are slow enough that the frames between add nothing but GPU time.
  function lively() {
    if (motionTarget.mode === "moving" || activeSignals > 0 || spike > 0.02 || haloLift > 0.02) return true
    if (Math.abs(pointer.tx - pointer.x) + Math.abs(pointer.ty - pointer.y) > 0.002) return true
    if (orbUniforms.uHits.value.some((hit) => hit.w >= 0 && hit.w <= 2.4)) return true
    return flyingSlots(signals, elapsed).length > 0
  }
  let sinceFrame = Infinity
  let lastTick = 0
  function loop(time?: number) {
    if (disposed) return
    frame = requestAnimationFrame(loop)
    const now = time ?? performance.now()
    sinceFrame += now - (lastTick || now)
    lastTick = now
    const minFrame = deck ? 1000 / (lively() ? 30 : 20) - 2 : 0
    if (paused || sinceFrame < minFrame) return
    sinceFrame = 0
    render()
  }
  layout()
  resize.observe(canvas)

  // iOS drops contexts under memory pressure: hand over to the painted fallback.
  function onLost(event: Event) {
    event.preventDefault()
    paused = true
    options.onLost?.()
  }
  canvas.addEventListener("webglcontextlost", onLost)

  // Shaders compile off the main thread where the browser allows, so the copy's entrance never stalls.
  void renderer
    .compileAsync(scene, camera)
    .catch(() => undefined)
    .then(() => {
      if (disposed) return
      started = true
      clock.getDelta()
      if (options.reducedMotion) {
        // One still frame; a decorative stream parked mid-flight so the picture still tells the story
        // (Now's deck shows no comets: nothing just happened in a still frame).
        signals.forEach((signal, index) => {
          if (index < activeSignals) signal.start = -signal.duration * random(0.3, 0.85)
        })
        updateSignals(0)
        render()
      } else {
        loop()
      }
    })

  const raycaster = new THREE.Raycaster()
  const ndc = new THREE.Vector2()
  function hit(direction: THREE.Vector3, color: THREE.Color) {
    const slot = nextHit++ % MAX_HITS
    orbUniforms.uHits.value[slot]!.set(direction.x, direction.y, direction.z, 0)
    orbUniforms.uHitColors.value[slot]!.copy(color)
    if (options.reducedMotion && started) render()
  }

  return {
    setScroll(progress) {
      scroll = Math.min(Math.max(progress, 0), 1)
    },
    setTheme(next) {
      target.c1.copy(linear(next.colors[0]))
      target.c2.copy(linear(next.colors[1]))
      target.c3.copy(linear(next.colors[2]))
      target.glow = next.glow ?? 0
      if (options.reducedMotion && started) render()
    },
    setMotion(next) {
      motionTarget = next
      if (options.reducedMotion && started) render()
    },
    setSignals(next) {
      signalPalette = next.colors.length ? next.colors.map(linear) : palette
      const count = Math.min(Math.max(Math.round(next.count), 0), signalCount)
      // Wake resting slots at staggered moments; slots above the count finish their flight and rest.
      for (let s = activeSignals; s < count; s++) signals[s] = spawn(elapsed, random(0.2, 2.5))
      activeSignals = count
    },
    pulse(color, pulseOptions = {}) {
      if (options.reducedMotion) return false
      const kind = pulseOptions.kind ?? "activity"
      const { slot, displaced } = pickCometSlot(signals, elapsed)
      // Every slot busy: the one closest to landing lands now, so no update goes unreported.
      if (displaced) landSignal(signals[slot]!)
      const signal = spawn(elapsed, Math.max(pulseOptions.delay ?? 0, 0), pulseOptions.from)
      signal.color = linear(color)
      signal.duration = random(2.2, 3)
      signal.kind = kind
      signal.impact = pulseOptions.strength ?? kindImpact(kind)
      signal.size = pulseOptions.size ?? 1
      signal.trailScale = pulseOptions.trailScale ?? 1
      signal.onLand = pulseOptions.onLand
      signals[slot] = signal
      return true
    },
    boost,
    setArcs,
    touch(clientX, clientY) {
      const rect = canvas.getBoundingClientRect()
      if (!rect.width || !rect.height) return false
      ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
      raycaster.setFromCamera(ndc, camera)
      const found = raycaster.intersectObject(orb, false)[0]
      if (!found) return false
      // In the orb's own frame, so the ripple starts under the finger while the sphere spins.
      hit(orb.worldToLocal(found.point.clone()).normalize(), new THREE.Color(1.4, 1.4, 1.5))
      return true
    },
    setPaused(next) {
      paused = next
      if (!next) clock.getDelta()
    },
    dispose() {
      disposed = true
      cancelAnimationFrame(frame)
      resize.disconnect()
      window.removeEventListener("pointermove", onPointer)
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh
        mesh.geometry?.dispose()
        const material = mesh.material as THREE.Material | THREE.Material[] | undefined
        if (Array.isArray(material)) material.forEach((entry) => entry.dispose())
        else material?.dispose()
      })
      canvas.removeEventListener("webglcontextlost", onLost)
      // EffectComposer.dispose() leaves the passes' own targets and materials behind.
      bloom.dispose()
      output.dispose()
      plasma?.dispose()
      composer.dispose()
      // No forceContextLoss(): React can hand the same canvas to the next scene (Fast Refresh).
      renderer.dispose()
    },
  }
}
