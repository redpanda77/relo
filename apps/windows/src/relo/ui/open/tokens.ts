// The open notch's tokens, one for one with the Mac: ReloCardMetrics and ReloMotion (ReloCards.swift), ReloPlanMetrics
// (ReloNotchView.swift) and the fonts. Colours come from theme.ts (ReloNotchTheme); only the few it lacks are here.

import { swiftSpring } from "../../../geometry"

/** ReloMotion: the Dashboard's motion tokens as Apple springs (response, dampingFraction), exactly. */
export const SPRINGS = {
  press: swiftSpring(0.18, 1),
  snappy: swiftSpring(0.28, 0.86),
  smooth: swiftSpring(0.35, 1),
  bouncy: swiftSpring(0.42, 0.72),
  /** `withAnimation(.smooth)` on a tab change. */
  tab: swiftSpring(0.5, 1),
  /** The tab content swap: the view changes inside `withAnimation(.smooth)` (TabSelectionView), so it cross-fades on 0.5 s. */
  tabSwap: swiftSpring(0.5, 1),
} as const

/** `.easeInOut(duration: 0.26)` and `.easeOut(duration: 0.18)`. */
export const EASES = {
  base: { duration: 0.26, ease: "easeInOut" },
  fast: { duration: 0.18, ease: "easeOut" },
} as const

/** Reduce Motion turns a spring into a short fade (ReloMotion.or). */
export const REDUCED = { duration: 0.18, ease: "easeInOut" } as const

export const METRICS = {
  /** EdgeInsets top/leading/bottom/trailing: 9 / 12 / 9 / 12. */
  insetY: 9,
  insetX: 12,
  radius: 14,
  lineGap: 4,
  itemSpacing: 8,
  sectionSpacing: 14,
  /** Every collapsed card is this tall; opened it grows to its whole text. */
  cardHeight: 108,
  rowHeight: 30,
  machineHeight: 34,
  quietHeight: 22,
  summaryHeight: 18,
  footerHeight: 20,
  fill: "rgb(255 255 255 / 0.06)",
  border: "rgb(255 255 255 / 0.08)",
} as const

/** Font sizes in pt (the Mac's `Font.system(size:)`; SF maps to Inter at the same size). */
export const FONT = {
  origin: 10.5,
  badge: 10,
  title: 12.5,
  hero: 13.5,
  status: 11,
  meta: 10,
} as const

export const EXTRA = {
  yellow: "#facc15",
  ice: "#e4f9ff",
  cyan: "#5ce1ff",
  running: "#8b7cff",
  runningSoft: "#c4bbff",
  done: "#34d399",
  holo: "linear-gradient(135deg, #5ce1ff, #8b7cff)",
  holoDown: "linear-gradient(180deg, #5ce1ff, #8b7cff)",
} as const

/** ReloPlanMetrics: the plan's grid (mark, text, time, chevron). */
export const PLAN = {
  mark: 12,
  gap: 8,
  meta: 46,
  chevron: 10,
  line: 14,
  rowPad: 5,
  pane: 10,
  deckSpacing: 10,
} as const
