import {
  CI_TOKEN_MAX_DAYS,
  LOGIN_SCOPES,
  type ConnectionClient,
  type LoginScope,
} from "@/features/connections/types"
import type { NeonTone } from "@/lib/status-tone"

/** A CI token as its row shows it. */
export type CiToken = {
  id: string
  name: string
  prefix: string
  scopes: string[]
  createdAt: string | null
  expiresAt: string
  lastUsedAt: string | null
}

/** The Connections payload's CI tokens (clients of kind "ci-token"), as rows. */
export function ciTokensFrom(clients: ConnectionClient[]): CiToken[] {
  return clients.flatMap((client) =>
    client.kind === "ci-token" && client.expiresAt
      ? [{
          id: client.id,
          name: client.label,
          prefix: client.prefix,
          scopes: client.scopes,
          createdAt: client.createdAt,
          expiresAt: client.expiresAt,
          lastUsedAt: client.lastUsedAt,
        }]
      : []
  )
}

/** The login scopes in the owner's words (the scope registry's meanings, shortened). */
export const LOGIN_SCOPE_COPY: Record<LoginScope, { label: string; detail: string }> = {
  "notifications:send": { label: "Send notices", detail: "Notices to your phones." },
  "interactions:create": { label: "Ask questions", detail: "Questions and approvals." },
  "interactions:read": { label: "Read answers", detail: "Read and wait on the answers to its questions." },
  "activities:write": { label: "Report work", detail: "Start, update and finish works and their cards." },
  "activities:read": { label: "Read work", detail: "Works, Now and the sessions list." },
  "devices:read": { label: "List phones", detail: "Your phones and delivery evidence." },
  "services:read": { label: "List webhooks", detail: "Webhook services and computer credentials." },
  "services:write": { label: "Manage webhooks", detail: "Create, rotate and revoke webhook services and computer credentials." },
}

function scopeLabel(scope: string): string {
  return (LOGIN_SCOPE_COPY as Record<string, { label: string } | undefined>)[scope]?.label ?? scope
}

/** What a token may do in a few words: everything, or its first two permissions and how many more. */
export function compactScopes(scopes: string[]): string {
  if (!scopes.length) return "Nothing"
  if (LOGIN_SCOPES.every((scope) => scopes.includes(scope))) return "Every permission"
  const ordered = [...LOGIN_SCOPES.filter((scope) => scopes.includes(scope)), ...scopes.filter((scope) => !(LOGIN_SCOPES as string[]).includes(scope))]
  const named = ordered.slice(0, 2).map(scopeLabel).join(", ")
  return ordered.length > 2 ? `${named} +${ordered.length - 2}` : named
}

const DAY_MS = 86_400_000
/** A token this close to its end is worth the owner's attention. */
const SOON_DAYS = 7

/** "Expires in 12 days" (attention within a week), or "Expired". */
export function expiry(expiresAt: string, now = Date.now()): { text: string; tone: NeonTone } {
  const left = new Date(expiresAt).valueOf() - now
  if (!Number.isFinite(left) || left <= 0) return { text: "Expired", tone: "neutral" }
  const days = Math.ceil(left / DAY_MS)
  return {
    text: `Expires in ${days} day${days === 1 ? "" : "s"}`,
    tone: days <= SOON_DAYS ? "yellow" : "neutral",
  }
}

/** Server refusals arrive as codes; the owner reads words. */
export function ciTokenError(cause: unknown): string {
  const code = cause instanceof Error ? cause.message : ""
  switch (code) {
    case "name_taken":
      return "A computer or CI token already has this name. Choose another."
    case "limit_reached":
      return "You already have the most CI tokens an account may hold. Revoke one you no longer use first."
    case "scope_not_held":
      return "A CI token can hold only permissions your login holds. Clear the ones it lacks."
    case "expiry_too_long":
      return `A CI token lives at most ${CI_TOKEN_MAX_DAYS} days. Choose a shorter lifetime.`
    default:
      return "Relo could not make the CI token. Check your connection and try again."
  }
}
