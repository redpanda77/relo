// Pure notch geometry. Values mirror apps/notch boringNotch/sizing/matters.swift:
// closed ~185 wide, open 640 x 220..430 fitted to content, corner radii closed 6/14 and opened 19/24.

export interface NotchShape {
  w: number
  h: number
  /** Top (concave) corner inset. */
  top: number
  /** Bottom (convex) corner radius. */
  bottom: number
}

export const WINDOW_W = 680
export const WINDOW_H = 450
/** The Relo tab's shortest list (ReloWorkList.fit: max(170, ...)) and the tallest the notch opens (reloOpenNotchSize). */
export const OPEN_MIN_H = 170
export const OPEN_MAX_H = 430
/** Relo tab height while it has no list (sign-in, all clear, connecting): ReloNotchView sets 200. */
export const OPEN_EMPTY_H = 200
/** What the header, the paddings and the notch's own top add around the Relo list (ReloWorkList.fit: 58 pt). */
export const RELO_CHROME_H = 58
/** The summary line (18) and the gap under it (10), added to the measured list. */
export const SUMMARY_H = 28
/** Open content inset from the notch's edge: opened top radius 19 + the 12 pt padding (ContentView). */
export const CONTENT_INSET = 31
export const CONTENT_BOTTOM = 12
/** The header row (tabs, the notch gap, settings) is max(24, closed height) tall; VStack spacing under it is 8. */
export const HEADER_GAP = 8
/** The Mac fake-notch path on a display without a hardware notch (nonNotchHeight). */
export const CLOSED: NotchShape = { w: 185, h: 32, top: 6, bottom: 14 }
export const OPEN_BASE: NotchShape = { w: 640, h: OPEN_MIN_H, top: 19, bottom: 24 }
/** Hover delay before the notch opens, in ms. */
export const HOVER_OPEN_DELAY_MS = 300

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n))
}

/** Open height fitted to the content (content height plus the vertical padding), within 170..430. */
export function fitOpenHeight(contentHeight: number, verticalPadding = 0): number {
  if (!Number.isFinite(contentHeight)) return OPEN_MIN_H
  return clamp(Math.round(contentHeight + verticalPadding), OPEN_MIN_H, OPEN_MAX_H)
}

/** The Relo tab's open height: the list measures itself and the chrome (58) is added; no list is 200. */
export function reloOpenHeight(listHeight: number, showsList: boolean): number {
  return showsList ? fitOpenHeight(listHeight, RELO_CHROME_H) : OPEN_EMPTY_H
}

/** Fixed open heights of the other tabs (openNotchSize(for:)): System 250, Music and Shelf 190. */
export const TAB_HEIGHT: Record<string, number> = { system: 250, home: 190, shelf: 190 }

/** A tab's open height: what its view reported through `onFit` (the Shelf's), clamped like the Relo tab's, else its fixed one. */
export function tabOpenHeight(fixed: number, reported: number | undefined): number {
  return reported === undefined ? fixed : fitOpenHeight(reported)
}

// MARK: Springs (SwiftUI response / dampingFraction as a physical spring with unit mass)

export interface SpringConfig {
  type: "spring"
  stiffness: number
  damping: number
  mass: number
}

/** SwiftUI `.spring(response:dampingFraction:)`: stiffness (2pi/response)^2, damping 2 zeta sqrt(k). */
export function swiftSpring(response: number, dampingFraction: number): SpringConfig {
  const stiffness = (2 * Math.PI / response) ** 2
  return { type: "spring", stiffness, damping: 2 * dampingFraction * Math.sqrt(stiffness), mass: 1 }
}

/** ContentView: `.animation(open ? openAnimation : closeAnimation, value: notchState)`. */
export const OPEN_SPRING = swiftSpring(0.42, 0.8)
export const CLOSE_SPRING = swiftSpring(0.45, 1.0)
/** A tab or content change while open: `.spring(response: 0.42, dampingFraction: 0.85)`. */
export const RESIZE_SPRING = swiftSpring(0.42, 0.85)
/** `Animation.spring(.bouncy(duration: 0.4))` (BoringAnimations): response 0.4, damping 1 - bounce 0.3. */
export const BOUNCY_SPRING = swiftSpring(0.4, 0.7)
/** `.smooth(duration: 0.35)`: the open content's scale-and-fade transition. */
export const CONTENT_SPRING = swiftSpring(0.35, 1)
/** The content leaving on close: the same smooth spring, quicker (about 0.2 s), so it is gone before the shape has collapsed. */
export const CONTENT_OUT = swiftSpring(0.22, 1)
/** `.smooth` (0.5 s): tab switches. */
export const TAB_SPRING = swiftSpring(0.5, 1)
/** `.animation(timingCurve(0.16, 1, 0.3, 1, duration: 0.7))`: the pre-macOS 14 fallback of BoringAnimations. */
export const FALLBACK_CURVE = { ease: [0.16, 1, 0.3, 1] as [number, number, number, number], duration: 0.7 }

/** The open content's transition (`.scale(0.8, anchor: .top)` with opacity). */
export const CONTENT_SCALE_FROM = 0.8
/** A closed pointer leaving waits this long before closing (handleHover), and the sneak peek hides after 1.5 s. */
export const HOVER_CLOSE_DELAY_MS = 100
export const SNEAK_PEEK_MS = 1500
export const EXPANDING_MS = 3000

export function openShape(contentHeight: number, verticalPadding = 0): NotchShape {
  return { ...OPEN_BASE, h: fitOpenHeight(contentHeight, verticalPadding) }
}

/**
 * The notch outline. Top corners are concave (they flare outward into the screen edge, as on the Mac),
 * bottom corners are convex. The path spans 0..w at y=0 and the body is inset by `t` on each side.
 */
export function outline(w: number, h: number, t: number, b: number): string {
  const f = (n: number) => Number(n.toFixed(2))
  // Radii can never exceed the shape while the spring overshoots at tiny sizes.
  const tt = Math.max(0, Math.min(t, w / 2, h))
  const bb = Math.max(0, Math.min(b, h - tt, (w - 2 * tt) / 2))
  return (
    `M0 0 Q${f(tt)} 0 ${f(tt)} ${f(tt)} L${f(tt)} ${f(h - bb)} Q${f(tt)} ${f(h)} ${f(tt + bb)} ${f(h)} ` +
    `L${f(w - tt - bb)} ${f(h)} Q${f(w - tt)} ${f(h)} ${f(w - tt)} ${f(h - bb)} L${f(w - tt)} ${f(tt)} ` +
    `Q${f(w - tt)} 0 ${f(w)} 0 Z`
  )
}

/** [x, y, w, h] in physical pixels, relative to the window. */
export type HotRect = [number, number, number, number]

/** Converts a CSS-pixel client rect to the physical-pixel hot rect Rust expects. */
export function toHotRect(
  r: { left: number; top: number; width: number; height: number },
  devicePixelRatio: number,
): HotRect {
  const k = devicePixelRatio > 0 ? devicePixelRatio : 1
  return [Math.round(r.left * k), Math.round(r.top * k), Math.round(r.width * k), Math.round(r.height * k)]
}

export function sameRect(a: HotRect | null, b: HotRect): boolean {
  return a !== null && a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]
}
