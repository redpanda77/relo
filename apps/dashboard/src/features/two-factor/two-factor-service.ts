/** Two-step sign-in for the signed-in account (docs/HARDENING.md, gap 1), via `/api/auth/two-factor/*`. */
export type TwoFactorSetup = { totpURI: string; backupCodes: string[] }

export interface TwoFactorService {
  /** Whether the account has it on; null when the server does not offer it. */
  status(): Promise<boolean | null>
  begin(password: string): Promise<TwoFactorSetup>
  confirm(code: string): Promise<void>
  disable(password: string): Promise<void>
  newBackupCodes(password: string): Promise<string[]>
}

async function post(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  })
  const payload = (await response.json().catch(() => null)) as { message?: string; error?: string; code?: string } | null
  if (!response.ok) {
    if (payload?.code === "INVALID_PASSWORD" || payload?.code === "INVALID_EMAIL_OR_PASSWORD") throw new Error("That password is not right.")
    if (payload?.code === "INVALID_CODE" || payload?.code === "INVALID_BACKUP_CODE") throw new Error("That code did not work. Check it and try again.")
    throw new Error(payload?.message || payload?.error || `Request failed (${response.status}).`)
  }
  return payload
}

export function createHttpTwoFactorService(): TwoFactorService {
  return {
    async status() {
      const response = await fetch("/api/auth/get-session", { headers: { accept: "application/json" }, credentials: "same-origin" })
      if (!response.ok) return null
      const payload = (await response.json().catch(() => null)) as { user?: { twoFactorEnabled?: unknown } } | null
      const enabled = payload?.user?.twoFactorEnabled
      return typeof enabled === "boolean" ? enabled : null
    },
    async begin(password) {
      return (await post("/api/auth/two-factor/enable", { password })) as TwoFactorSetup
    },
    async confirm(code) {
      await post("/api/auth/two-factor/verify-totp", { code: code.replaceAll(/\s+/g, "") })
    },
    async disable(password) {
      await post("/api/auth/two-factor/disable", { password })
    },
    async newBackupCodes(password) {
      return ((await post("/api/auth/two-factor/generate-backup-codes", { password })) as { backupCodes: string[] }).backupCodes
    },
  }
}
