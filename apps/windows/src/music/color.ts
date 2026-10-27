// Album-art tint (NSImage.averageColor and Color.ensureMinimumBrightness), pure so they are testable.

export type RGB = [number, number, number] // 0..255

/** Average of RGBA pixel data, then the Mac's floor: near-black becomes a mid gray; dark colours are lifted to brightness 0.5. */
export function averageColor(rgba: ArrayLike<number>): RGB {
  let r = 0
  let g = 0
  let b = 0
  const n = Math.floor(rgba.length / 4)
  if (n === 0) return [255, 255, 255]
  for (let i = 0; i < n; i++) {
    r += rgba[i * 4]
    g += rgba[i * 4 + 1]
    b += rgba[i * 4 + 2]
  }
  const [ar, ag, ab] = [r / n / 255, g / n / 255, b / n / 255]
  const MIN = 0.5
  if (ar < 0.03 && ag < 0.03 && ab < 0.03) return [128, 128, 128]
  const [h, s, v] = rgbToHsv(ar, ag, ab)
  if (v < MIN) {
    const [nr, ng, nb] = hsvToRgb(h, s * (v / MIN), MIN)
    return [Math.round(nr * 255), Math.round(ng * 255), Math.round(nb * 255)]
  }
  return [Math.round(ar * 255), Math.round(ag * 255), Math.round(ab * 255)]
}

/** Rescale the colour so its perceived brightness is `factor` (0..1), as the Mac's ensureMinimumBrightness does. */
export function ensureMinimumBrightness([r, g, b]: RGB, factor: number): RGB {
  if (factor < 0 || factor > 1) return [r, g, b]
  const [fr, fg, fb] = [r / 255, g / 255, b / 255]
  const perceived = 0.2126 * fr + 0.7152 * fg + 0.0722 * fb
  if (perceived <= 0) return [Math.round(factor * 255), Math.round(factor * 255), Math.round(factor * 255)]
  const k = factor / perceived
  return [Math.round(Math.min(fr * k, 1) * 255), Math.round(Math.min(fg * k, 1) * 255), Math.round(Math.min(fb * k, 1) * 255)]
}

export const css = ([r, g, b]: RGB, alpha = 1) => `rgb(${r} ${g} ${b} / ${alpha})`

export function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h /= 6
    if (h < 0) h += 1
  }
  return [h, max === 0 ? 0 : d / max, max]
}

export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6)
  const f = h * 6 - i
  const p = v * (1 - s)
  const q = v * (1 - f * s)
  const t = v * (1 - (1 - f) * s)
  switch (((i % 6) + 6) % 6) {
    case 0: return [v, t, p]
    case 1: return [q, v, p]
    case 2: return [p, v, t]
    case 3: return [p, q, v]
    case 4: return [t, p, v]
    default: return [v, p, q]
  }
}

/** Decode a data URL into a small canvas and average it (browser only); null when it cannot be read. */
export function averageColorOf(dataUrl: string): Promise<RGB | null> {
  return new Promise((resolve) => {
    if (typeof Image === "undefined") return resolve(null)
    const img = new Image()
    img.onload = () => {
      try {
        const c = document.createElement("canvas")
        c.width = c.height = 32
        const ctx = c.getContext("2d", { willReadFrequently: true })
        if (!ctx) return resolve(null)
        ctx.drawImage(img, 0, 0, 32, 32)
        resolve(averageColor(ctx.getImageData(0, 0, 32, 32).data))
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = dataUrl
  })
}
