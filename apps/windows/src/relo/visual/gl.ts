// A tiny WebGL helper: one full-screen triangle, a compiled program, uniforms by name. Used by the wing light and the
// plasma orb (no three.js: the Mac's shaders are two small fragment programs).

export const FULLSCREEN_VERTEX = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  // v_uv is (0,0) at the top left, like Metal's pixel position / size.
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`

export interface Program {
  gl: WebGLRenderingContext
  use(): void
  uniform(name: string): WebGLUniformLocation | null
  draw(): void
  /** Frees the program and its buffer; the context itself stays usable (a canvas that lost its context cannot get it back). */
  dispose(): void
}

export function compile(gl: WebGLRenderingContext, fragment: string): Program | null {
  const shader = (type: number, source: string): WebGLShader | null => {
    const s = gl.createShader(type)
    if (!s) return null
    gl.shaderSource(s, source)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.warn("[relo] shader:", gl.getShaderInfoLog(s))
      return null
    }
    return s
  }
  const vs = shader(gl.VERTEX_SHADER, FULLSCREEN_VERTEX)
  const fs = shader(gl.FRAGMENT_SHADER, fragment)
  const program = gl.createProgram()
  if (!vs || !fs || !program) return null
  gl.attachShader(program, vs)
  gl.attachShader(program, fs)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn("[relo] program:", gl.getProgramInfoLog(program))
    return null
  }
  const buffer = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const cache = new Map<string, WebGLUniformLocation | null>()
  return {
    gl,
    use() {
      gl.useProgram(program)
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
      const loc = gl.getAttribLocation(program, "a_pos")
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    },
    uniform(name) {
      if (!cache.has(name)) cache.set(name, gl.getUniformLocation(program, name))
      return cache.get(name) ?? null
    },
    dispose() {
      gl.deleteProgram(program)
      gl.deleteBuffer(buffer)
    },
    draw() {
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },
  }
}

export function webgl(canvas: HTMLCanvasElement | OffscreenCanvas): WebGLRenderingContext | null {
  try {
    return (canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: "low-power" }) as WebGLRenderingContext | null) ?? null
  } catch {
    return null
  }
}

/** "#rrggbb" to 0...1 components. */
export function hexRGB(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}
