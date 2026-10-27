// The one-time code the relo command signs in with. The notch window owns the account's credential, so the onboarding
// (the Settings window) asks it for a code over two events and hands the answer straight to Rust (`cli_join`, cli_setup.rs).
// The Mac never needs this: its app joins its own server in Rust (LocalServer.swift `join`), and a Mac signed in to a
// remote server got its CLI from install.sh. The code is a bearer secret for one sign-in: it is never logged or kept.
import { OwnerClientError } from "@relo/owner-client"

/** Settings -> notch: `{ id, origin }`. */
export const INVITE_REQUEST_EVENT = "cli_invite_request"
/** Notch -> Settings: `{ id, code }` or `{ id, problem }`. */
export const INVITE_RESULT_EVENT = "cli_invite_result"

export interface InviteRequest {
  id: string
  origin: string
}

export type InviteReport = { id: string; code: string; problem?: undefined } | { id: string; problem: string; code?: undefined }

/** Why a code could not be made, in the owner's words (no status codes, no server errors). */
export function inviteProblem(error: unknown): string {
  if (error instanceof OwnerClientError) {
    switch (error.kind) {
      case "unauthorized":
        return "Relo could not ask your server for a one-time code. Sign in again, then try again."
      case "rate_limited":
        return "Your server asked Relo to wait a moment. Try again in a minute."
      case "unreachable":
        return "Relo could not reach your server. Check your connection and try again."
    }
  }
  return "Your server did not give Relo a one-time code. Try again."
}

/** A request that arrived over the event: both fields are checked, nothing else is read. */
export function parseInviteRequest(raw: unknown): InviteRequest | null {
  const p = raw as { id?: unknown; origin?: unknown } | null
  return typeof p?.id === "string" && p.id !== "" && p.id.length <= 64 && typeof p.origin === "string" ? { id: p.id, origin: p.origin } : null
}
