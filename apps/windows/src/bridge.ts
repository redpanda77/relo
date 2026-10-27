import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import type { HotRect } from "./geometry"

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window

/** Tells Rust where the notch is (physical px, window-relative); Rust owns hit-testing. */
export function setHot(rect: HotRect): void {
  if (inTauri) void invoke("set_hot", { rect }).catch(() => {})
}

/** The notch takes the keyboard while a text field is edited (it is otherwise never activated), then gives it back. */
export function setKeyboard(on: boolean): void {
  if (inTauri) void invoke("notch_keyboard", { on }).catch(() => {})
}

/** Rust is the hover source of truth: while click-through the page receives no mouse events. */
export function onPointer(cb: (inside: boolean) => void): () => void {
  return onEvent<boolean>("notch_pointer", cb)
}

function onEvent<T>(name: string, cb: (payload: T) => void): () => void {
  if (!inTauri) return () => {}
  const p = listen<T>(name, (e) => cb(e.payload))
  return () => void p.then((off) => off())
}

// ---- Quit (Rust waits for the quit sound; src-tauri/src/quit.rs) ----

/** Rust asks the page to quit: play the quit cue, then answer with `quitReady`. */
export function onQuitRequest(cb: () => void): () => void {
  return onEvent<unknown>("quit_request", () => cb())
}

/** How long the quit sound lasts (ms, 0 = none); Rust exits after that, at most 2 s. */
export async function quitReady(ms: number): Promise<void> {
  if (inTauri) await invoke("quit_ready", { ms })
}

// ---- Fullscreen quiet ----

/** A fullscreen app is in front: hide the notch content (the window itself stays up so it keeps painting). */
export function onFullscreen(cb: (fullscreen: boolean) => void): () => void {
  return onEvent<{ fullscreen: boolean }>("notch_fullscreen", (p) => cb(p.fullscreen))
}

/** Current state, for a page that loaded after the last event. */
export async function fullscreenGet(): Promise<boolean> {
  return inTauri ? invoke<boolean>("fullscreen_get").catch(() => false) : false
}

// ---- Displays ----

export interface DisplayInfo {
  /** Stable id to pass to setDisplay (the Windows device name, e.g. `\\.\DISPLAY1`). */
  id: string
  name: string
  x: number
  y: number
  width: number
  height: number
  scale: number
  primary: boolean
}

export async function listDisplays(): Promise<DisplayInfo[]> {
  return inTauri ? invoke<DisplayInfo[]>("list_displays").catch(() => []) : []
}

/** Preferred display; null = primary. Unknown ids fall back to primary until that display appears. */
export async function setDisplay(id: string | null): Promise<void> {
  if (inTauri) await invoke("set_display", { id })
}

/** Fires after a display was added, removed or reconfigured (the window is already re-placed). */
export function onDisplaysChanged(cb: (displays: DisplayInfo[]) => void): () => void {
  return onEvent<DisplayInfo[]>("displays_changed", cb)
}

// ---- Tray ----

export interface TrayState {
  status: "starting" | "live" | "offline" | "signedOut"
  needsYou: number
  running: number
  paused: boolean
  needsSignIn?: boolean
  signingIn?: boolean
  updateVersion?: string | null
  updateReady?: boolean
  /** Relo runs on this PC: the menu speaks the local words and offers Repair instead of Sign in. */
  local?: boolean
  /** A server address exists (the Mac's `originChosen`): Sign in and Open Dashboard are disabled without one. */
  hasOrigin?: boolean
  /** The first card that needs the owner ("2 need you: <title>"). */
  firstTitle?: string | null
  /** The account, for the status line "Relo · <email>". */
  email?: string | null
  /** The connection is being established: the status line says "(connecting)" and the last Now stays. */
  connecting?: boolean
  /** Local mode: Relo's server would not start ("Relo couldn't start on this PC" and Try again). */
  localFailed?: boolean
}

export type TrayAction =
  | "repair"
  | "pause_1h"
  | "resume"
  | "sign_in"
  | "open_dashboard"
  | "settings"
  | "quit"
  | "sign_out"
  | "update_install"
  /** "Open in Notch" and "Open Relo": Rust opens the notch (`shortcut` openNotch) and the Home window itself. */
  | "open_notch"
  | "open_home"
  /** "Check for Updates…", "Restart Relo" (Rust restarts the app itself) and "Try again" after Relo on this PC would not start. */
  | "check_updates"
  | "restart"
  | "retry_start"

export async function setTray(state: TrayState): Promise<void> {
  if (inTauri) await invoke("set_tray", { state })
}

