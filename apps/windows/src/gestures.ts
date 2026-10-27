// Click and scroll gestures over the notch (Rust: src-tauri/src/gestures.rs), the Windows form of the Mac's tap and
// trackpad pan (ContentView.swift:140, 492-545). Rust reports; the page decides, with the Mac's guards in `gestureOutcome`.

import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { inTauri } from "./bridge"

export type NotchGesture =
  | { kind: "click" }
  /** One wheel event over the notch; `progress` 0..1 toward the sensitivity threshold (the Mac's gestureProgress / 20). */
  | { kind: "scroll"; direction: "down" | "up"; progress: number }
  /** Wheel travel down passed the sensitivity: the Mac's pan-down open. */
  | { kind: "open" }
  /** Wheel travel up passed the sensitivity: the Mac's pan-up close. */
  | { kind: "close" }

export function onNotchGesture(cb: (gesture: NotchGesture) => void): () => void {
  if (!inTauri) return () => {}
  const p = listen<NotchGesture>("notch_gesture", (e) => cb(e.payload))
  return () => void p.then((off) => off())
}

/** Mac Settings > Gestures: `sensitivity` 100 (High), 200 (Medium, default) or 300 (Low). */
export async function gesturesConfigure(opts: { enabled: boolean; closeEnabled: boolean; sensitivity: number }): Promise<void> {
  if (inTauri) await invoke("gestures_configure", { enabled: opts.enabled, closeEnabled: opts.closeEnabled, sensitivity: opts.sensitivity })
}

export interface NotchContext {
  open: boolean
  /** The Relo tab scrolls its cards: scrolling there never closes the notch. */
  onReloTab: boolean
  /** Sharing (a drag, a picker) holds the notch open (`preventNotchClose`). */
  holdOpen?: boolean
}

/** What a gesture does to the notch: "open" or "close", or null when the Mac's guards ignore it. */
export function gestureOutcome(g: NotchGesture, ctx: NotchContext): "open" | "close" | null {
  switch (g.kind) {
    case "click":
    case "open":
      return ctx.open ? null : "open" // the Mac's doOpen() on tap and pan down: only a closed notch opens
    case "close":
      return ctx.open && !ctx.onReloTab && !ctx.holdOpen ? "close" : null
    case "scroll":
      return null
  }
}
