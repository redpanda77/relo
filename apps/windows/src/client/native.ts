// The Rust side of sign-in, notices and updates (auth_window.rs, services.rs, updater.rs). Everything here is a thin
// call; the rules live in ownerApp.ts and updatePolicy.ts.

import { invoke } from "@tauri-apps/api/core"
import { emit, listen } from "@tauri-apps/api/event"
import { inTauri } from "../bridge"
import { INVITE_REQUEST_EVENT, INVITE_RESULT_EVENT, parseInviteRequest, type InviteReport, type InviteRequest } from "./cliInvite"

function onEvent<T>(name: string, cb: (payload: T) => void): () => void {
  if (!inTauri) return () => {}
  const p = listen<T>(name, (e) => cb(e.payload))
  return () => void p.then((off) => off())
}

// ---- Sign-in window ----

/** Opens "Sign in to Relo" (a window on the server's own page). Rejects when the window cannot open: use the browser then. */
export async function openSignInWindow(url: string): Promise<void> {
  if (!inTauri) throw new Error("no sign-in window outside the app")
  await invoke("open_sign_in_window", { url })
}

export async function closeSignInWindow(): Promise<void> {
  if (inTauri) await invoke("close_sign_in_window").catch(() => undefined)
}

/** The owner closed the sign-in window without finishing: that cancels sign-in (Mac wording). */
export function onSignInClosed(cb: () => void): () => void {
  return onEvent<unknown>("sign_in_closed", () => cb())
}

// ---- Toast and log ----

export async function showToast(title: string, body: string): Promise<void> {
  if (inTauri) await invoke("show_toast", { title, body })
}

export type LogLevel = "info" | "warn" | "error"

/** One line in %LOCALAPPDATA%\Relo\logs\relo-windows.log (codes, states and verifiers are redacted by Rust). */
export function logEvent(level: LogLevel, message: string): void {
  if (inTauri) void invoke("log_event", { level, message }).catch(() => undefined)
  else console[level === "info" ? "log" : level](`[relo] ${message}`)
}

// ---- Updates ----

export interface UpdateState {
  state: "none" | "available" | "ready" | "error"
  version?: string | null
  message?: string | null
}

export interface AfterUpdate {
  version: string
  agents: "refreshed" | "failed" | "notApplicable"
}

export async function updaterConfigure(feed: string | null, autoInstall: boolean): Promise<void> {
  if (inTauri) await invoke("updater_configure", { feed, autoInstall })
}

export async function updaterCheckNow(): Promise<void> {
  if (inTauri) await invoke("updater_check_now")
}

export async function updaterInstall(): Promise<void> {
  if (inTauri) await invoke("updater_install")
}

export async function updaterAfterUpdate(): Promise<AfterUpdate | null> {
  return inTauri ? invoke<AfterUpdate | null>("updater_after_update").catch(() => null) : null
}

export function onUpdateState(cb: (state: UpdateState) => void): () => void {
  return onEvent<UpdateState>("update_state", cb)
}

// ---- Requests from the other windows ----

/**
 * The Settings window's "Sign in" (`settings_sign_in`) and the onboarding's (`onboarding_sign_in`) both carry the server
 * the owner chose; the notch signs in with it. Settings' "Sign out" is `settings_sign_out`.
 */
export function onSignInRequest(cb: (origin: string | null) => void): () => void {
  const handle = (p: { origin?: unknown } | null) => cb(typeof p?.origin === "string" && p.origin.trim() ? p.origin : null)
  const offs = [onEvent<{ origin?: unknown } | null>("settings_sign_in", handle), onEvent<{ origin?: unknown } | null>("onboarding_sign_in", handle)]
  return () => offs.forEach((off) => off())
}

export function onSignOutRequest(cb: () => void): () => void {
  return onEvent<unknown>("settings_sign_out", () => cb())
}

/** The onboarding asks for a one-time code for the relo command (cliInvite.ts); the notch owns the credential that can make one. */
export function onInviteRequest(cb: (request: InviteRequest) => void): () => void {
  return onEvent<unknown>(INVITE_REQUEST_EVENT, (p) => {
    const request = parseInviteRequest(p)
    if (request) cb(request)
  })
}

export function reportInvite(report: InviteReport): void {
  if (inTauri) void emit(INVITE_RESULT_EVENT, report).catch(() => undefined)
}

// ---- Updates the owner asked for (the tray's "Check for Updates…") ----

export async function updaterCheckManual(): Promise<UpdateState | null> {
  return inTauri ? invoke<UpdateState>("updater_check_manual").catch(() => null) : null
}

// ---- The account's encryption policy (Settings' Encryption group; the notch window owns the connection) ----

/** What the Settings page asks the notch for (`settings_encryption`). */
export type EncryptionRequest = { action: "refresh" } | { action: "set"; always: boolean } | { action: "open_security" }

/** What the notch tells Settings (`encryption_state`): the server's choice, the note's condition and the last problem. */
export interface EncryptionReport {
  /** The server's choice, or null before it was read (or when this PC has no server to ask). */
  mode: "on" | "off" | "auto" | null
  /** Whether another device of the account is a trusted iPhone (the note under "Always"). */
  phoneTrusted: boolean
  problem: string | null
  busy: boolean
}

export function onEncryptionRequest(cb: (request: EncryptionRequest) => void): () => void {
  return onEvent<EncryptionRequest>("settings_encryption", cb)
}

export function reportEncryption(report: EncryptionReport): void {
  if (inTauri) void emit("encryption_state", report).catch(() => undefined)
}
