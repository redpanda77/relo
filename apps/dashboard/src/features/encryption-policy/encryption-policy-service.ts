/** `GET/PUT /api/dashboard/end-to-end/policy`: only the signed-in owner can turn the requirement off. */
export type EncryptionMode = "auto" | "on" | "off"
export type EncryptionPolicy = { required: boolean; mode: EncryptionMode }

export const ENCRYPTION_POLICY_PATH = "/api/dashboard/end-to-end/policy"

export interface EncryptionPolicyService {
  load(): Promise<EncryptionPolicy | null>
  save(mode: EncryptionMode): Promise<EncryptionPolicy>
}

const requiredFor = { auto: null, on: true, off: false } as const

export function createHttpEncryptionPolicyService(): EncryptionPolicyService {
  return {
    async load() {
      const response = await fetch(ENCRYPTION_POLICY_PATH, { headers: { accept: "application/json" }, credentials: "same-origin" })
      if (response.status === 401 || response.status === 404) return null
      if (!response.ok) throw new Error(`Request failed (${response.status}).`)
      return (await response.json()) as EncryptionPolicy
    },
    async save(mode) {
      const response = await fetch(ENCRYPTION_POLICY_PATH, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ required: requiredFor[mode] }),
      })
      const payload = (await response.json().catch(() => null)) as (EncryptionPolicy & { error?: string }) | null
      if (!response.ok || !payload) throw new Error(payload?.error || `Request failed (${response.status}).`)
      return payload
    },
  }
}
