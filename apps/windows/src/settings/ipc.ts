// The Settings window's bridge to Rust and to the other windows. Everything is a no-op outside Tauri (tests, plain browser).
import { invoke } from "@tauri-apps/api/core"
import { emit, listen } from "@tauri-apps/api/event"
import { INVITE_REQUEST_EVENT, INVITE_RESULT_EVENT } from "../client/cliInvite"
import { provisionCli, requestInvite, type InviteIo, type Prepared, type Provision } from "./onboarding/cliProvision"

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window

export function onEvent<T>(name: string, cb: (payload: T) => void): () => void {
  if (!inTauri) return () => {}
  const p = listen<T>(name, (e) => cb(e.payload))
  return () => void p.then((off) => off())
}

/** Broadcast to every window (the notch handles `settings_sign_in`, `settings_sign_out`, `onboarding_sign_in`). */
export function broadcast(name: string, payload?: unknown): void {
  if (inTauri) void emit(name, payload).catch(() => {})
}

// ---- Settings file ----
export async function settingsRead(): Promise<unknown> {
  return inTauri ? invoke("settings_read").catch(() => ({})) : {}
}
export async function settingsWrite(settings: unknown): Promise<void> {
  if (inTauri) await invoke("settings_write", { settings })
}
export function onSettingsChanged(cb: (raw: unknown) => void): () => void {
  return onEvent<unknown>("settings_changed", cb)
}

// ---- Window ----
export async function openSettings(page?: string): Promise<void> {
  if (inTauri) await invoke("open_settings", { page })
}
export async function pageTake(): Promise<string | null> {
  return inTauri ? invoke<string | null>("settings_page_take").catch(() => null) : null
}
export function onSettingsPage(cb: (page: string) => void): () => void {
  return onEvent<string>("settings_page", cb)
}
export async function hideSettings(): Promise<void> {
  if (inTauri) await invoke("hide_settings")
}
export async function quitRelo(): Promise<void> {
  if (inTauri) await invoke("quit_relo")
}
export async function setTrayVisible(visible: boolean): Promise<void> {
  if (inTauri) await invoke("set_tray_visible", { visible }).catch(() => {})
}
export async function openLogsFolder(): Promise<void> {
  if (inTauri) await invoke("open_logs_folder")
}

// ---- Agents ----
export interface AgentInfo {
  id: string
  name: string
}
export async function detectAgents(): Promise<AgentInfo[]> {
  return inTauri ? invoke<AgentInfo[]>("detect_agents").catch(() => []) : []
}
export async function runSetupAgent(agent: string): Promise<{ ok: boolean; message: string }> {
  if (!inTauri) return { ok: false, message: "Relo is not running in the app." }
  try {
    return await invoke<{ ok: boolean; message: string }>("run_setup_agent", { agent })
  } catch (e) {
    // Rust rejects with plain words; anything else (a bridge error) is not for the owner to read.
    return { ok: false, message: typeof e === "string" && e.trim() !== "" ? e : "Relo could not set this up. Try again, or skip it for now." }
  }
}

// ---- The relo command (src-tauri/src/cli_setup.rs) ----
/** The server the installer came from (`install-source.json`), for when the app was started without `--relo-origin`; null in a dev build. */
export async function installSource(): Promise<string | null> {
  return inTauri ? invoke<string | null>("install_source").catch(() => null) : null
}

let listenReady: Promise<unknown> = Promise.resolve()
const inviteIo: InviteIo = {
  listen: (name, cb) => {
    const p = listen<unknown>(name, (e) => cb(e.payload))
    listenReady = p
    return () => void p.then((off) => off())
  },
  // The answer cannot be missed: the request goes out only once the listener is in place.
  emit: (name, payload) => void listenReady.then(() => emit(name, payload)).catch(() => {}),
  newId: () => crypto.randomUUID(),
}

/** Makes the relo command work for the server the app is signed in to; the words of what went wrong when it cannot. */
export function provisionReloCommand(origin: string): Promise<Provision> {
  if (!inTauri) return Promise.resolve({ ok: false, message: "Relo is not running in the app." })
  return provisionCli(origin, {
    prepare: (o) => invoke<Prepared>("cli_prepare", { origin: o }),
    invite: (o) => requestInvite(o, inviteIo, INVITE_REQUEST_EVENT, INVITE_RESULT_EVENT),
    join: (o, code) => invoke<void>("cli_join", { origin: o, code }),
  })
}

// ---- Events from the notch ----
/** `owner_state` {state}: the notch tells the sign-in screen where the account stands. */
export function onOwnerState(cb: (state: string) => void): () => void {
  return onEvent<{ state: string }>("owner_state", (p) => cb(p.state))
}

/** `owner_state` with its whole payload (`state`, and `approval` / `problem` when the notch knows them). */
export function onOwnerPayload(cb: (payload: unknown) => void): () => void {
  return onEvent<unknown>("owner_state", cb)
}
/** The last `owner_state` Rust saw (this window may have opened after it), or null. */
export async function ownerStateGet(): Promise<unknown> {
  return inTauri ? invoke<unknown>("owner_state_get").catch(() => null) : null
}
export async function computerName(): Promise<string> {
  return inTauri ? invoke<string>("computer_name").catch(() => "This PC") : "This PC"
}

// ---- Updates (src-tauri/src/updater.rs) ----
export interface UpdateCheck {
  /** "off": this build takes no updates (no signing key or no feed); "none": up to date. */
  state: "off" | "none" | "available" | "ready" | "error"
  version?: string | null
  message?: string | null
}
export async function updaterEnabled(): Promise<boolean> {
  return inTauri ? invoke<boolean>("updater_enabled").catch(() => false) : false
}
export async function updaterCheck(): Promise<UpdateCheck> {
  if (!inTauri) return { state: "off" }
  try {
    return await invoke<UpdateCheck>("updater_check_manual")
  } catch (e) {
    return { state: "error", message: String(e) }
  }
}
export async function updaterInstall(): Promise<string | null> {
  if (!inTauri) return null
  try {
    await invoke("updater_install")
    return null
  } catch (e) {
    return String(e)
  }
}

export async function appVersion(): Promise<string> {
  if (!inTauri) return "dev"
  try {
    const { getVersion } = await import("@tauri-apps/api/app")
    return await getVersion()
  } catch {
    return "unknown"
  }
}
