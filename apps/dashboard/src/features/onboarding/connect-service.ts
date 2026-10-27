import type { ComputerInvite as MadeComputerInvite, ComputerInviteStatus } from "@relo/notification-contracts"

import { b64u, fromB64u } from "@relo/owner-crypto"

/** The one-time code made for the wizard (`POST /api/dashboard/computer-invites`): the code and one command per shell family. */
export type ComputerInvite = MadeComputerInvite

/** Which shell the new computer runs: `posix` (macOS, Linux) pipes install.sh into sh, `windows` runs install.ps1 in PowerShell. */
export type ShellFamily = keyof MadeComputerInvite["commands"]

export type InviteOptions = { level: string; approvals?: boolean; agents?: string[]; desktopApp?: boolean }

/** The shell this browser's own computer most likely runs, as the picker's first guess. */
export function guessShell(): ShellFamily {
  try { return /^win/i.test(navigator.platform) ? "windows" : "posix" } catch { return "posix" }
}

/** The harnesses a code can set up, in the order the wizard lists them. */
export const SETUP_AGENTS = ["claude-code", "codex", "opencode", "gemini", "cursor", "copilot", "amp"] as const

/** What the Connect a computer wizard needs from the server; tests pass a fake. */
export interface ConnectService {
  invite(options: InviteOptions): Promise<ComputerInvite>
  /** null when the server no longer knows the invite (404). */
  status(inviteId: string): Promise<ComputerInviteStatus | null>
  /** Whether an iPhone is paired (`GET /api/dashboard/setup`); null when unknown. */
  hasPhone(): Promise<boolean | null>
  /** Whether the account has a computer yet; null when unknown. */
  hasComputer(): Promise<boolean | null>
}

async function json(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) },
  })
}

async function setup(): Promise<{ phone?: boolean; computer?: boolean } | null> {
  const response = await json("/api/dashboard/setup")
  return response.ok ? ((await response.json()) as { phone?: boolean; computer?: boolean }) : null
}

export function createHttpConnectService(): ConnectService {
  return {
    async invite(options) {
      const response = await json("/api/dashboard/computer-invites", { method: "POST", body: JSON.stringify(options) })
      const payload = (await response.json().catch(() => null)) as (ComputerInvite & { message?: string }) | null
      if (!response.ok || !payload) throw new Error(payload?.message || `The command could not be made (${response.status}).`)
      return payload
    },
    async status(inviteId) {
      const response = await json(`/api/dashboard/computer-invites/${encodeURIComponent(inviteId)}`)
      if (response.status === 404) return null
      if (!response.ok) throw new Error(`Status failed (${response.status}).`)
      return (await response.json()) as ComputerInviteStatus
    },
    async hasPhone() {
      return (await setup())?.phone ?? null
    },
    async hasComputer() {
      return (await setup())?.computer ?? null
    },
  }
}

/** Where signup sends the owner: the Now page, which opens the wizard (`?connect=computer`). */
export const CONNECT_AFTER_SIGNUP_PATH = "/dashboard?connect=computer"

const LAST_INVITE_KEY = "relo.connect.lastInvite"

/** The last code the wizard made, so Settings can offer Resume. Browser storage may be blocked: never throws. */
export function rememberInvite(inviteId: string | null) {
  if (!inviteId) madeInMemory = null
  try {
    if (inviteId) localStorage.setItem(LAST_INVITE_KEY, inviteId)
    else localStorage.removeItem(LAST_INVITE_KEY)
  } catch { /* only this tab forgets */ }
}

export function lastInvite(): string | null {
  try { return localStorage.getItem(LAST_INVITE_KEY) } catch { return null }
}

/**
 * The last code the wizard made, with its binding half, kept in this tab's memory only (never storage): closing the
 * wizard and resuming reopens on the same command. A reload loses it; then only the id in storage remains.
 */
export type MadeInvite = {
  invite: ComputerInvite
  prompt: string
  bind: string
  way: "command" | "agent"
  level: string
  approvals: boolean
  agents: string[] | null
  desktopApp?: boolean
}

let madeInMemory: MadeInvite | null = null

export function rememberMade(made: MadeInvite | null) {
  madeInMemory = made
}

/** The in-memory command for this invite, when this tab made it. */
export function madeInvite(inviteId: string | null): MadeInvite | null {
  return inviteId && madeInMemory?.invite.inviteId === inviteId ? madeInMemory : null
}

/** While waiting, the status is read this often even without a hint from the live stream. */
export const STATUS_POLL_MS = 5_000
/** An agent that has not used the code by now probably stalled: offer the command. */
export const AGENT_STALL_MS = 120_000

export function agentPrompt(origin: string, code: string, level: string, desktopApp = false) {
  return `Read ${origin}/install.md?code=${code}${desktopApp ? "&app=1" : ""} and set up Relo on this computer at the ${level} level. It sends me a first notification when it is done.`
}

/** The binding half of a code: 16 random bytes, b64url (22 chars). It lives in the wizard's memory only. */
export function newBind(): string {
  return b64u(crypto.getRandomValues(new Uint8Array(16)))
}

/** The code and command as the owner copies them: `rci_<redeem>.<bind>`. The server only ever saw `<redeem>`. */
export function withBind(invite: ComputerInvite, bind: string): ComputerInvite {
  const code = `${invite.code}.${bind}`
  const bound = (command: string) => command.split(invite.code).join(code)
  return { ...invite, code, command: bound(invite.command), commands: { posix: bound(invite.commands.posix), windows: bound(invite.commands.windows) } }
}

/**
 * Checks the computer's published binding: HMAC-SHA256 keyed by `bind` over
 * "relo.e2e.v1 computer-binding\n" + clientId + "\n" + identityKey, b64url (docs/ENCRYPTION-PROTOCOL.md, "Key binding").
 */
export async function bindingMatches(bind: string, clientId: string, identityKey: string, binding: string): Promise<boolean> {
  let raw: Uint8Array
  try { raw = fromB64u(bind) } catch { return false }
  const key = await crypto.subtle.importKey("raw", new Uint8Array(raw), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`relo.e2e.v1 computer-binding\n${clientId}\n${identityKey}`))
  return b64u(new Uint8Array(mac)) === binding
}
