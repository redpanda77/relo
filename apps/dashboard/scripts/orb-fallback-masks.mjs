#!/usr/bin/env node
/**
 * Writes the painted core's masks (src/assets/orb-fallback/*.webp): the WebGL core's plasma
 * (lib/orb-scene.ts, lib/orb-plasma.ts) evaluated once, on the hemisphere facing the camera, as
 * alpha masks of each colour band, the shading and the veins. index.css stacks one layer per mask
 * in the stage's own colours (--orb-1...3), in the shader's mixing order, so the core without WebGL
 * (and while the scene loads) is the same plasma in any state's colours. Run after changing the
 * field or its colour ramp: node scripts/orb-fallback-masks.mjs (needs cwebp).
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { deflateSync } from "node:zlib"

const SIZE = 256
const OUT = join(dirname(fileURLToPath(import.meta.url)), "../src/assets/orb-fallback")

// The GLSL simplex noise (Ashima Arts), line for line.
const mod289 = (x) => x - Math.floor(x / 289) * 289
const permute = (x) => mod289((x * 34 + 1) * x)
function snoise(vx, vy, vz) {
  const s = (vx + vy + vz) / 3
  const ix = Math.floor(vx + s), iy = Math.floor(vy + s), iz = Math.floor(vz + s)
  const t = (ix + iy + iz) / 6
  const x0 = [vx - ix + t, vy - iy + t, vz - iz + t]
  const g = [x0[1] <= x0[0] ? 1 : 0, x0[2] <= x0[1] ? 1 : 0, x0[0] <= x0[2] ? 1 : 0]
  const l = g.map((v) => 1 - v)
  const i1 = [Math.min(g[0], l[2]), Math.min(g[1], l[0]), Math.min(g[2], l[1])]
  const i2 = [Math.max(g[0], l[2]), Math.max(g[1], l[0]), Math.max(g[2], l[1])]
  const x1 = x0.map((v, k) => v - i1[k] + 1 / 6)
  const x2 = x0.map((v, k) => v - i2[k] + 1 / 3)
  const x3 = x0.map((v) => v - 0.5)
  const mx = mod289(ix), my = mod289(iy), mz = mod289(iz)
  const offs = (k) => [0, i1[k], i2[k], 1]
  const pz = offs(2).map((o) => permute(mz + o))
  const py = pz.map((v, n) => permute(v + my + offs(1)[n]))
  const p = py.map((v, n) => permute(v + mx + offs(0)[n]))
  const ns = [2 / 7, -13 / 14, 1 / 7]
  const grads = p.map((pv) => {
    const j = pv - 49 * Math.floor(pv * ns[2] * ns[2])
    const xx = Math.floor(j * ns[2])
    const yy = Math.floor(j - 7 * xx)
    const gx = xx * ns[0] + ns[1]
    const gy = yy * ns[0] + ns[1]
    const h = 1 - Math.abs(gx) - Math.abs(gy)
    const sx = Math.floor(gx) * 2 + 1, sy = Math.floor(gy) * 2 + 1
    const sh = h <= 0 ? -1 : 0
    const v = [gx + sx * sh, gy + sy * sh, h]
    const r = 1.79284291400159 - 0.85373472095314 * (v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
    return v.map((c) => c * r)
  })
  let sum = 0
  for (const [k, x] of [x0, x1, x2, x3].entries()) {
    const m = Math.max(0.6 - (x[0] * x[0] + x[1] * x[1] + x[2] * x[2]), 0)
    const gr = grads[k]
    sum += m * m * m * m * (gr[0] * x[0] + gr[1] * x[1] + gr[2] * x[2])
  }
  return 42 * sum
}
function fbm(x, y, z) {
  let value = 0, amplitude = 0.5
  for (let octave = 0; octave < 4; octave++) {
    value += amplitude * snoise(x, y, z)
    x = x * 2.02 + 11.7; y = y * 2.02 + 3.1; z = z * 2.02 + 7.9
    amplitude *= 0.5
  }
  return value
}
/** lib/orb-plasma.ts PLASMA_FIELD at time 0. */
function plasmaField(x, y, z) {
  const wx = fbm(x * 0.85, y * 0.85, z * 0.85)
  const wy = fbm(x * 0.85 + 5.2, y * 0.85 + 1.3, z * 0.85 + 2.8)
  const wz = fbm(x * 0.85 + 1.7, y * 0.85 + 9.2, z * 0.85 + 4.1)
  return fbm(x * 1.15 + wx * 1.9, y * 1.15 + wy * 1.9, z * 1.15 + wz * 1.9)
}
const clamp01 = (v) => Math.min(Math.max(v, 0), 1)
const smoothstep = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t) }

// One mask per layer, from ORB_FRAGMENT: the three colour bands, the shading (dark where the plasma
// is low and in the heart), and the veins where the field crosses zero.
const masks = { band1: [], band2: [], band3: [], shade: [], vein: [] }
for (let row = 0; row < SIZE; row++) {
  for (let col = 0; col < SIZE; col++) {
    const x = ((col + 0.5) / SIZE) * 2 - 1
    const y = 1 - ((row + 0.5) / SIZE) * 2
    const r2 = x * x + y * y
    if (r2 >= 1) { for (const list of Object.values(masks)) list.push(0); continue }
    const z = Math.sqrt(1 - r2)
    const field = plasmaField(x, y, z)
    const f = clamp01(field * 0.6 + 0.5)
    const facing = z
    const heart = 0.55 + 0.45 * smoothstep(0.55, 0, facing - 0.35)
    masks.band1.push(smoothstep(0.2, 0.5, f))
    masks.band2.push(smoothstep(0.5, 0.72, f))
    masks.band3.push(smoothstep(0.78, 0.95, f) * 0.8)
    // The shader shades in linear light and the layers mix in sRGB; 1/1.6 matches the scene by eye
    // (bloom and the output curve sit between the two).
    masks.shade.push(1 - Math.pow(clamp01((0.08 + 0.75 * f * f) * heart), 1 / 1.6))
    masks.vein.push(Math.pow(1 - Math.abs(field - 0.05), 22) * heart)
  }
}

// A white PNG whose alpha is the mask (alpha masks work in every engine), then WebP.
function crc32(bytes) {
  let c, crc = 0xffffffff
  for (const b of bytes) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0); out.write(type, 4, "ascii"); data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}
function png(values) {
  const stride = SIZE * 2 + 1
  const raw = Buffer.alloc(SIZE * stride)
  for (let row = 0; row < SIZE; row++) for (let col = 0; col < SIZE; col++) {
    raw[row * stride + 1 + col * 2] = 255
    raw[row * stride + 2 + col * 2] = Math.round(clamp01(values[row * SIZE + col]) * 255)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(SIZE, 0); header.writeUInt32BE(SIZE, 4); header[8] = 8; header[9] = 4
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))])
}
const scratch = mkdtempSync(join(tmpdir(), "orb-masks-"))
for (const [name, values] of Object.entries(masks)) {
  const source = join(scratch, `${name}.png`)
  writeFileSync(source, png(values))
  execFileSync("cwebp", ["-quiet", "-q", "80", "-alpha_q", "50", "-m", "6", "-exact", source, "-o", join(OUT, `${name}.webp`)])
}
console.log(`wrote ${Object.keys(masks).length} masks to ${OUT}`)
