/**
 * The Now core: a sphere of slowly churning plasma, a WebGL port of the iPhone app's
 * ReloPlasmaOrb.metal. Its colors are today's meanings in proportion (up to four, with
 * cumulative weights), lit by a rim, with a darker heart behind the count. A ripple from a
 * touch warps it. Output is premultiplied alpha.
 */

import { statePalette, type HudState } from "@/lib/hud-render"
import { SIGNAL_RAMP, mixShares, type NowMix, type RGB } from "@/lib/signal"

export type PlasmaStops = {
  /** Four colors, 0...1 per channel. */
  colors: [RGB, RGB, RGB, RGB]
  /** Cumulative stops, non-decreasing, ending at 1. */
  weights: [number, number, number, number]
}

const unit = (color: RGB): RGB => [color[0] / 255, color[1] / 255, color[2] / 255]

/** Up to four meanings by share with cumulative stops; the state palette when today is empty (ReloPlasmaOrb.colorStops). */
export function plasmaStops(mix: NowMix, state: HudState): PlasmaStops {
  const shares = mixShares(mix)
    .sort((a, b) => b.share - a.share)
    .slice(0, 4)
  if (!shares.length) {
    const palette = statePalette(state)
    return {
      colors: [unit(palette[0]!), unit(palette[1]!), unit(palette[2]!), unit(palette[1]!)],
      weights: [0.34, 0.67, 0.9, 1],
    }
  }
  const colors: RGB[] = shares.map((entry) => unit(SIGNAL_RAMP[entry.signal].light))
  let cumulative: number[] = []
  let running = 0
  for (const entry of shares) {
    running += entry.share
    cumulative.push(Math.min(running, 1))
  }
  // A single meaning still churns: its light and deep shades.
  if (colors.length === 1) {
    colors.push(unit(SIGNAL_RAMP[shares[0]!.signal].deep))
    cumulative = [0.55, 1]
  }
  while (colors.length < 4) {
    colors.push(colors[colors.length - 1]!)
    cumulative.push(1)
  }
  return {
    colors: colors as PlasmaStops["colors"],
    weights: cumulative as PlasmaStops["weights"],
  }
}

const VERTEX = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`

export const PLASMA_FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec2 uSize;      // CSS pixels
uniform float uRatio;    // device pixels per CSS pixel
uniform float uTime;
uniform float uEnergy;
uniform vec3 uC0;
uniform vec3 uC1;
uniform vec3 uC2;
uniform vec3 uC3;
uniform vec4 uWeights;
uniform vec2 uTouch;     // CSS pixels, top-left origin
uniform float uTouchAge; // seconds; negative when there is no touch

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.5;
  for (int octave = 0; octave < 5; octave++) {
    value += amplitude * noise2(p);
    p = p * 2.03 + vec2(17.1, 9.2);
    amplitude *= 0.5;
  }
  return value;
}

// Blend through up to four colors at cumulative stops w.x <= w.y <= w.z <= 1.
vec3 ramp(float t, vec3 c0, vec3 c1, vec3 c2, vec3 c3, vec4 w) {
  float soft = 0.06;
  vec3 color = c0;
  color = mix(color, c1, smoothstep(w.x - soft, w.x + soft, t));
  color = mix(color, c2, smoothstep(w.y - soft, w.y + soft, t));
  color = mix(color, c3, smoothstep(w.z - soft, w.z + soft, t));
  return color;
}

void main() {
  vec2 position = vec2(gl_FragCoord.x, uSize.y * uRatio - gl_FragCoord.y) / uRatio;
  float scale = min(uSize.x, uSize.y) * 0.5;
  vec2 uv = (position - uSize * 0.5) / scale;

  // A ripple from the last touch: a ring travelling outward that bends the plasma.
  if (uTouchAge >= 0.0 && uTouchAge < 2.0) {
    vec2 t = (uTouch - uSize * 0.5) / scale;
    vec2 d = uv - t;
    float dist = length(d) + 1e-4;
    float front = uTouchAge * 1.6;
    float offset = (dist - front) / 0.12;
    float band = exp(-(offset * offset)) * exp(-uTouchAge * 1.8);
    uv += d / dist * band * 0.07;
  }

  const float radius = 0.66;
  float r = length(uv);

  // Halo outside the sphere, in the dominant color, fading to nothing.
  vec3 lead = ramp(0.0, uC0, uC1, uC2, uC3, uWeights);
  if (r > radius) {
    float halo = exp(-(r - radius) * 7.0) * (0.22 + 0.22 * uEnergy);
    gl_FragColor = vec4(lead * halo, halo);
    return;
  }

  // Sphere geometry: a normal from the disc, so the plasma wraps a volume.
  float z = sqrt(max(radius * radius - r * r, 0.0)) / radius;
  vec3 n = vec3(uv / radius, z);
  float speed = 0.05 + 0.07 * uEnergy;
  vec2 flow = n.xy * 1.35 / (0.55 + z * 0.45) + vec2(uTime * speed, -uTime * speed * 0.6);

  // Domain-warped noise: the plasma folds over itself slowly.
  vec2 warp = vec2(fbm(flow + uTime * 0.07), fbm(flow + vec2(5.2, 1.3) - uTime * 0.05));
  float field = fbm(flow + 1.7 * warp);
  vec3 plasma = ramp(clamp(field * 1.25 - 0.12, 0.0, 1.0), uC0, uC1, uC2, uC3, uWeights);

  // Bright filaments where the field folds; they carry the energy of the state.
  float filament = pow(max(1.0 - abs(fbm(flow * 2.0 + warp * 2.0) * 2.0 - 1.0), 0.0), 6.0);
  plasma += vec3(filament * (0.35 + 0.45 * uEnergy));

  // Rim light, a soft key light from the top left, and a dark heart behind the count.
  float rim = pow(max(1.0 - z, 0.0), 2.4);
  float key = clamp(dot(n, normalize(vec3(-0.45, -0.55, 0.7))), 0.0, 1.0);
  float heart = mix(0.38, 1.0, smoothstep(0.10, 0.62, r / radius));
  vec3 color = plasma * (0.30 + 0.55 * key) * heart + lead * (rim * 1.1);

  // Antialiased edge (smoothstep(radius, radius - 0.012, r) with its edges in order).
  float edge = 1.0 - smoothstep(radius - 0.012, radius, r);
  float alpha = edge * (0.82 + 0.18 * rim);
  gl_FragColor = vec4(color * alpha, alpha);
}
`

