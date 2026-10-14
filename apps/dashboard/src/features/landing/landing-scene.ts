/**
 * The landing hero: many agents, one calm core. A plasma sphere in the meaning colours sits inside
 * slow instrument rings; signals stream in from the dark along curved paths, each in the colour of
 * what it reports (running, done, needs you, message), and land on the core as a ripple. Dust drifts
 * around it. The pointer tilts the whole instrument; scrolling only eases it back (no scroll story).
 */

import * as THREE from "three"
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js"
import { OutputPass } from "three/addons/postprocessing/OutputPass.js"
import { RenderPass } from "three/addons/postprocessing/RenderPass.js"
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js"

export type LandingScene = {
  /** 0 at the top of the page, 1 once the hero has scrolled away. */
  setScroll(progress: number): void
  setPaused(paused: boolean): void
  dispose(): void
}

const MEANING = ["#5ce1ff", "#34d399", "#ff8a3d", "#8b7cff", "#d65cf0"] as const
const MAX_HITS = 6

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
varying vec3 vNormal;
varying vec3 vObject;
varying vec3 vView;
${NOISE}
void main() {
  vec3 p = position;
  float n = snoise(normalize(p) * 1.8 + vec3(uTime * 0.18));
  p += normal * n * 0.035;
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
${NOISE}
void main() {
  vec3 p = vObject;
  float t = uTime * 0.07;
  vec3 warp = vec3(
    fbm(p * 0.85 + vec3(t, -t * 0.8, t * 0.6)),
    fbm(p * 0.85 + vec3(5.2, 1.3, 2.8) - t),
    fbm(p * 0.85 + vec3(1.7, 9.2, 4.1) + t * 0.5));
  float field = fbm(p * 1.15 + warp * 1.9);
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
varying vec2 vUv;
void main() {
  vec2 c = vUv - 0.5;
  float r = length(c) * 2.0;
  float a = atan(c.y, c.x);
  float glow = exp(-max(r - 0.32, 0.0) * 7.0) * smoothstep(1.0, 0.5, r);
  vec3 color = mix(uColor, uColor2, 0.5 + 0.5 * sin(a * 2.0 + uTime * 0.25));
  gl_FragColor = vec4(color * glow * 0.11, 1.0);
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

export function createLandingScene(
  canvas: HTMLCanvasElement,
  options: { reducedMotion: boolean; onReady?: () => void; onLost?: () => void }
): LandingScene {
  const compact = window.matchMedia("(max-width: 767px)").matches
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
  })
  const pixelRatio = Math.min(window.devicePixelRatio || 1, compact ? 1.5 : 1.75)
  renderer.setPixelRatio(pixelRatio)

  const scene = new THREE.Scene()
  // The ink canvas, colour-managed like everything else (a raw clear colour would be encoded twice).
  scene.background = linear("#08080d")
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100)
  camera.position.set(0, 0, 9)

  // Everything that tilts with the pointer.
  const rig = new THREE.Group()
  scene.add(rig)
  const core = new THREE.Group()
  rig.add(core)

  const palette = MEANING.map(linear)

  const orbUniforms = {
    uTime: { value: 0 },
    uC0: { value: linear("#14123a") },
    uC1: { value: linear("#5ce1ff") },
    uC2: { value: linear("#8b7cff") },
    uC3: { value: linear("#d65cf0") },
    uHits: { value: Array.from({ length: MAX_HITS }, () => new THREE.Vector4(0, 0, 1, -1)) },
    uHitColors: { value: Array.from({ length: MAX_HITS }, () => new THREE.Color()) },
  }
  const orb = new THREE.Mesh(
    new THREE.SphereGeometry(1.25, compact ? 96 : 160, compact ? 96 : 160),
    new THREE.ShaderMaterial({
      uniforms: orbUniforms,
      vertexShader: ORB_VERTEX,
      fragmentShader: ORB_FRAGMENT,
    })
  )
  core.add(orb)

  const haloUniforms = {
    uColor: { value: linear("#5ce1ff") },
    uColor2: { value: linear("#d65cf0") },
    uTime: { value: 0 },
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

  // Signals: comets with trails, from the dark to the core.
  const signalCount = compact ? 9 : 16
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
  function spawn(now: number, delay: number): Signal {
    // Land on the visible face, so every impact reads as a hit rather than a pass behind the edge.
    const target = new THREE.Vector3(random(-0.85, 0.85), random(-0.6, 0.6), random(0.55, 1)).normalize()
    const angle = random(0, Math.PI * 2)
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
      color: palette[Math.floor(random(0, palette.length))]!.clone(),
      start: now + delay,
      duration: random(3.2, 6),
      target,
    }
  }
  const signals: Signal[] = Array.from({ length: signalCount }, (_, i) => spawn(0, i * random(0.3, 0.9)))
  let nextHit = 0
  const point = new THREE.Vector3()
  const hitPoint = new THREE.Vector3()

  function updateSignals(now: number) {
    for (let s = 0; s < signals.length; s++) {
      const signal = signals[s]!
      const raw = (now - signal.start) / signal.duration
      for (let i = 0; i < trail; i++) {
        const index = s * trail + i
        const t = Math.pow(Math.min(Math.max(raw, 0), 1), 1.7) - i * 0.0075
        if (raw <= 0 || t < 0 || raw >= 1) {
          signalAlpha[index] = 0
          continue
        }
        signal.curve.getPoint(t, point)
        signalPositions.set([point.x, point.y, point.z], index * 3)
        const fade = 1 - i / trail
        signalAlpha[index] = fade * fade * Math.min(raw * 5, 1)
        signalSize[index] = i === 0 ? 11 : 6 * fade + 0.8
        signalColor.set([signal.color.r, signal.color.g, signal.color.b], index * 3)
      }
      if (raw >= 1) {
        const slot = nextHit++ % MAX_HITS
        // The orb spins inside the core: express the impact in its own frame so the ripple starts where the comet hit.
        hitPoint.copy(signal.target).applyAxisAngle(up, -orb.rotation.y)
        orbUniforms.uHits.value[slot]!.set(hitPoint.x, hitPoint.y, hitPoint.z, 0)
        orbUniforms.uHitColors.value[slot]!.copy(signal.color)
        signals[s] = spawn(now, random(0.2, 2.4))
      }
    }
    signalGeometry.attributes.position!.needsUpdate = true
    signalGeometry.attributes.aAlpha!.needsUpdate = true
    signalGeometry.attributes.aSize!.needsUpdate = true
    signalGeometry.attributes.aColor!.needsUpdate = true
  }

  const composer = new EffectComposer(renderer)
  composer.setPixelRatio(pixelRatio)
  composer.addPass(new RenderPass(scene, camera))
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), compact ? 0.65 : 0.8, 0.12, 0.42)
  composer.addPass(bloom)
  const output = new OutputPass()
  composer.addPass(output)

  // The core sits right of the copy on wide screens and above it on phones.
  function layout() {
    const width = canvas.clientWidth || window.innerWidth
    const height = canvas.clientHeight || window.innerHeight
    renderer.setSize(width, height, false)
    composer.setSize(width, height)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
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
  let ready = false
  let started = false

  function render() {
    // Under reduced motion nothing advances: no ring spin, ripples, tilt or dolly.
    const delta = options.reducedMotion ? 0 : Math.min(clock.getDelta(), 0.05)
    elapsed += delta
    orbUniforms.uTime.value = elapsed
    haloUniforms.uTime.value = elapsed
    pointsUniforms.uTime.value = elapsed
    for (const hit of orbUniforms.uHits.value) if (hit.w >= 0) hit.w += delta
    if (!options.reducedMotion) updateSignals(elapsed)

    if (!options.reducedMotion) {
      pointer.x += (pointer.tx - pointer.x) * 0.04
      pointer.y += (pointer.ty - pointer.y) * 0.04
    }
    rig.rotation.y = pointer.x * 0.22
    rig.rotation.x = pointer.y * 0.14
    orb.rotation.y = elapsed * 0.06
    for (const ring of rings) ring.rotation.z += (ring.userData.speed as number) * delta * 6
    dust.rotation.y = elapsed * 0.012
    const dolly = options.reducedMotion ? 0 : scroll
    camera.position.z = 9 + dolly * 2.2
    camera.position.y = -dolly * 1.2
    camera.lookAt(0, -dolly * 0.6, 0)

    composer.render(delta)
    if (!ready) {
      ready = true
      options.onReady?.()
    }
  }

  function loop() {
    if (disposed) return
    frame = requestAnimationFrame(loop)
    if (!paused) render()
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
        // One still frame; signals parked mid-flight so the picture still tells the story.
        for (const signal of signals) signal.start = -signal.duration * random(0.3, 0.85)
        updateSignals(0)
        render()
      } else {
        loop()
      }
    })

  return {
    setScroll(progress) {
      scroll = Math.min(Math.max(progress, 0), 1)
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
      composer.dispose()
      // No forceContextLoss(): React can hand the same canvas to the next scene (Fast Refresh).
      renderer.dispose()
    },
  }
}
