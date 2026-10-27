// What the Relo page says about the account (ReloSettingsView.swift `account`, `accountLine`, `statusLine`,
// `accountButton`): derived from the notch's `owner_state` reports, which carry the connection state and, optionally,
// this PC's approval on the account's phone.

/** The notch's connection states (client/ownerApp.ts `OwnerState["connection"]`). */
export type Connection = "starting" | "signedOut" | "needsSignIn" | "signingIn" | "connecting" | "live" | "offline"

const CONNECTIONS: readonly Connection[] = ["starting", "signedOut", "needsSignIn", "signingIn", "connecting", "live", "offline"]

/** Where this PC stands with the account's phone: waiting to be approved there, or approved. */
export type Approval = "waiting" | "approved" | null

export interface OwnerStatus {
  connection: Connection
  approval: Approval
  /** The last problem the notch reported, in words. */
  problem: string | null
  /** When the notch last reported live or offline (epoch ms); null = unknown. */
  at: number | null
}

export const INITIAL_STATUS: OwnerStatus = { connection: "starting", approval: null, problem: null, at: null }

/**
 * `owner_state` payload: `{state}` plus, when the notch knows, `approval` ("waiting" | "approved") and `problem`.
 * A payload without a field keeps what was known; an unknown `state` is ignored.
 */
export function readOwnerPayload(raw: unknown, previous: OwnerStatus, now: number): OwnerStatus {
  const p = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {}
  const connection = CONNECTIONS.includes(p.state as Connection) ? (p.state as Connection) : previous.connection
  const approval: Approval = p.approval === "waiting" || p.approval === "approved" ? p.approval : p.approval === null ? null : previous.approval
  const problem = typeof p.problem === "string" && p.problem ? p.problem.slice(0, 300) : p.problem === null || connection !== previous.connection ? null : previous.problem
  const stamped = (connection === "live" || connection === "offline") && (connection !== previous.connection || previous.at === null)
  return { connection, approval, problem, at: stamped ? now : previous.at }
}

export const isSignedOut = (c: Connection): boolean => c === "signedOut" || c === "needsSignIn" || c === "starting"
export const isSignedIn = (c: Connection): boolean => c === "connecting" || c === "live" || c === "offline"

export function accountLine(c: Connection): string {
  switch (c) {
    case "starting":
      return "Starting"
    case "signedOut":
      return "Signed out"
    case "needsSignIn":
      return "Sign in again"
    case "signingIn":
      return "Signing in"
    case "connecting":
      return "Connecting"
    case "live":
      return "Signed in"
    case "offline":
      return "Offline"
  }
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })

export function statusLine(c: Connection, at: number | null): string {
  switch (c) {
    case "starting":
      return "Starting"
    case "signedOut":
      return "Not signed in"
    case "needsSignIn":
      return "This PC was signed out; sign in again"
    case "signingIn":
      return "Finish signing in in the browser"
    case "connecting":
      return "Connecting"
    case "live":
      return at === null ? "Live" : `Live · synced ${clock(at)}`
    case "offline":
      return at === null ? "Offline" : `Offline · as of ${clock(at)}`
  }
}

export interface AccountButton {
  label: string
  /** Which event it emits; null = shown but not pressable ("Signing in..."). */
  action: "signIn" | "signOut" | null
}

export function accountButton(c: Connection): AccountButton {
  if (c === "signingIn") return { label: "Signing in…", action: null }
  if (isSignedIn(c)) return { label: "Sign out", action: "signOut" }
  return { label: c === "needsSignIn" ? "Sign in again" : "Sign in", action: "signIn" }
}

/** The server as the Mac shows it (`ReloNotchStore.displayAddress`): host, with the port only when it is not the scheme's default. */
export function displayAddress(origin: string | null): string {
  if (!origin) return "Not set"
  try {
    const u = new URL(origin)
    return u.port ? `${u.hostname}:${u.port}` : u.hostname
  } catch {
    return origin
  }
}

/** The line under "Check for Updates" once a check ended. */
export function updateCheckLine(r: { state: "off" | "none" | "available" | "ready" | "error"; version?: string | null; message?: string | null }): string {
  switch (r.state) {
    case "off":
      return "This build does not take updates."
    case "none":
      return "Relo for Windows is up to date."
    case "available":
      return r.version ? `Version ${r.version} is available.` : "An update is available."
    case "ready":
      return r.version ? `Version ${r.version} is ready to install.` : "An update is ready to install."
    case "error":
      return r.message ? `Relo could not check for updates: ${r.message}` : "Relo could not check for updates."
  }
}

/** The encryption line under the policy: this PC's approval on the iPhone. */
export function approvalLine(a: Approval): string | null {
  if (a === "waiting") return "Approve this PC on your iPhone"
  if (a === "approved") return "This PC is approved on your iPhone"
  return null
}
