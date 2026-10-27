// The notch shell's decisions, pure so they can be tested: what holds the closed notch (ContentView.NotchLayout /
// showsReloClosed), what a shortcut or a gesture does, and the closed height. Nothing here touches React or Tauri.

import type { NotchGesture } from "../gestures"
import { gestureOutcome } from "../gestures"
import type { ShortcutAction } from "../shortcuts"

export type ClosedContent = "relo" | "music" | "plain"

export interface ClosedInputs {
  /** Settings > Alerts > "Show Relo in the closed notch" (`reloClosedActivity`). */
  closedActivity: boolean
  /** Something is live: the server's focus, working sessions without a card, or this PC needs to sign in. */
  live: boolean
  /** Music is playing, or has not yet gone idle (and its live activity is on, and it is not hidden for a full-screen app). */
  musicActive: boolean
  /** The expanding closed notch (the shortcut's inline sneak peek) and what it carries. */
  expanding: { show: boolean; type: string }
  /** A full-screen app hides the closed notch's content (`hideOnClosed`). */
  hidden: boolean
}

/**
 * What the closed notch carries. Relo holds it while it has something live (setting on) and, with nothing live, its pilot
 * light unless music plays; music takes it otherwise; the music expansion (the shortcut) wins over Relo while it shows.
 * (ContentView.swift:58, 71-74, 252-259.)
 */
export function closedContent(o: ClosedInputs): ClosedContent {
  if (o.hidden) return "plain"
  const showsRelo = o.closedActivity && (o.live || !o.musicActive)
  if (!o.expanding.show && showsRelo) return "relo"
  if ((!o.expanding.show || o.expanding.type === "music") && o.musicActive) return "music"
  return "plain"
}

/** The slider's range (Settings > General > custom notch height 15..45, settings/store.ts NOTCH_HEIGHT_MIN/MAX). */
export const CLOSED_HEIGHT_MIN = 15
export const CLOSED_HEIGHT_MAX = 45

/** Settings > General > notch height in CSS px: the slider's range (the Mac's custom 15..45), anything else is clamped. */
export function closedHeightOf(notchHeight: number): number {
  return Number.isFinite(notchHeight) ? Math.min(CLOSED_HEIGHT_MAX, Math.max(CLOSED_HEIGHT_MIN, Math.round(notchHeight))) : 32
}

/** "Open in Notch" (the tray, Home): the Relo tab, closed again after this long unless the pointer is on it (OpenInNotch). */
export const OPEN_IN_NOTCH_MS = 5000

/**
 * The tabs whose view reports its own height through `onFit` and is given it. None: every tab but Relo has the Mac's fixed
 * height (System 250, Music and Shelf 190); the Shelf's open height is the Mac's 190, not what its view asks for.
 */
export const FITTING_TABS: ReadonlySet<string> = new Set()
export const fitsContent = (tabId: string): boolean => FITTING_TABS.has(tabId)

/** How long a notch opened by the shortcut stays before it closes by itself, unless the pointer is on it. */
export const SHORTCUT_OPEN_MS = 3000
/** `toggleSneakPeek` shows the peek this long (boringNotchApp.swift:497). */
export const SHORTCUT_SNEAK_MS = 3000

export type ShortcutEffect =
  | { kind: "open"; autoCloseMs: number | null; /** Land on this tab whatever the remembered one is. */ tab?: "relo" }
  | { kind: "close" }
  /** Show or hide the standard sneak peek (the music strip under the notch). */
  | { kind: "sneak"; show: boolean; ms: number }
  /** Show or hide the inline one (the expanding closed notch). */
  | { kind: "expanding"; show: boolean }
  | null

export interface ShortcutContext {
  open: boolean
  sneakStyle: "standard" | "inline"
  sneakShowing: boolean
  expandingShowing: boolean
}

/** What a `shortcut` event does (boringNotchApp.swift:490-546; `openNotch` is the tray's and Home's "Open in Notch"). */
export function shortcutEffect(action: ShortcutAction, ctx: ShortcutContext): ShortcutEffect {
  switch (action) {
    case "toggleSneakPeek":
      return ctx.sneakStyle === "inline"
        ? { kind: "expanding", show: !ctx.expandingShowing }
        : { kind: "sneak", show: !ctx.sneakShowing, ms: SHORTCUT_SNEAK_MS }
    case "toggleNotchOpen":
      return ctx.open ? { kind: "close" } : { kind: "open", autoCloseMs: SHORTCUT_OPEN_MS }
    case "openNotch":
      return ctx.open ? null : { kind: "open", autoCloseMs: OPEN_IN_NOTCH_MS, tab: "relo" }
  }
}

