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

/**
 * "pending" when the account exists but waits for the server admin's approval; "two-factor" when the
 * password was right and the account asks for a code next (docs/HARDENING.md, gap 1).
 */
export async function authenticateOwner(
  mode: "sign-in" | "sign-up",
  input: AuthInput
): Promise<"signed-in" | "pending" | "two-factor"> {
  const response = await fetch(
    mode === "sign-in"
      ? "/api/auth/sign-in/email"
      : "/api/auth/sign-up/email",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(mode === "sign-up" ? { name: input.name } : {}),
        email: input.email,
        password: input.password,
        rememberMe: true,
      }),
    }
  )
  if (response.status === 202) return "pending"
  if (response.ok) {
    const payload = (await response.json().catch(() => null)) as { twoFactorRedirect?: unknown } | null
    return payload?.twoFactorRedirect === true ? "two-factor" : "signed-in"
  }
  throw new Error(message(await response.json().catch(() => null)))
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
