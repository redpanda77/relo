// Global shortcuts (Rust: src-tauri/src/shortcuts.rs). The Mac's two defaults with Cmd mapped to Ctrl:
// "Toggle Sneak Peek" Ctrl+Shift+H and "Toggle Notch Open" Ctrl+Shift+I (boringNotchApp.swift:490-546).
//
// The notch listens with `onShortcut`; Settings lists and rebinds with `shortcutsList` / `shortcutsSet` and stores
// `{ shortcuts: { [action]: accelerator } }` in settings.json (Rust reads that key at startup).

import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import { inTauri } from "./bridge"

/** `toggleSneakPeek` / `toggleNotchOpen` come from the global shortcuts; `openNotch` from the tray and the Home window ("Open in Notch"). */
export type ShortcutAction = "toggleSneakPeek" | "toggleNotchOpen" | "openNotch"

export interface ShortcutInfo {
  action: Exclude<ShortcutAction, "openNotch">
  label: string
  /** Normalised ("Ctrl+Shift+H"); empty = unbound. */
  accelerator: string
  defaultAccelerator: string
  /** False when the key combination is taken by another app (see `error`) or unbound. */
  registered: boolean
  error: string | null
}

export const DEFAULT_SHORTCUTS: Record<ShortcutInfo["action"], string> = {
  toggleSneakPeek: "Ctrl+Shift+H",
  toggleNotchOpen: "Ctrl+Shift+I",
}

function listenTo<T>(name: string, cb: (payload: T) => void): () => void {
  if (!inTauri) return () => {}
  const p = listen<T>(name, (e) => cb(e.payload))
  return () => void p.then((off) => off())
}

/** A global shortcut was pressed (or "Open in Notch" was chosen from the tray / Home window). */
export function onShortcut(cb: (action: ShortcutAction) => void): () => void {
  return listenTo<{ action: ShortcutAction }>("shortcut", (p) => cb(p.action))
}

/** The bindings or their registration state changed. */
export function onShortcutsChanged(cb: (list: ShortcutInfo[]) => void): () => void {
  return listenTo<ShortcutInfo[]>("shortcuts_changed", cb)
}

export async function shortcutsList(): Promise<ShortcutInfo[]> {
  return inTauri ? invoke<ShortcutInfo[]>("shortcuts_list").catch(() => []) : []
}

/** Rebind one action; `null` unbinds. Rejects with a readable message (conflict, invalid, taken by another app). */
export async function shortcutsSet(action: ShortcutInfo["action"], accelerator: string | null): Promise<ShortcutInfo[]> {
  if (!inTauri) return []
  try {
    return await invoke<ShortcutInfo[]>("shortcuts_set", { action, accelerator })
  } catch (e) {
    throw new Error(String(e))
  }
}

/** Apply a saved `{action: accelerator}` map to all bindings (missing = default, "" = unbound). */
export async function shortcutsApply(bindings: Record<string, string>): Promise<ShortcutInfo[]> {
  return inTauri ? invoke<ShortcutInfo[]>("shortcuts_apply", { bindings }) : []
}

// ---- The recorder (Mac: KeyboardShortcuts.Recorder) ----

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph"])

/**
 * The accelerator a keydown means, or null while only modifiers are down (keep recording). Needs a modifier plus
 * one key; Escape and Backspace are handled by the caller (cancel / clear).
 */
export function acceleratorOf(e: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null
  const key = keyName(e)
  if (!key) return null
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean) as string[]
  if (mods.length === 0) return null
  return [...mods, key].join("+")
}

function keyName(e: Pick<KeyboardEvent, "key" | "code">): string | null {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3)
  if (/^Digit[0-9]$/.test(e.code)) return e.code.slice(5)
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.code)) return e.code
  const named: Record<string, string> = {
    Space: "Space", Enter: "Enter", Tab: "Tab", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
    Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", Insert: "Insert", Delete: "Delete",
    Minus: "-", Equal: "=", Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", Backquote: "`",
    BracketLeft: "[", BracketRight: "]", Backslash: "\\",
  }
  return named[e.code] ?? null
}

/** "Ctrl+Shift+H" as the keycap row the Settings recorder shows. */
export function displayAccelerator(accelerator: string): string[] {
  return accelerator === "" ? [] : accelerator.split("+").map((t) => (t === "Super" ? "Win" : t))
}
