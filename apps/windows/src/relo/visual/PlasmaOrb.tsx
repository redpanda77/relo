// Relo's orb: a WebGL (GLSL ES 1.00) port of ReloPlasmaOrb.metal (apps/notch/boringNotch/components/Relo/, itself the
// iPhone's shader) with the view of ReloOrb.swift: a sphere of slowly churning plasma in the palette of what matters now
// (coral while something needs you, cyan while work runs, blue when all is clear), a halo, a rim, a dark heart.
// Same math, uniforms and time base as the Metal source (`time` = seconds mod 3600, 9 with reduced motion);
// 30 frames a second at most, only while visible. The Mac's closed notch does not draw it (the closed wings are
// ReloOrbitWings); it is the orb of the home, onboarding and sign-in surfaces.

import { useEffect, useRef, useState } from "react"
import { useSettings } from "../../settings/store"
import { compile, hexRGB, webgl, type Program } from "./gl"
import { referenceSeconds } from "./ease"
import { ORB_ENERGY, ORB_PALETTE, type Mood } from "./theme"

export const PLASMA_FRAGMENT = `
precision highp float;
uniform vec2 u_size;
uniform float u_time;
uniform float u_energy;
uniform vec3 u_c0;
uniform vec3 u_c1;
uniform vec3 u_c2;
uniform vec3 u_c3;
uniform vec4 u_weights;
uniform vec2 u_touch;
uniform float u_touchAge;
varying vec2 v_uv;

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise2(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p, int octaves) {
  float value = 0.0, amplitude = 0.5;
  for (int octave = 0; octave < 4; octave++) {
    if (octave >= octaves) break;
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
  vec2 size = u_size;
  vec2 position = v_uv * size;
  float scale = min(size.x, size.y) * 0.5;
  vec2 uv = (position - size * 0.5) / scale;
  float time = u_time;
  float energy = u_energy;

  // A ripple from the last touch or event: a ring travelling outward that bends the plasma and lights it as it passes.
  float touchLight = 0.0;
  if (u_touchAge >= 0.0 && u_touchAge < 2.0) {
    vec2 t = (u_touch - size * 0.5) / scale;
    vec2 d = uv - t;
    float dist = length(d) + 1e-4;
    float front = u_touchAge * 1.6;
    float x = (dist - front) / 0.10;
    float band = exp(-(x * x)) * exp(-u_touchAge * 1.6);
    uv += d / dist * band * 0.08;
    touchLight = band;
  }

  // A slow ambient ripple from the heart every few seconds, so the core always breathes.
  float period = 5.5 - 2.0 * energy;
  float phase = fract(time / period);
  float centre = length(uv);
  float ax = (centre - phase * 0.8) / 0.045;
  float ambient = exp(-(ax * ax)) * (1.0 - phase) * (0.35 + 0.35 * energy);
  uv *= 1.0 - ambient * 0.03;

  const float radius = 0.66;
  float r = length(uv);

  // Halo outside the sphere, in the dominant color, fading to nothing.
  vec3 lead = ramp(0.0, u_c0, u_c1, u_c2, u_c3, u_weights);
  if (r > radius) {
    // Reaches exactly zero before the view's edge (r = 1). Metal's smoothstep(0.98, 0.78, r) is 1 - smoothstep(0.78, 0.98, r).
    float halo = exp(-(r - radius) * 7.0) * (0.22 + 0.22 * energy) * (1.0 - smoothstep(0.78, 0.98, r));
    gl_FragColor = vec4(lead * halo, halo);
    return;
  }

  // Sphere geometry: a normal from the disc, so the plasma wraps a volume.
  float z = sqrt(max(radius * radius - r * r, 0.0)) / radius;
  vec3 n = vec3(uv / radius, z);
  float speed = 0.05 + 0.07 * energy;
  vec2 flow = n.xy * 1.35 / (0.55 + z * 0.45) + vec2(time * speed, -time * speed * 0.6);

  // Domain-warped noise: the plasma folds over itself slowly.
  vec2 warp = vec2(fbm(flow + time * 0.07, 3), fbm(flow + vec2(5.2, 1.3) - time * 0.05, 3));
  float field = fbm(flow + 1.7 * warp, 4);

  // Sections by meaning: each color owns a slice of the sphere sized by its share, turning slowly with the surface.
  float longitude = atan(n.y, n.x) / 6.2831853 + 0.5 + time * (0.012 + 0.02 * energy);
  float sector = fract(longitude + (field - 0.5) * 0.22);
  vec3 plasma = ramp(sector, u_c0, u_c1, u_c2, u_c3, u_weights);
  // Within a section, the field shades between light and dark so it never looks flat.
  plasma *= 0.65 + 0.7 * field;

  // Bright filaments where the field folds; they carry the energy of the state.
  float filament = pow(1.0 - abs(fbm(flow * 2.0 + warp * 2.0, 3) * 2.0 - 1.0), 6.0);
  plasma += vec3(filament * (0.35 + 0.45 * energy));

  // Rim light, a soft key light from the top left, and a dark heart behind the count.
  float rim = pow(1.0 - z, 2.4);
  float key = clamp(dot(n, normalize(vec3(-0.45, -0.55, 0.7))), 0.0, 1.0);
  float heart = mix(0.38, 1.0, smoothstep(0.10, 0.62, r / radius));
  vec3 color = plasma * (0.30 + 0.55 * key) * heart + lead * (rim * 1.1);
  // Ripples light the plasma as they pass: the ambient one softly, a touch brightly.
  color += plasma * (ambient * 1.4) + vec3(touchLight * 0.55) + plasma * (touchLight * 1.2);

  // Antialiased edge (Metal's smoothstep(radius, radius - 0.012, r)).
  float edge = 1.0 - smoothstep(radius - 0.012, radius, r);
  float alpha = edge * (0.82 + 0.18 * rim);
  gl_FragColor = vec4(color * alpha, alpha);
}`