export type PlasmaFrame = {
  /** Seconds of animation. */
  time: number
  energy: number
  stops: PlasmaStops
  /** The latest touch, in this canvas's own CSS pixels, and its age in seconds (negative: none). */
  touch: { x: number; y: number }
  touchAge: number
}

const UNIFORMS = ["uSize", "uRatio", "uTime", "uEnergy", "uC0", "uC1", "uC2", "uC3", "uWeights", "uTouch", "uTouchAge"] as const

function compile(gl: WebGLRenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)
  if (!shader) return null
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader)
    return null
  }
  return shader
}

/** Draws the plasma core into its own canvas. `create` returns null when WebGL is unavailable. */
export class PlasmaOrb {
  private gl: WebGLRenderingContext
  private program: WebGLProgram
  private buffer: WebGLBuffer | null
  private uniforms: Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>
  private width = 0
  private height = 0
  lost = false

  private canvas: HTMLCanvasElement
  private onLost: () => void

  private constructor(canvas: HTMLCanvasElement, gl: WebGLRenderingContext, program: WebGLProgram, onLost: () => void) {
    this.canvas = canvas
    this.onLost = onLost
    this.gl = gl
    this.program = program
    this.uniforms = Object.fromEntries(UNIFORMS.map((name) => [name, gl.getUniformLocation(program, name)])) as PlasmaOrb["uniforms"]
    this.buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const position = gl.getAttribLocation(program, "aPos")
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    gl.useProgram(program)
    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)
    canvas.addEventListener("webglcontextlost", this.handleLost)
  }

  static create(canvas: HTMLCanvasElement, onLost: () => void): PlasmaOrb | null {
    let gl: WebGLRenderingContext | null
    try {
      gl = canvas.getContext("webgl", {
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: false,
        powerPreference: "low-power",
      }) as WebGLRenderingContext | null
    } catch {
      return null
    }
    if (!gl) return null
    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX)
    const fragment = compile(gl, gl.FRAGMENT_SHADER, PLASMA_FRAGMENT)
    const program = gl.createProgram()
    if (!vertex || !fragment || !program) return null
    gl.attachShader(program, vertex)
    gl.attachShader(program, fragment)
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null
    return new PlasmaOrb(canvas, gl, program, onLost)
  }

  private handleLost = (event: Event) => {
    event.preventDefault()
    this.lost = true
    this.onLost()
  }

  /** Sets the drawing buffer for a square-or-not CSS size at the device pixel ratio. */
  resize(width: number, height: number, ratio: number) {
    this.width = width
    this.height = height
    this.canvas.width = Math.max(1, Math.round(width * ratio))
    this.canvas.height = Math.max(1, Math.round(height * ratio))
    this.canvas.style.width = `${width}px`
    this.canvas.style.height = `${height}px`
  }

  draw(frame: PlasmaFrame) {
    if (this.lost || !this.width) return
    const { gl, uniforms: u } = this
    const { stops } = frame
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.uniform2f(u.uSize, this.width, this.height)
    gl.uniform1f(u.uRatio, this.canvas.width / this.width)
    gl.uniform1f(u.uTime, frame.time)
    gl.uniform1f(u.uEnergy, frame.energy)
    gl.uniform3f(u.uC0, ...stops.colors[0])
    gl.uniform3f(u.uC1, ...stops.colors[1])
    gl.uniform3f(u.uC2, ...stops.colors[2])
    gl.uniform3f(u.uC3, ...stops.colors[3])
    gl.uniform4f(u.uWeights, ...stops.weights)
    gl.uniform2f(u.uTouch, frame.touch.x, frame.touch.y)
    gl.uniform1f(u.uTouchAge, frame.touchAge)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
  }

  dispose() {
    this.canvas.removeEventListener("webglcontextlost", this.handleLost)
    if (this.lost) return
    this.gl.deleteBuffer(this.buffer)
    this.gl.deleteProgram(this.program)
  }
}
