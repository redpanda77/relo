// The instrument ring around the sphere: a port of ReloHoloRing (apps/ios/Sources/ReloApp/ReloHoloHUD.swift draw()):
// 120 hairline ticks turning slowly with a light sweeping past, one hairline inside them, one luminous arc per running
// task (its real progress, or a travelling arc) with a glowing head, and an idle comet on the hairline when no task runs.
// A canvas of 256 iPhone points, drawn at 30 frames a second, still (one frame) with Reduce Motion or when paused.

import { useEffect, useRef } from "react"
import { HOLO } from "./deck"

type Mood = "needsYou" | "running" | "clear"

const ACCENT: Record<Mood, string> = { clear: HOLO.blue, running: HOLO.cyan, needsYou: HOLO.orange }
const SPEED: Record<Mood, number> = { clear: 0.4, running: 1, needsYou: 1.5 }
/** ReloHoloTheme.taskRamp. */
const RAMPS = [
  [HOLO.cyan, HOLO.blue, HOLO.cyan],
  [HOLO.sky, HOLO.azure, HOLO.blue],
  [HOLO.blue, HOLO.cyan, HOLO.sky],
  [HOLO.azure, HOLO.sky, HOLO.cyan],
]

const rgba = (hex: string, a: number): string => {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`
}

export function HoloRing({ mood, progress, still }: { mood: Mood; /** One entry per running card: its progress 0...1, or null. */ progress: (number | null)[]; still: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const latest = useRef({ mood, progress })
  latest.current = { mood, progress }

  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext("2d")
    if (!canvas || !ctx) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const px = 256 * dpr
    canvas.width = px
    canvas.height = px
    let raf = 0
    let last = 0
    const draw = (t: number) => {
      const { mood: m, progress: tasks } = latest.current
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, 256, 256)
      const c = 128
      const outer = 126
      const accent = ACCENT[m]
      const speed = SPEED[m]
      const pt = (r: number, deg: number): [number, number] => [c + r * Math.cos((deg * Math.PI) / 180), c + r * Math.sin((deg * Math.PI) / 180)]
      const arc = (r: number, a: number, b: number) => {
        ctx.beginPath()
        ctx.arc(c, c, r, (a * Math.PI) / 180, (b * Math.PI) / 180)
      }
      const turn = t * 3 * speed
      const sweep = (t * 40 * speed) % 360
      for (let i = 0; i < 120; i++) {
        const angle = i * 3 + turn
        const major = i % 10 === 0
        const distance = Math.abs((((angle - sweep) % 360) + 540) % 360 - 180)
        const lit = Math.max(0, 1 - distance / 50)
        const [x0, y0] = pt(outer - (major ? 7 : 3.5), angle)
        const [x1, y1] = pt(outer, angle)
        ctx.beginPath()
        ctx.moveTo(x0, y0)
        ctx.lineTo(x1, y1)
        ctx.strokeStyle = lit > 0 ? rgba(accent, 0.25 + 0.65 * lit) : `rgba(255,255,255,${major ? 0.34 : 0.13})`
        ctx.lineWidth = major ? 0.9 : 0.5
        ctx.stroke()
      }
      const hairline = outer - 11
      arc(hairline, 0, 360)
      ctx.strokeStyle = rgba(accent, 0.55)
      ctx.lineWidth = 0.6
      ctx.stroke()
      const shown = tasks.slice(0, 3)
      shown.forEach((progress, index) => {
        const radius = hairline - 7 - index * 6
        arc(radius, 0, 360)
        ctx.strokeStyle = "rgba(255,255,255,0.07)"
        ctx.lineWidth = 1.2
        ctx.stroke()
        let start: number
        let end: number
        if (progress !== null) {
          start = -90
          end = -90 + Math.max(0.015, Math.min(1, progress)) * 360
        } else {
          start = -90 + t * 70 * speed + index * 120
          end = start + 64
        }
        const ramp = RAMPS[index % RAMPS.length]!
        ctx.lineCap = "round"
        arc(radius, start, end)
        ctx.strokeStyle = rgba(ramp[1]!, 0.16)
        ctx.lineWidth = 6
        ctx.stroke()
        arc(radius, start, end)
        ctx.strokeStyle = rgba(ramp[0]!, 0.28)
        ctx.lineWidth = 3.2
        ctx.stroke()
        arc(radius, start, end)
        ctx.strokeStyle = ramp[0]!
        ctx.lineWidth = 1.5
        ctx.stroke()
        const [hx, hy] = pt(radius, end)
        const breathe = 1 + 0.25 * Math.sin(t * 3 + index)
        for (const [r0, o] of [[5, 0.18], [3.2, 0.35]] as const) {
          ctx.beginPath()
          ctx.arc(hx, hy, r0 * breathe, 0, Math.PI * 2)
          ctx.fillStyle = rgba(ramp[2]!, o)
          ctx.fill()
        }
        ctx.beginPath()
        ctx.arc(hx, hy, 1.6, 0, Math.PI * 2)
        ctx.fillStyle = "#fff"
        ctx.fill()
      })
      if (shown.length === 0) {
        const head = -90 + t * 18
        for (let step = 0; step < 14; step++) {
          const [x, y] = pt(hairline, head - step * 1.6)
          ctx.beginPath()
          ctx.arc(x, y, Math.max(0.2, 1.8 - step * 0.11), 0, Math.PI * 2)
          ctx.fillStyle = rgba(accent, 0.9 - step * 0.06)
          ctx.fill()
        }
      }
    }
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      if (now - last < 1000 / 30 - 1 || document.hidden) return
      last = now
      draw((Date.now() / 1000) % 3600)
    }
    if (still) draw(7)
    else raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [still, mood, progress.join(",")]) // eslint-disable-line react-hooks/exhaustive-deps

  return <canvas ref={ref} className="deck-ring" aria-hidden />
}
