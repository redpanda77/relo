// The shortcut recorder's keyboard logic (the Mac's KeyboardShortcuts.Recorder): what one keydown means while a row is
// recording. The accelerator comes from `acceleratorOf` (src/shortcuts.ts); Rust validates and registers it.

import { acceleratorOf } from "../shortcuts"

export type RecorderKey = Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">

export type RecorderOutcome =
  /** Escape: stop recording, change nothing. */
  | { kind: "cancel" }
  /** Backspace or Delete on its own: unbind the action. */
  | { kind: "clear" }
  /** A modifier plus a key. */
  | { kind: "set"; accelerator: string }
  /** Only modifiers so far: keep recording. */
  | { kind: "wait" }
  /** A key with no modifier: a bare key would steal typing from every app. */
  | { kind: "needsModifier" }

const MODIFIER_KEYS = ["Control", "Shift", "Alt", "Meta", "AltGraph"]

export function recorderKey(e: RecorderKey): RecorderOutcome {
  const modifiers = e.ctrlKey || e.altKey || e.shiftKey || e.metaKey
  if (e.key === "Escape" && !modifiers) return { kind: "cancel" }
  if ((e.key === "Backspace" || e.key === "Delete") && !modifiers) return { kind: "clear" }
  const accelerator = acceleratorOf(e)
  if (accelerator) return { kind: "set", accelerator }
  if (MODIFIER_KEYS.includes(e.key)) return { kind: "wait" }
  return { kind: "needsModifier" }
}
