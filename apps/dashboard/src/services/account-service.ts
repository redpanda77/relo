export type ChangePasswordInput = {
  currentPassword: string
  newPassword: string
  revokeOtherSessions: boolean
}

export type DeleteAccountInput = {
  password: string
  confirmation: string
}

export type RegistrationMode = "closed" | "approval" | "open"
export type ServerAccountAction = "approve" | "disable" | "enable" | "sign-out"
export type ServerAccountSummary = {
  id: string; name: string; email: string; status: "active" | "pending" | "disabled"
  admin: boolean; createdAt: string; devices: number; sessions: number
}

export interface AccountService {
  setRegistrationMode(mode: RegistrationMode): Promise<void>
  createServerAccount(input: { name: string; email: string; password: string }): Promise<{ id: string }>
  changeServerAccountAccess(id: string, action: ServerAccountAction): Promise<void>
  deleteServerAccount(id: string): Promise<void>
  loadServer(): Promise<{ registrationMode: RegistrationMode; accounts: ServerAccountSummary[] }>
  createUser(input: { name: string; email: string; password: string }): Promise<void>
  resetUserPassword(id: string, password: string): Promise<void>
  setUserEnabled(id: string, enabled: boolean): Promise<void>
  revokeUserSessions(id: string): Promise<void>
  changePassword(input: ChangePasswordInput): Promise<void>
  deleteAccount(input: DeleteAccountInput): Promise<void>
  saveLiveActivityPolicy(input: PresentationPolicy): Promise<{
    policy: PresentationPolicy
    source: PresentationPolicySource
  }>
  resetLiveActivityPolicy(): Promise<{
    policy: PresentationPolicy
    source: PresentationPolicySource
  }>
}

async function jsonMutation(
  path: string,
  body: unknown,
  method = "POST"
): Promise<unknown> {
  const response = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const payload = (await response.json().catch(() => null)) as {
    error?: string
    message?: string
  } | null
  if (!response.ok) {
    throw new Error(
      payload?.error ||
        payload?.message ||
        `Request failed (${response.status}).`
    )
  }
  return payload
}

export function createHttpAccountService(): AccountService {
  return {
    async setRegistrationMode(mode) {
      await jsonMutation("/api/dashboard/server/registration", { mode }, "PUT")
    },
    async createServerAccount(input) {
      return (await jsonMutation("/api/dashboard/server/accounts", input)) as { id: string }
    },
    async changeServerAccountAccess(id, action) {
      await jsonMutation(`/api/dashboard/server/accounts/${encodeURIComponent(id)}/${action}`, {})
    },
    async loadServer() {
      const response = await fetch("/api/dashboard/server", { headers: { accept: "application/json" } })
      if (!response.ok) throw new Error(`Request failed (${response.status}).`)
      return (await response.json()) as { registrationMode: RegistrationMode; accounts: ServerAccountSummary[] }
    },
    async deleteServerAccount(id) {
      await jsonMutation(`/api/dashboard/server/accounts/${encodeURIComponent(id)}/delete`, { confirmation: "DELETE" })
    },
    async createUser(input) { await jsonMutation("/api/dashboard/users", input) },
    async resetUserPassword(id, password) {
      await jsonMutation(`/api/dashboard/users/${encodeURIComponent(id)}/reset-password`, { password })
    },
    async setUserEnabled(id, enabled) {
      await jsonMutation(`/api/dashboard/users/${encodeURIComponent(id)}/${enabled ? "enable" : "disable"}`, {})
    },
    async revokeUserSessions(id) {
      await jsonMutation(`/api/dashboard/users/${encodeURIComponent(id)}/revoke-sessions`, {})
    },
    async changePassword(input) {
      await jsonMutation("/api/auth/change-password", input)
    },
    async deleteAccount(input) {
      await jsonMutation("/api/account/delete", input)
    },
    async saveLiveActivityPolicy(input) {
      return (await jsonMutation(
        "/api/dashboard/account/live-activity-policy",
        input,
        "PUT"
      )) as { policy: PresentationPolicy; source: PresentationPolicySource }
    },
    async resetLiveActivityPolicy() {
      return (await jsonMutation(
        "/api/dashboard/account/live-activity-policy",
        undefined,
        "DELETE"
      )) as { policy: PresentationPolicy; source: PresentationPolicySource }
    },
  }
}
import type {
  PresentationPolicy,
  PresentationPolicySource,
} from "@/features/presentation-policy/types"
