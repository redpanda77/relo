// The closed notch's wing light, moving. A WebGL (GLSL ES 1.00) port of ReloWingLight.metal: the band of the state's
// colour modulated by slow noise that flows from the notch's outer edges toward the camera. It is applied to the light
// layer only (the 2D painter draws the gradients into an offscreen canvas, this pass multiplies them, the painter
// composites the result with plus-lighter), so the orbit, the bar and the chips stay crisp.
//
// Same math, uniforms (size in points, time in seconds) and time base as the Metal source:
//   reloWingLight(position, color, size, time):
//     fromEdge = min(position.x, size.x - position.x)
//     q = (fromEdge * 0.05 - time * 0.42, position.y * 0.11 + time * 0.06)
//     return color * (0.45 + 1.1 * wingFbm(q))
// Metal's `color` is premultiplied, so the factor scales alpha too; so does this pass on a premultiplied texture.

import { compile, webgl, type Program } from "./gl"

export const WING_LIGHT_FRAGMENT = `
precision highp float;
uniform sampler2D u_tex;
uniform vec2 u_size;
uniform float u_time;
varying vec2 v_uv;

float wingHash(vec2 p) {
  p = fract(p * vec2(127.1, 311.7));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float wingNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(wingHash(i), wingHash(i + vec2(1.0, 0.0)), u.x),
             mix(wingHash(i + vec2(0.0, 1.0)), wingHash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float wingFbm(vec2 p) {
  float value = 0.0, amplitude = 0.5;
  for (int octave = 0; octave < 3; octave++) {
    value += amplitude * wingNoise(p);
    p = p * 2.07 + vec2(13.7, 5.3);
    amplitude *= 0.5;
  }
  return value;
}

void main() {
  vec2 position = v_uv * u_size;
  float fromEdge = min(position.x, u_size.x - position.x);
  vec2 q = vec2(fromEdge * 0.05 - u_time * 0.42, position.y * 0.11 + u_time * 0.06);
  gl_FragColor = texture2D(u_tex, v_uv) * (0.45 + 1.1 * wingFbm(q));
}`

/** CPU reference of the same factor, for tests (and a fallback that needs no GL). */
export function wingLightFactor(x: number, y: number, width: number, time: number): number {
  const fract = (v: number) => v - Math.floor(v)
  const hash = (px: number, py: number) => {
    let x1 = fract(px * 127.1)
    let y1 = fract(py * 311.7)
    const d = x1 * (x1 + 34.23) + y1 * (y1 + 34.23)
    x1 += d
    y1 += d
    return fract(x1 * y1)
  }
  const mix = (a: number, b: number, t: number) => a + (b - a) * t
  const noise = (px: number, py: number) => {
    const ix = Math.floor(px), iy = Math.floor(py)
    const fx = px - ix, fy = py - iy
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy)
    return mix(mix(hash(ix, iy), hash(ix + 1, iy), ux), mix(hash(ix, iy + 1), hash(ix + 1, iy + 1), ux), uy)
  }
  let px = Math.min(x, width - x) * 0.05 - time * 0.42
  let py = y * 0.11 + time * 0.06
  let value = 0
  let amplitude = 0.5
  for (let o = 0; o < 3; o++) {
    value += amplitude * noise(px, py)
    const nx = px * 2.07 + 13.7
    const ny = py * 2.07 + 5.3
    px = nx
    py = ny
    amplitude *= 0.5
  }
  return 0.45 + 1.1 * value
}

/** The pass: upload the light layer, shade it, hand back a canvas to composite. Null when WebGL is not available. */
export class WingLightPass {
  readonly canvas: HTMLCanvasElement
  private gl: WebGLRenderingContext | null
  private program: Program | null = null
  private texture: WebGLTexture | null = null

  constructor() {
    this.canvas = document.createElement("canvas")
    this.gl = webgl(this.canvas)
    if (this.gl) {
      this.program = compile(this.gl, WING_LIGHT_FRAGMENT)
      this.texture = this.gl.createTexture()
    }
  }

  get available(): boolean {
    return this.program !== null && !this.gl?.isContextLost()
  }

  /** `source` is the premultiplied light layer, `size` its size in points; time is the wing time (mod 1000). */
  shade(source: HTMLCanvasElement, size: { w: number; h: number }, time: number): HTMLCanvasElement | null {
    const { gl, program, texture } = this
    if (!gl || !program || !texture || gl.isContextLost()) return null
    if (this.canvas.width !== source.width || this.canvas.height !== source.height) {
      this.canvas.width = source.width
      this.canvas.height = source.height
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    program.use()
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.uniform1i(program.uniform("u_tex"), 0)
    gl.uniform2f(program.uniform("u_size"), size.w, size.h)
    gl.uniform1f(program.uniform("u_time"), time)
    program.draw()
    return this.canvas
  }

  dispose(): void {
    this.gl?.getExtension("WEBGL_lose_context")?.loseContext()
    this.gl = null
    this.program = null
  }
}
