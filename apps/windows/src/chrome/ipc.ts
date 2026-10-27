// The custom title bar's bridge to src-tauri/src/chrome.rs. Everything is a no-op outside Tauri (tests, a plain browser).
import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window

export interface ChromeState {
  maximized: boolean
  focused: boolean
}

export interface MaxState {
  hover: boolean
  pressed: boolean
}

function on<T>(name: string, cb: (v: T) => void): () => void {
  if (!inTauri) return () => {}
  const p = listen<T>(name, (e) => cb(e.payload))
  return () => void p.then((off) => off())
}

const call = (cmd: string, args?: Record<string, unknown>) => {
  if (inTauri) void invoke(cmd, args).catch(() => {})
}

const IDLE: ChromeState = { maximized: false, focused: true }

export const chromeState = (): Promise<ChromeState> => (inTauri ? invoke<ChromeState>("chrome_state_get").catch(() => IDLE) : Promise.resolve(IDLE))
export const onChromeState = (cb: (s: ChromeState) => void) => on<ChromeState>("chrome_state", cb)
export const onChromeMax = (cb: (s: MaxState) => void) => on<MaxState>("chrome_max", cb)
export const chromeReady = () => call("chrome_ready")
export const chromeMinimize = () => call("chrome_minimize")
export const chromeToggleMaximize = () => call("chrome_toggle_maximize")
export const chromeClose = () => call("chrome_close")
export const chromeSnapRect = (x: number, y: number, width: number, height: number) => call("chrome_snap_rect", { x, y, width, height })

/** Whether the window has a desktop backdrop (Acrylic or Mica) behind a transparent page. */
export async function glassActive(): Promise<boolean> {
  return inTauri ? invoke<boolean>("glass_active").catch(() => false) : false
}
