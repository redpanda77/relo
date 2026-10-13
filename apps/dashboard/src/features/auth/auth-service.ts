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

/** "pending" when the account exists but waits for the server admin's approval. */
export async function authenticateOwner(
  mode: "sign-in" | "sign-up",
  input: AuthInput
): Promise<"signed-in" | "pending"> {
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
  if (response.ok) return "signed-in"
  throw new Error(message(await response.json().catch(() => null)))
}
