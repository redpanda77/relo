export type ChangePasswordInput = {
  currentPassword: string
  newPassword: string
  revokeOtherSessions: boolean
}

export type DeleteAccountInput = {
  password: string
  confirmation: string
}

export interface AccountService {
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