export interface GestureContext {
  open: boolean
  tab: string
  /** A text field or a share picker holds the notch open (`preventNotchClose`). */
  holdOpen: boolean
}

/** What a `notch_gesture` does: "open", "close", or nothing (the Mac's guards, gestures.ts `gestureOutcome`). */
export function gestureEffect(g: NotchGesture, ctx: GestureContext): "open" | "close" | null {
  return gestureOutcome(g, { open: ctx.open, onReloTab: ctx.tab === "relo", holdOpen: ctx.holdOpen })
}

/**
 * Where a hover leaves the notch: it closes 100 ms after the pointer leaves unless something holds it open
 * (a text field, a share, a sneak peek expansion). Entering opens only a closed notch with no sneak peek showing.
 */
export function mayCloseOnLeave(o: { pointerInside: boolean; editing: boolean; holdOpen: boolean }): boolean {
  return !o.pointerInside && !o.editing && !o.holdOpen
}

// ---- Settings the header reads (BoringHeader / BoringViewCoordinator) ----

/**
 * Whether the tab row shows: "Always show tabs" keeps it, otherwise it appears only when there is more than one tab to
 * pick from. (Turning it off also stops "remember last tab": `rememberLastTabOf`.)
 */
export function showsTabs(o: { alwaysShowTabs: boolean; tabCount: number }): boolean {
  return o.alwaysShowTabs || o.tabCount > 1
}

/** BoringViewCoordinator.alwaysShowTabs didSet: with the tabs hidden by choice the notch always opens on Relo. */
export function rememberLastTabOf(o: { rememberLastTab: boolean; alwaysShowTabs: boolean }): boolean {
  return o.rememberLastTab && o.alwaysShowTabs
}

// ---- The open gesture's feedback (ContentView.gestureScale, handleDownGesture) ----

/** The Mac's gestureProgress at the sensitivity threshold: `(translation / sensitivity) * 20`. */
export const GESTURE_PROGRESS_MAX = 20

export interface GestureFeedback {
  /** Scale on both axes from the top edge (`max(0.6, 1 + gestureProgress * 0.01)`). */
  scale: number
  /** The open notch's content dims while it is pulled shut (`1 - min(|gestureProgress| * 0.1, 0.3)`). */
  contentOpacity: number
}

export const NO_FEEDBACK: GestureFeedback = { scale: 1, contentOpacity: 1 }

/**
 * What a `notch_gesture` scroll event does to the notch while the gesture runs. Rust's `progress` is 0..1 toward the
 * sensitivity, the Mac's `translation / sensitivity`. Closed: a downward pan grows the notch (1.2 at the threshold).
 * Open off the Relo tab: an upward pan shrinks it (0.8) and dims its content. Anything else: none.
 */
export function gestureFeedback(g: NotchGesture, ctx: { open: boolean; tab: string }): GestureFeedback {
  if (g.kind !== "scroll") return NO_FEEDBACK
  const progress = Math.min(1, Math.max(0, g.progress)) * GESTURE_PROGRESS_MAX
  if (progress === 0) return NO_FEEDBACK
  if (!ctx.open && g.direction === "down") return { scale: Math.max(0.6, 1 + progress * 0.01), contentOpacity: 1 }
  if (ctx.open && ctx.tab !== "relo" && g.direction === "up") {
    return { scale: Math.max(0.6, 1 - progress * 0.01), contentOpacity: 1 - Math.min(progress * 0.1, 0.3) }
  }
  return NO_FEEDBACK
}

/** Settings > Appearance > "Extend hover area": the closed notch's hot rect grows by this much to the sides and below (CSS px). */
export const HOVER_EXTEND = { x: 12, bottom: 10 } as const

/** The rect the pointer is tested against, in CSS px: grown while closed with "Extend hover area" on. */
export function extendedRect<R extends { left: number; top: number; width: number; height: number }>(r: R, extend: boolean): { left: number; top: number; width: number; height: number } {
  if (!extend) return { left: r.left, top: r.top, width: r.width, height: r.height }
  return { left: r.left - HOVER_EXTEND.x, top: r.top, width: r.width + 2 * HOVER_EXTEND.x, height: r.height + HOVER_EXTEND.bottom }
}