export function onTrayAction(cb: (action: TrayAction) => void): () => void {
  return onEvent<{ action: TrayAction }>("tray_action", (p) => cb(p.action))
}

// ---- Browser sign-in (PKCE is driven from TS) ----

/** Opens an https URL in the default browser. Rejects for anything else. */
export async function openUrl(url: string): Promise<void> {
  if (inTauri) await invoke("open_url", { url })
}

/** A validated `relo://auth/callback?...` link, from this launch or forwarded by a second instance. */
export function onAuthCallback(cb: (url: string) => void): () => void {
  return onEvent<{ url: string }>("auth_callback", (p) => cb(p.url))
}

export interface LaunchArgs {
  origin: string
  signInCode: string | null
  codeVerifier: string | null
}

/** What Rust read from the command line (`launch_args`): the installer hand-off fields when present, and `atLogin`. */
export interface LaunchInfo extends Partial<LaunchArgs> {
  /** Windows started the app at sign-in (its Run entry passes `--at-login`); the owner did not open it. */
  atLogin: boolean
}

/** Pure: the installer hand-off out of `launch_args`; null without a valid origin. */
export function handOffOf(info: LaunchInfo | null): LaunchArgs | null {
  if (!info?.origin) return null
  return { origin: info.origin, signInCode: info.signInCode ?? null, codeVerifier: info.codeVerifier ?? null }
}

export async function launchInfo(): Promise<LaunchInfo> {
  return inTauri ? invoke<LaunchInfo>("launch_args").catch(() => ({ atLogin: false })) : { atLogin: false }
}

/** Installer hand-off (`--relo-origin`, `--relo-sign-in-code`, `--relo-code-verifier`); null without a valid origin. */
export async function launchArgs(): Promise<LaunchArgs | null> {
  return handOffOf(await launchInfo())
}

/** Started by Windows at sign-in (`--at-login`) rather than opened by the owner. */
export async function startedAtLogin(): Promise<boolean> {
  return (await launchInfo()).atLogin
}

// ---- Secrets (Windows Credential Manager, target `Relo/<name>`; names [a-z0-9._-]{1,64}) ----

export async function secretGet(name: string): Promise<string | null> {
  return inTauri ? invoke<string | null>("secret_get", { name }) : null
}

export async function secretSet(name: string, value: string): Promise<void> {
  if (inTauri) await invoke("secret_set", { name, value })
}

export async function secretDelete(name: string): Promise<void> {
  if (inTauri) await invoke("secret_delete", { name })
}

// ---- Start with Windows ----

export async function autostartGet(): Promise<boolean> {
  return inTauri ? invoke<boolean>("autostart_get") : false
}

export async function autostartSet(enabled: boolean): Promise<void> {
  if (inTauri) await invoke("autostart_set", { enabled })
}

// ---- W1: shell events and commands (session, power, launch, restart) ----

/** The PC woke from sleep or the session unlocked: read Now at once (Mac: didWakeNotification -> refreshNow). */
export function onSystemResumed(cb: (reason: "resume" | "unlock") => void): () => void {
  return onEvent<{ reason: "resume" | "unlock" }>("system_resumed", (p) => cb(p.reason))
}

/** The Windows session was locked or unlocked. While locked and "show on lock screen" is off, Rust also reports the notch as quiet through `onFullscreen`. */
export function onSessionLock(cb: (locked: boolean) => void): () => void {
  return onEvent<{ locked: boolean }>("session_lock", (p) => cb(p.locked))
}

/** A second launch carried the installer hand-off (`--relo-origin`, `--relo-sign-in-code`, `--relo-code-verifier`) for the running notch. */
export function onLaunchHandOff(cb: (args: LaunchArgs) => void): () => void {
  return onEvent<LaunchArgs>("launch_hand_off", cb)
}

/** Relaunch Relo and quit this instance (the tray's Restart Relo). */
export async function restartRelo(): Promise<void> {
  if (inTauri) await invoke("restart_relo")
}

/** Log a launch stage once, with the time since the process started: `liveData` is the first live Now (`firstDraw` and `windowShown` are logged by Rust). */
export function launchMark(stage: "liveData" | "firstDraw" | "windowShown"): void {
  if (inTauri) void invoke("launch_mark", { stage }).catch(() => {})
}

/** Whether Home and Settings have a desktop backdrop (Acrylic or Mica) behind them, so the page can paint its glass tint. */
export async function glassActive(): Promise<boolean> {
  return inTauri ? invoke<boolean>("glass_active").catch(() => false) : false
}