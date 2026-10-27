// The relo command after a server sign-in (see src-tauri/src/cli_setup.rs): Rust makes sure the command exists and is on the
// Path, the signed-in app mints a one-time code, and Rust signs the CLI in with it. Pure orchestration over injected
// calls, so the order and the words are tested without Tauri.
import type { InviteReport } from "../../client/cliInvite"

/** What `cli_prepare` answers (cli_setup.rs `Prepared`). */
export interface Prepared {
  launcher: "written" | "otherInstalled"
  note: string | null
  pathReady: boolean
  /** The CLI is already signed in to this server: no code is needed. */
  signedIn: boolean
}

export interface ProvisionDeps {
  prepare: (origin: string) => Promise<Prepared>
  /** Asks the signed-in app for a one-time code; rejects with the owner's words. */
  invite: (origin: string) => Promise<string>
  join: (origin: string, code: string) => Promise<void>
}

export type Provision = { ok: true; note: string | null } | { ok: false; message: string }

export const PROVISION_FAILED = "Relo could not set up the relo command on this PC. Try again."

/** The owner's words from a rejection: Rust and the notch reject with plain strings, anything else gets the general line. */
export function wordsOf(error: unknown): string {
  return typeof error === "string" && error.trim() !== "" ? error : PROVISION_FAILED
}

/**
 * Makes the relo command work for the server the app is signed in to: the launcher and Path first (the agents' hooks call
 * `relo`), then the CLI's own sign-in unless it already is signed in to this server.
 */
export async function provisionCli(origin: string, deps: ProvisionDeps): Promise<Provision> {
  let prepared: Prepared
  try {
    prepared = await deps.prepare(origin)
  } catch (error) {
    return { ok: false, message: wordsOf(error) }
  }
  if (!prepared.signedIn) {
    try {
      const code = await deps.invite(origin)
      await deps.join(origin, code)
    } catch (error) {
      return { ok: false, message: wordsOf(error) }
    }
  }
  return { ok: true, note: prepared.note }
}

export const INVITE_TIMEOUT_MS = 30_000
export const INVITE_UNANSWERED = "Relo did not hear back from its connection to your server. Try again."

export interface InviteIo {
  emit: (name: string, payload: unknown) => void
  listen: (name: string, cb: (payload: unknown) => void) => () => void
  newId: () => string
}

/** Sends the request to the notch and waits for the answer with the same id (listening first, so no answer is missed). */
export function requestInvite(origin: string, io: InviteIo, requestEvent: string, resultEvent: string, timeoutMs = INVITE_TIMEOUT_MS): Promise<string> {
  const id = io.newId()
  return new Promise<string>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = io.listen(resultEvent, (raw) => {
      const report = raw as Partial<InviteReport> | null
      if (!report || report.id !== id) return
      clearTimeout(timer)
      off()
      if (typeof report.code === "string" && report.code !== "") resolve(report.code)
      else reject(typeof report.problem === "string" ? report.problem : INVITE_UNANSWERED)
    })
    timer = setTimeout(() => {
      off()
      reject(INVITE_UNANSWERED)
    }, timeoutMs)
    io.emit(requestEvent, { id, origin })
  })
}
