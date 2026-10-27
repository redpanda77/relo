type AuthInput = {
  name?: string
  email: string
  password: string
}

function message(value: unknown): string {
  if (!value || typeof value !== "object") return "Authentication failed."
  const payload = value as Record<string, unknown>
  if (typeof payload.message === "string") return payload.message
  if (typeof payload.error === "string")
    return payload.error.replaceAll("_", " ")
  return "Authentication failed."
}

/** Where an app's browser sign-in goes back to; the only address the Dashboard ever sends the browser to from here. */
export const MOBILE_CALLBACK_PREFIX = "relo://auth/callback?"

/**
 * The query of the /mobile/sign-in link this page was opened for (its `next` path), or null. The server checks it again:
 * it is only a hint so the server can hand the app a pending ticket when the account waits for approval.
 */
export function mobileSignInHint(nextPath: string): string | null {
  return nextPath.startsWith("/mobile/sign-in?") ? nextPath.slice("/mobile/sign-in?".length) : null
}

function appCallback(value: unknown): string | null {
  return typeof value === "string" && value.startsWith(MOBILE_CALLBACK_PREFIX) && !/[\s\\]/.test(value) ? value : null
}

/** The outcome of waiting for approval inside an app's sign-in: the page the browser returns to the app with. */
export type PendingOutcome = { pending: true; redirect: string | null }

/**
 * "pending" when the account exists but waits for the server admin's approval; "two-factor" when the
 * password was right and the account asks for a code next (docs/HARDENING.md, gap 1).
 */
export async function authenticateOwner(
  mode: "sign-in" | "sign-up",
  input: AuthInput,
  mobileSignIn: string | null = null
): Promise<"signed-in" | "two-factor" | PendingOutcome> {
  const response = await fetch(
    mode === "sign-in"
      ? "/api/auth/sign-in/email"
      : "/api/auth/sign-up/email",
    {
      method: "POST",
      headers: { "content-type": "application/json", ...(mobileSignIn ? { "x-relo-mobile-sign-in": mobileSignIn } : {}) },
      body: JSON.stringify({
        ...(mode === "sign-up" ? { name: input.name } : {}),
        email: input.email,
        password: input.password,
        rememberMe: true,
      }),
    }
  )
  if (response.status === 202) {
    const payload = (await response.json().catch(() => null)) as { redirect?: unknown } | null
    return { pending: true, redirect: appCallback(payload?.redirect) }
  }
  if (response.ok) {
    const payload = (await response.json().catch(() => null)) as { twoFactorRedirect?: unknown } | null
    return payload?.twoFactorRedirect === true ? "two-factor" : "signed-in"
  }
  const failure = await response.json().catch(() => null)
  // Signing in to an account that still waits for approval, from an app: the server answers with the app's ticket.
  const redirect = appCallback((failure as { redirect?: unknown } | null)?.redirect)
  if (response.status === 403 && redirect && (failure as { error?: unknown }).error === "approval_pending") return { pending: true, redirect }
  throw new Error(message(failure))
}

/** The second step: a code from the authenticator app, or one of the backup codes. */
export async function verifySecondStep(input: {
  code: string
  method: "totp" | "backup"
  trustDevice: boolean
}): Promise<void> {
  const response = await fetch(
    input.method === "totp" ? "/api/auth/two-factor/verify-totp" : "/api/auth/two-factor/verify-backup-code",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: input.code.replaceAll(/\s+/g, ""), trustDevice: input.trustDevice }),
    }
  )
  if (response.ok) return
  const payload = await response.json().catch(() => null)
  if (response.status === 401) throw new Error("That code did not work. Check it and try again.")
  throw new Error(message(payload))
}

/** Where "Continue with Apple" sends the browser; the server returns it to `nextPath` signed in. */
export function appleSignInUrl(nextPath: string): string {
  return `/api/auth/apple/start?next=${encodeURIComponent(nextPath)}`
}

/** Why the server sent the browser back from Sign in with Apple (`?apple=` on the sign-in page), in words, or "". */
export function appleSignInError(search: string): string {
  const reason = new URLSearchParams(search).get("apple")
  if (!reason) return ""
  switch (reason) {
    case "registration_closed": return "This server isn't taking new accounts. Ask its admin to create one for you."
    case "approval_pending": return "Your account is waiting for the server admin's approval."
    case "account_disabled": return "The server admin has turned off access for this account."
    case "account_exists": return "This email already has a Relo account. Sign in with its password."
    case "owner_not_bootstrapped": return "This server isn't ready for its first account yet."
    case "expired": return "That Apple sign-in took too long. Try again."
    default: return "Couldn't sign in with Apple. Try again."
  }
}