/** The cumulative weights ReloOrb passes (0.34, 0.67, 0.9, 1): three colors, the middle one repeated as the fourth. */
export const ORB_WEIGHTS: readonly [number, number, number, number] = [0.34, 0.67, 0.9, 1]

export function PlasmaOrb({ mood = "clear", size = 60, paused = false, className }: { mood?: Mood; size?: number; paused?: boolean; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const { settings } = useSettings()
  const reduce = settings.reduceMotion || (typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches)
  const palette = ORB_PALETTE[mood]
  // Bumped when the browser restores a lost context: the effect below builds the program again on it.
  const [epoch, setEpoch] = useState(0)

  // The canvas keeps one context for its whole life (a canvas whose context was released cannot get it back, which left
  // a white disc after a size or mood change): it is lost only when the orb leaves, or by the system, and restored then.
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const lost = (e: Event) => e.preventDefault()
    const restored = () => setEpoch((n) => n + 1)
    canvas.addEventListener("webglcontextlost", lost)
    canvas.addEventListener("webglcontextrestored", restored)
    return () => {
      canvas.removeEventListener("webglcontextlost", lost)
      canvas.removeEventListener("webglcontextrestored", restored)
      // Only when the orb really left (a development remount keeps its canvas, and with it the context).
      setTimeout(() => {
        if (!canvas.isConnected) webgl(canvas)?.getExtension("WEBGL_lose_context")?.loseContext()
      }, 0)
    }
  }, [])

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const gl = webgl(canvas)
    const program: Program | null = gl ? compile(gl, PLASMA_FRAGMENT) : null
    if (!gl || !program) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(size * dpr)
    canvas.height = Math.round(size * dpr)
    const c = [palette[0], palette[1], palette[2], palette[1]].map(hexRGB)
    let raf = 0
    let last = 0
    let visible = true
    const draw = (now: number) => {
      raf = 0
      if (gl.isContextLost()) return
      const time = reduce ? 9 : referenceSeconds(Date.now()) % 3600
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      program.use()
      gl.uniform2f(program.uniform("u_size"), canvas.width, canvas.height)
      gl.uniform1f(program.uniform("u_time"), time)
      gl.uniform1f(program.uniform("u_energy"), ORB_ENERGY[mood])
      c.forEach((v, i) => gl.uniform3f(program.uniform(`u_c${i}`), v[0], v[1], v[2]))
      gl.uniform4f(program.uniform("u_weights"), ...ORB_WEIGHTS)
      gl.uniform2f(program.uniform("u_touch"), 0, 0)
      gl.uniform1f(program.uniform("u_touchAge"), -1)
      program.draw()
      last = now
      schedule()
    }
    const schedule = () => {
      if (reduce || paused || !visible || document.hidden || raf) return
      raf = requestAnimationFrame((t) => (t - last >= 1000 / 30 - 1 ? draw(t) : (raf = 0, schedule())))
    }
    draw(0)
    const io = new IntersectionObserver((e) => {
      visible = e.some((x) => x.isIntersecting)
      schedule()
    })
    io.observe(canvas)
    const onVis = () => schedule()
    document.addEventListener("visibilitychange", onVis)
    return () => {
      cancelAnimationFrame(raf)
      io.disconnect()
      document.removeEventListener("visibilitychange", onVis)
      program.dispose()
    }
  }, [mood, size, reduce, paused, epoch]) // eslint-disable-line react-hooks/exhaustive-deps

  // ReloOrb.swift: clipShape(Circle()) and .shadow(color: palette[0].opacity(0.45), radius: 30).
  return (
    <span className={className} style={{ display: "inline-block", width: size, height: size, filter: `drop-shadow(0 0 30px ${palette[0]}73)` }} aria-hidden>
      <canvas ref={ref} style={{ width: size, height: size, borderRadius: "50%", display: "block", transition: "opacity 260ms ease-in-out" }} />
    </span>
  )
}
