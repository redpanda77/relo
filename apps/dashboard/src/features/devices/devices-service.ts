/** Account → Security → Devices: `GET /api/dashboard/devices` and the actions on each row. */
export type DeviceStatus = "can_read" | "pending" | "simulator" | "no_keys" | "unlinked" | "encrypts"

export type DeviceRow = {
  id: string
  kind: "phone" | "computer" | "browser"
  name: string
  model: string | null
  modelId?: string | null
  osVersion?: string | null
  notificationsOff?: boolean
  status: DeviceStatus
  addedAt: string
  lastSeenAt: string | null
  approvedBy?: string | null
  linkedBy?: string | null
  identityKey?: string
  keyId?: string
}

export type DevicesView = { devices: DeviceRow[]; twoFactorEnabled: boolean }

/** What a linked browser signs to approve a phone (lib/e2ee/browser-link.ts, signApproval). */
export type SignedApproval = { browserId: string; identityKey: string; signedAt: string; signature: string }

export interface DevicesService {
  /** null when the server has no Devices route (older server) or the session ended. */
  list(): Promise<DevicesView | null>
  approve(deviceId: string, approval: SignedApproval, code?: string): Promise<void>
  remove(device: Pick<DeviceRow, "id" | "kind">): Promise<void>
}

const MESSAGES: Record<string, string> = {
  browser_not_linked: "Link this browser from your iPhone first.",
  invalid_signature: "This browser's approval was not accepted. Reload the page and try again.",
  identity_mismatch: "This phone's key changed. Reload the page and try again.",
  already_approved: "This phone is already approved.",
  device_not_found: "This device is no longer on your account.",
  two_factor_code_required: "Enter the code from your authenticator app.",
  invalid_two_factor_code: "That code did not work. Check it and try again.",
  rate_limited: "Too many attempts. Wait a few minutes and try again.",
  owner_role_required: "Only the account owner can do this.",
  not_found: "This device is no longer on your account.",
  browser_not_found: "This browser is no longer on your account.",
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  })
  const payload = (await response.json().catch(() => null)) as { error?: string; message?: string } | null
  if (!response.ok) {
    const error = Object.assign(new Error((payload?.error && MESSAGES[payload.error]) || payload?.message || `Request failed (${response.status}).`), {
      code: payload?.error,
      status: response.status,
    })
    throw error
  }
  return payload
}

export function createHttpDevicesService(): DevicesService {
  return {
    async list() {
      try {
        const payload = (await request("/api/dashboard/devices")) as Partial<DevicesView> | null
        return { devices: Array.isArray(payload?.devices) ? payload.devices : [], twoFactorEnabled: payload?.twoFactorEnabled === true }
      } catch (cause) {
        const status = (cause as { status?: number }).status
        if (status === 401 || status === 404) return null
        throw cause
      }
    },
    async approve(deviceId, approval, code) {
      await request(`/api/dashboard/devices/${encodeURIComponent(deviceId)}/approve`, {
        method: "POST",
        body: JSON.stringify(code ? { ...approval, code } : approval),
      })
    },
    async remove(device) {
      if (device.kind === "phone") await request(`/api/dashboard/devices/${encodeURIComponent(device.id)}/revoke`, { method: "POST" })
      else if (device.kind === "computer") await request(`/api/dashboard/credentials/${encodeURIComponent(device.id)}/revoke`, { method: "POST" })
      else await request(`/api/dashboard/browser/${encodeURIComponent(device.id)}`, { method: "DELETE" })
    },
  }
}
