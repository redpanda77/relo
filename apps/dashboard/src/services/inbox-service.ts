export type InboxSnapshot = {
  revision: number
  counts: {
    notifications: number
    deliveries: number
    approvals: number
    devices: number
  }
  devices: Array<{ id: string; lastSeenAt: string | null }>
  clients: Array<{ id: string; lastUsedAt: string | null }>
}

export interface InboxService {
  decideApproval(code: string, decision: "approve" | "deny"): Promise<void>
  reactivateActivity?(activityId: string): Promise<void>
  markNotificationRead?(notificationId: string): Promise<void>
  markAllNotificationsRead?(): Promise<void>
  withdrawNotification?(notificationId: string): Promise<void>
  reconcileDelivery?(
    deliveryId: string,
    action: "mark_accepted" | "retry" | "cancel"
  ): Promise<{ state: string; replayed: boolean }>
  getSnapshot(signal?: AbortSignal): Promise<InboxSnapshot>
}

async function jsonRequest<Result>(
  path: string,
  init?: RequestInit
): Promise<Result> {
  const response = await fetch(path, init)
  const payload = (await response.json().catch(() => null)) as
    Result | { error?: string; message?: string } | null
  if (!response.ok) {
    const detail =
      payload && typeof payload === "object"
        ? ("error" in payload && payload.error) ||
          ("message" in payload && payload.message)
        : null
    throw new Error(detail || `Request failed (${response.status}).`)
  }
  return payload as Result
}

export function createHttpInboxService(): InboxService {
  return {
    async decideApproval(code, decision) {
      await jsonRequest(
        `/api/device-authorizations/requests/${encodeURIComponent(code)}/${decision}`,
        {
          method: "POST",
        }
      )
    },
    async reactivateActivity(activityId) {
      await jsonRequest(
        `/api/dashboard/live-activities/${encodeURIComponent(activityId)}/reactivate`,
        { method: "POST" }
      )
    },
    async markNotificationRead(notificationId) {
      await jsonRequest(
        `/api/dashboard/notifications/${encodeURIComponent(notificationId)}/read`,
        { method: "POST" }
      )
    },
    async markAllNotificationsRead() {
      await jsonRequest("/api/dashboard/inbox/read", { method: "POST" })
    },
    async withdrawNotification(notificationId) {
      await jsonRequest(
        `/api/account/notifications/${encodeURIComponent(notificationId)}/withdraw`,
        { method: "POST" }
      )
    },
    reconcileDelivery(deliveryId, action) {
      return jsonRequest(
        `/api/dashboard/deliveries/${encodeURIComponent(deliveryId)}/reconcile`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        }
      )
    },
    getSnapshot(signal) {
      return jsonRequest<InboxSnapshot>("/api/dashboard/snapshot", { signal })
    },
  }
}
